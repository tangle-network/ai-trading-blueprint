use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::http::{StatusCode, header::CONTENT_TYPE};
use axum::response::{
    IntoResponse, Response,
    sse::{Event, KeepAlive, Sse},
};
use serde_json::Value;
use serde_json::json;
use tokio::time::sleep;

static CHAT_TRANSCRIPTS: LazyLock<Mutex<HashMap<String, Vec<Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const DEFAULT_CHAT_AGENT_RUN_TIMEOUT_MS: u64 = 1_800_000;

#[derive(Clone, Debug)]
pub struct SidecarChatTarget {
    pub sandbox_id: String,
    pub sidecar_url: String,
    pub sidecar_token: String,
}

#[derive(Clone, Debug)]
pub struct AgenticChatTurnOptions {
    pub session_id: String,
    pub message: String,
    pub user_metadata: Value,
    pub assistant_metadata: Value,
    pub timeout_ms: u64,
    pub surface: String,
    pub operation: String,
    pub bot_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AgenticChatTurnResult {
    pub session_id: String,
    pub assistant_text: String,
    pub status: u16,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cost_usd: Option<f64>,
    pub trace_id: Option<String>,
    pub usage_event: Value,
    pub payload: Value,
    pub messages: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatSessionScope {
    ManualOnly,
    All,
}

pub fn resolve_sidecar_chat_target(sandbox_id: &str) -> Result<SidecarChatTarget, String> {
    let record = sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id)
        .map_err(|e| format!("Sandbox not found: {e}"))?;
    Ok(SidecarChatTarget {
        sandbox_id: record.id.clone(),
        sidecar_url: record.sidecar_url,
        sidecar_token: record.token,
    })
}

pub fn is_autonomous_chat_session(bot_id: &str, session_id: &str) -> bool {
    ["trading", "fast", "research", "convo"]
        .into_iter()
        .map(|prefix| format!("{prefix}-{bot_id}"))
        .any(|workflow_prefix| {
            session_id == workflow_prefix || session_id.starts_with(&format!("{workflow_prefix}-"))
        })
}

pub fn ensure_manual_chat_session(
    bot_id: &str,
    session_id: &str,
) -> Result<(), (StatusCode, String)> {
    if is_autonomous_chat_session(bot_id, session_id) {
        return Err((StatusCode::NOT_FOUND, "Session not found".to_string()));
    }
    Ok(())
}

fn chat_session_type(bot_id: &str, session_id: &str) -> &'static str {
    if is_autonomous_chat_session(bot_id, session_id) {
        "autonomous"
    } else {
        "manual"
    }
}

async fn send_chat_request(
    target: &SidecarChatTarget,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    query: Option<&str>,
) -> Result<reqwest::Response, (StatusCode, String)> {
    let client = reqwest::Client::new();
    match send_chat_request_once(&client, target, method.clone(), path, body.clone(), query).await {
        Ok(response) => Ok(response),
        Err(initial_error) => {
            if let Some(recovered_target) = recover_chat_target(target).await {
                return send_chat_request_once(
                    &client,
                    &recovered_target,
                    method,
                    path,
                    body,
                    query,
                )
                .await
                .inspect_err(|retry_error| {
                    tracing::warn!(
                        sandbox_id = %target.sandbox_id,
                        initial = %initial_error.1,
                        retry = %retry_error.1,
                        "chat sidecar retry failed after recovery attempt"
                    );
                });
            }
            Err(initial_error)
        }
    }
}

async fn send_chat_request_once(
    client: &reqwest::Client,
    target: &SidecarChatTarget,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    query: Option<&str>,
) -> Result<reqwest::Response, (StatusCode, String)> {
    let base = target.sidecar_url.trim_end_matches('/');
    let path = if path.starts_with('/') {
        path
    } else {
        &format!("/{path}")
    };
    let mut url = format!("{base}{path}");
    if let Some(q) = query
        && !q.is_empty()
    {
        url.push('?');
        url.push_str(q);
    }

    let mut req = client.request(method, &url);
    if !target.sidecar_token.is_empty() {
        req = req.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", target.sidecar_token),
        );
    }
    if let Some(ref json) = body {
        req = req.json(&json);
    }

    let timeout = request_timeout(path, body.as_ref());
    req.timeout(timeout)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Sidecar unreachable: {e}")))
}

fn request_timeout(path: &str, body: Option<&Value>) -> Duration {
    let requested_ms = body
        .and_then(|value| {
            value
                .get("timeout")
                .or_else(|| value.get("timeout_ms"))
                .and_then(Value::as_u64)
        })
        .filter(|value| *value > 0);
    if path == "/agents/run" {
        return Duration::from_millis(
            requested_ms.unwrap_or_else(default_chat_agent_run_timeout_ms),
        );
    }
    requested_ms
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(30))
}

async fn recover_chat_target(target: &SidecarChatTarget) -> Option<SidecarChatTarget> {
    let current = sandbox_runtime::runtime::get_sandbox_by_id(&target.sandbox_id).ok()?;
    if current.sidecar_url != target.sidecar_url {
        let refreshed = SidecarChatTarget {
            sandbox_id: current.id.clone(),
            sidecar_url: current.sidecar_url.clone(),
            sidecar_token: current.token.clone(),
        };
        wait_for_sidecar_health(&refreshed.sidecar_url, &refreshed.sidecar_token, 5).await;
        return Some(refreshed);
    }

    if let Err(error) = sandbox_runtime::runtime::resume_sidecar(&current).await {
        tracing::warn!(
            sandbox_id = %target.sandbox_id,
            sidecar_url = %target.sidecar_url,
            "failed to resume sidecar during chat recovery: {error}"
        );
    }

    let refreshed = sandbox_runtime::runtime::get_sandbox_by_id(&target.sandbox_id).ok()?;
    let next = SidecarChatTarget {
        sandbox_id: refreshed.id.clone(),
        sidecar_url: refreshed.sidecar_url.clone(),
        sidecar_token: refreshed.token.clone(),
    };
    wait_for_sidecar_health(&next.sidecar_url, &next.sidecar_token, 10).await;
    Some(next)
}

async fn wait_for_sidecar_health(sidecar_url: &str, sidecar_token: &str, attempts: usize) {
    if attempts == 0 {
        return;
    }

    let client = reqwest::Client::new();
    let Ok(url) = sandbox_runtime::http::build_url(sidecar_url, "/health") else {
        return;
    };
    let Ok(headers) = sandbox_runtime::http::auth_headers(sidecar_token) else {
        return;
    };

    for attempt in 0..attempts {
        let is_healthy = client
            .get(url.clone())
            .headers(headers.clone())
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());

        if is_healthy {
            return;
        }

        if attempt + 1 < attempts {
            sleep(Duration::from_millis(350)).await;
        }
    }
}

pub async fn proxy_chat_request(
    target: &SidecarChatTarget,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    _query: Option<&str>,
) -> Result<Response, (StatusCode, String)> {
    run_backed_chat_response(target, method, path, body).await
}

pub async fn list_chat_sessions(
    target: &SidecarChatTarget,
    bot_id: &str,
    scope: ChatSessionScope,
) -> Result<Response, (StatusCode, String)> {
    Ok(json_response(
        StatusCode::OK,
        Value::Array(run_backed_session_entries(target, bot_id, scope)),
    ))
}

pub async fn list_chat_session_ids(
    target: &SidecarChatTarget,
) -> Result<Vec<String>, (StatusCode, String)> {
    Ok(
        run_backed_session_entries(target, "", ChatSessionScope::All)
            .into_iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
            .collect(),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    (status, [(CONTENT_TYPE, "application/json")], bytes).into_response()
}

fn transcript_key(sandbox_id: &str, session_id: &str) -> String {
    format!("{sandbox_id}::{session_id}")
}

fn default_manual_session_id(sandbox_id: &str) -> String {
    let suffix: String = sandbox_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    format!("manual-{suffix}")
}

fn run_backed_session_entries(
    target: &SidecarChatTarget,
    bot_id: &str,
    scope: ChatSessionScope,
) -> Vec<Value> {
    let mut session_ids = vec![default_manual_session_id(&target.sandbox_id)];
    if let Ok(store) = CHAT_TRANSCRIPTS.lock() {
        let prefix = format!("{}::", target.sandbox_id);
        session_ids.extend(
            store
                .keys()
                .filter_map(|key| key.strip_prefix(&prefix).map(str::to_string)),
        );
    }
    session_ids.sort();
    session_ids.dedup();
    session_ids
        .into_iter()
        .filter(|session_id| {
            scope == ChatSessionScope::All || !is_autonomous_chat_session(bot_id, session_id)
        })
        .map(|session_id| {
            json!({
                "id": session_id,
                "title": "New Chat",
                "session_type": chat_session_type(bot_id, &session_id),
                "transport": "agents/run"
            })
        })
        .collect()
}

async fn run_backed_chat_response(
    target: &SidecarChatTarget,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Response, (StatusCode, String)> {
    if method == reqwest::Method::POST && path == "/agents/sessions" {
        let session_id = body
            .as_ref()
            .and_then(|value| value.get("id").or_else(|| value.get("session_id")))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| default_manual_session_id(&target.sandbox_id));
        return Ok(json_response(
            StatusCode::OK,
            json!({ "id": session_id, "title": "New Chat", "transport": "agents/run" }),
        ));
    }

    let Some((session_id, suffix)) = parse_session_path(path) else {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            json!({ "success": false, "error": { "code": "NOT_FOUND", "message": "Unknown chat endpoint" } }),
        ));
    };

    if suffix.is_empty() && method == reqwest::Method::GET {
        return Ok(json_response(
            StatusCode::OK,
            json!({ "id": session_id, "title": "New Chat", "transport": "agents/run" }),
        ));
    }
    if suffix.is_empty() && method == reqwest::Method::PATCH {
        return Ok(json_response(
            StatusCode::OK,
            json!({ "id": session_id, "title": body.and_then(|v| v.get("title").cloned()).unwrap_or(Value::String("New Chat".to_string())) }),
        ));
    }
    if suffix.is_empty() && method == reqwest::Method::DELETE {
        if let Ok(mut store) = CHAT_TRANSCRIPTS.lock() {
            store.remove(&transcript_key(&target.sandbox_id, &session_id));
        }
        return Ok(json_response(StatusCode::OK, json!({ "ok": true })));
    }
    if suffix == "abort" && method == reqwest::Method::POST {
        return Ok(json_response(StatusCode::OK, json!({ "ok": true })));
    }
    if suffix != "messages" {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            json!({ "success": false, "error": { "code": "NOT_FOUND", "message": "Unknown chat endpoint" } }),
        ));
    }

    if method == reqwest::Method::GET {
        let messages = CHAT_TRANSCRIPTS
            .lock()
            .ok()
            .and_then(|store| {
                store
                    .get(&transcript_key(&target.sandbox_id, &session_id))
                    .cloned()
            })
            .unwrap_or_default();
        return Ok(json_response(StatusCode::OK, Value::Array(messages)));
    }

    if method != reqwest::Method::POST {
        return Ok(json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "method not allowed" }),
        ));
    }

    let user_body = body.unwrap_or_else(|| json!({}));
    let message = extract_message_text(&user_body);
    append_transcript_message(
        target,
        &session_id,
        "user",
        message.clone(),
        json!({ "transport": "operator-chat", "source": "owner" }),
    );

    let run_target = target.clone();
    let run_session_id = session_id.clone();
    tokio::spawn(async move {
        run_agent_turn(run_target, run_session_id, message).await;
    });
    Ok(json_response(
        StatusCode::OK,
        json!({
            "ok": true,
            "sessionId": session_id,
            "transport": "agents/run",
            "status": "accepted"
        }),
    ))
}

async fn run_agent_turn(target: SidecarChatTarget, session_id: String, message: String) {
    if should_block_live_promotion_request(&message) {
        append_transcript_message(
            &target,
            &session_id,
            "assistant",
            live_promotion_blocker_response(),
            json!({ "transport": "operator-chat", "status": "live_promotion_blocked" }),
        );
        return;
    }

    if should_route_owner_message_to_self_improvement(&message) {
        run_self_improvement_mcp_turn(&target, &session_id, &message).await;
        return;
    }

    let _ = execute_agent_run_turn(AgentRunTurnRequest {
        target,
        session_id,
        message,
        timeout_ms: default_chat_agent_run_timeout_ms(),
        surface: "operator-chat".to_string(),
        operation: "agents-run".to_string(),
        bot_id: None,
        run_id: None,
        assistant_metadata: json!({ "transport": "agents/run" }),
    })
    .await;
}

struct AgentRunTurnRequest {
    target: SidecarChatTarget,
    session_id: String,
    message: String,
    timeout_ms: u64,
    surface: String,
    operation: String,
    bot_id: Option<String>,
    run_id: Option<String>,
    assistant_metadata: Value,
}

pub async fn run_agentic_chat_turn(
    target: SidecarChatTarget,
    options: AgenticChatTurnOptions,
) -> Result<AgenticChatTurnResult, String> {
    append_transcript_message(
        &target,
        &options.session_id,
        "user",
        options.message.clone(),
        options.user_metadata,
    );

    execute_agent_run_turn(AgentRunTurnRequest {
        target,
        session_id: options.session_id,
        message: options.message,
        timeout_ms: options.timeout_ms,
        surface: options.surface,
        operation: options.operation,
        bot_id: options.bot_id,
        run_id: options.run_id,
        assistant_metadata: options.assistant_metadata,
    })
    .await
}

async fn execute_agent_run_turn(
    request: AgentRunTurnRequest,
) -> Result<AgenticChatTurnResult, String> {
    // Carry an inline profile whose `instructions` globs point opencode at the
    // operator charter + full trading protocol that activate.rs writes into the
    // workspace. Without this the sidecar builds OPENCODE_CONFIG_CONTENT with no
    // `instructions` field, so opencode loads neither AGENTS.md nor
    // profile-instructions.md and answers as the default coding assistant
    // instead of the trading operator. Model/provider still come from the
    // OPENCODE_MODEL_* env the sidecar injects; we only add instructions here.
    let run_body = json!({
        "identifier": "default",
        "message": request.message.clone(),
        "sessionId": request.session_id.clone(),
        "timeout": request.timeout_ms,
        "backend": {
            "inlineProfile": {
                "instructions": [
                    "AGENTS.md",
                    ".opencode/profile-instructions.md"
                ]
            }
        }
    });
    let started_at = Instant::now();
    let result = send_chat_request(
        &request.target,
        reqwest::Method::POST,
        "/agents/run",
        Some(run_body),
        None,
    )
    .await;
    let (status, payload) = match result {
        Ok(run_response) => {
            let status = StatusCode::from_u16(run_response.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let bytes = match run_response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    append_transcript_message(
                        &request.target,
                        &request.session_id,
                        "assistant",
                        format!("Agent run failed to return a readable response: {error}"),
                        json!({ "transport": "agents/run", "status": "read_error" }),
                    );
                    return Err(format!(
                        "Agent run failed to return a readable response: {error}"
                    ));
                }
            };
            let payload: Value = serde_json::from_slice(&bytes).unwrap_or_else(
                |_| json!({ "success": false, "response": String::from_utf8_lossy(&bytes) }),
            );
            (status, payload)
        }
        Err((status, message)) => (
            status,
            json!({ "success": false, "error": { "message": message } }),
        ),
    };
    // The sidecar /agents/run response is { success, data: { finalText, … } }.
    // Read data.finalText first; keep legacy "response" + error.message as
    // fallbacks so older/error payloads still surface something.
    let assistant_text = payload
        .get("data")
        .and_then(|data| data.get("finalText"))
        .and_then(Value::as_str)
        .or_else(|| payload.get("response").and_then(Value::as_str))
        .or_else(|| {
            payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string();
    let text = if assistant_text.is_empty() {
        format!(
            "Agent run completed without text output. sidecar_status={}",
            status.as_u16()
        )
    } else {
        assistant_text
    };
    let usage_event = build_agent_run_usage_event_for(
        &request.target,
        &request.session_id,
        &request.message,
        &text,
        status,
        &payload,
        started_at.elapsed().as_millis() as u64,
        &request.surface,
        &request.operation,
        request.bot_id.as_deref(),
        request.run_id.as_deref(),
    );
    append_usage_event_to_sidecar(&request.target, usage_event.clone()).await;
    let mut assistant_metadata = request.assistant_metadata;
    merge_metadata_fields(
        &mut assistant_metadata,
        json!({
            "transport": "agents/run",
            "status": status.as_u16(),
            "usage_telemetry": usage_event.clone(),
        }),
    );
    append_transcript_message(
        &request.target,
        &request.session_id,
        "assistant",
        text.clone(),
        assistant_metadata,
    );

    let messages = transcript_messages_for_session(&request.target, &request.session_id);
    let trace_id = usage_event
        .get("trace_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let input_tokens = usage_event
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u64::from(u32::MAX)) as u32;
    let output_tokens = usage_event
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u64::from(u32::MAX)) as u32;
    let cost_usd = usage_event.get("cost_usd").and_then(Value::as_f64);

    Ok(AgenticChatTurnResult {
        session_id: request.session_id,
        assistant_text: text,
        status: status.as_u16(),
        input_tokens,
        output_tokens,
        cost_usd,
        trace_id,
        usage_event,
        payload,
        messages,
    })
}

#[cfg(test)]
fn build_agent_run_usage_event(
    target: &SidecarChatTarget,
    session_id: &str,
    input_text: &str,
    output_text: &str,
    status: StatusCode,
    payload: &Value,
    duration_ms: u64,
) -> Value {
    build_agent_run_usage_event_for(
        target,
        session_id,
        input_text,
        output_text,
        status,
        payload,
        duration_ms,
        "operator-chat",
        "agents-run",
        None,
        None,
    )
}

fn build_agent_run_usage_event_for(
    target: &SidecarChatTarget,
    session_id: &str,
    input_text: &str,
    output_text: &str,
    status: StatusCode,
    payload: &Value,
    duration_ms: u64,
    surface: &str,
    operation: &str,
    bot_id: Option<&str>,
    run_id: Option<&str>,
) -> Value {
    let usage = agent_run_usage_payload(payload);
    let input_tokens = usage_int(
        &usage,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
            "tokensIn",
        ],
    );
    let output_tokens = usage_int(
        &usage,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
            "tokensOut",
        ],
    );
    let total_tokens =
        usage_int(&usage, &["total_tokens", "totalTokens", "tokensTotal"]).or_else(|| {
            Some(input_tokens.unwrap_or(0) + output_tokens.unwrap_or(0)).filter(|value| *value > 0)
        });
    let token_count_status = if input_tokens.is_some() && output_tokens.is_some() {
        "reported"
    } else if input_tokens.is_some() || output_tokens.is_some() || total_tokens.is_some() {
        "partial"
    } else {
        "unreported"
    };
    let timestamp = chrono::Utc::now().to_rfc3339();
    json!({
        "schema_version": "1.0.0",
        "event_id": format!("{}-{}-{}", surface, session_id, chrono::Utc::now().timestamp_millis()),
        "timestamp": timestamp,
        "workspace": "/home/agent",
        "bot_id": bot_id.map(Value::from).unwrap_or(Value::Null),
        "surface": surface,
        "operation": operation,
        "run_id": run_id.map(Value::from).unwrap_or(Value::Null),
        "task_id": serde_json::Value::Null,
        "session_id": session_id,
        "trace_id": usage_string(&usage, &["trace_id", "traceId"]),
        "provider": usage_string(&usage, &["provider"]),
        "model": usage_string(&usage, &["model"]),
        "model_source": "sidecar_response",
        "command": serde_json::Value::Null,
        "status": if status.is_success() { "completed" } else { "failed" },
        "success": status.is_success(),
        "duration_ms": duration_ms,
        "input_chars": input_text.chars().count(),
        "output_chars": output_text.chars().count(),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_input_tokens": usage_int(&usage, &["cached_input_tokens", "cachedInputTokens"]),
        "reasoning_tokens": usage_int(&usage, &["reasoning_tokens", "reasoningTokens"]),
        "token_count_status": token_count_status,
        "cost_usd": usage_number(&usage, &["cost_usd", "costUsd", "cost"]),
        "cost_source": if usage_number(&usage, &["cost_usd", "costUsd", "cost"]).is_some() { "reported" } else { "unknown" },
        "raw_usage": usage,
        "metadata": {
            "sandbox_id": target.sandbox_id,
            "sidecar_status": status.as_u16(),
        },
    })
}

fn agent_run_usage_payload(payload: &Value) -> Value {
    for pointer in [
        "/data/usage",
        "/usage",
        "/data/result/usage",
        "/data/turn/usage",
        "/data/finalMessage/usage",
        "/data/metadata",
        "/metadata",
    ] {
        if let Some(value) = payload.pointer(pointer)
            && value.is_object()
        {
            return normalize_agent_run_usage(value);
        }
    }
    json!({})
}

fn normalize_agent_run_usage(usage: &Value) -> Value {
    let mut normalized = usage.clone();
    if normalized.get("costUsd").is_none()
        && normalized.get("cost_usd").is_none()
        && let Some(cents) = usage_number(&normalized, &["spentCreditsCents"])
        && let Some(object) = normalized.as_object_mut()
    {
        object.insert("costUsd".to_string(), json!(cents / 100.0));
    }
    normalized
}

fn usage_int(usage: &Value, keys: &[&str]) -> Option<u64> {
    usage_number(usage, keys).map(|value| value.max(0.0).round() as u64)
}

fn usage_number(usage: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = usage.get(*key) {
            if let Some(number) = value.as_f64() {
                if number.is_finite() {
                    return Some(number);
                }
            }
            if let Some(raw) = value.as_str()
                && let Ok(number) = raw.trim().parse::<f64>()
                && number.is_finite()
            {
                return Some(number);
            }
        }
    }
    None
}

fn usage_string(usage: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| usage.get(*key).and_then(Value::as_str))
        .find(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn merge_metadata_fields(target: &mut Value, fields: Value) {
    let Some(target_object) = target.as_object_mut() else {
        *target = fields;
        return;
    };
    if let Some(fields_object) = fields.as_object() {
        for (key, value) in fields_object {
            target_object.insert(key.clone(), value.clone());
        }
    }
}

async fn append_usage_event_to_sidecar(target: &SidecarChatTarget, event: Value) {
    let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: target.sidecar_url.clone(),
        command: r#"node -e "const fs=require('node:fs'); const path=require('node:path'); const event=JSON.parse(process.env.USAGE_EVENT || '{}'); const file='/home/agent/telemetry/llm-usage.jsonl'; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(event) + '\n');""#.to_string(),
        cwd: "/home/agent".to_string(),
        env_json: json!({ "USAGE_EVENT": event.to_string() }).to_string(),
        timeout_ms: 10_000,
    };
    if let Err(error) =
        ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req, &target.sidecar_token).await
    {
        tracing::warn!(
            sandbox_id = %target.sandbox_id,
            "failed to append operator-chat usage telemetry: {error}"
        );
    }
}

fn should_route_owner_message_to_self_improvement(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let asks_for_change = [
        "build",
        "implement",
        "integrate",
        "add support",
        "create",
        "write",
        "prototype",
        "new protocol",
        "market make",
        "tool",
        "code",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let code_surface = [
        "self-improvement",
        "mcp",
        "paper-trading",
        "paper trading",
        "backtest",
        "run-demo",
        "tests",
        "tools/",
        "sdk",
        "protocol integration",
        "integration",
        "provider",
        "venue",
        "trading",
        "market",
        "strategy",
    ]
    .iter()
    .any(|needle| lower.contains(needle));

    asks_for_change && code_surface
}

fn should_block_live_promotion_request(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    includes_live_intent(&lower)
        && includes_approval_intent(&lower)
        && !lower.contains("paper")
        && !lower.contains("shadow")
}

fn includes_live_intent(lower: &str) -> bool {
    [
        "live",
        "real funds",
        "mainnet",
        "on-chain",
        "execute for real",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn includes_approval_intent(lower: &str) -> bool {
    [
        "run this", "turn on", "enable", "promote", "approve", "go live", "switch", "deploy",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn live_promotion_blocker_response() -> String {
    [
        "Live promotion is blocked.",
        "",
        "I need an approved candidate with deterministic paper/shadow evidence, passing checks, validator/risk gates, configured live execution credentials, and an explicit promotion handoff before I can run anything live.",
        "",
        "I will keep the current strategy in paper/shadow mode. Ask me to inspect the latest self-improvement run or continue the failing checks if you want this candidate moved toward promotion readiness.",
    ]
    .join("\n")
}

async fn run_self_improvement_mcp_turn(
    target: &SidecarChatTarget,
    session_id: &str,
    message: &str,
) {
    let args = json!({
        "spec": self_improvement_task_spec(message),
        "constraints": "Paper/shadow only. Do not request live keys. Do not submit real transactions. Preserve validator/trading API safety gates. If verification fails, continue through MCP rounds and record the exact blocker.",
        "max_rounds": 4,
        "coding_timeout_ms": 240000,
        "test_timeout_ms": 120000,
        "review_timeout_ms": 120000,
        "wait_for_completion": false,
        "test_commands": self_improvement_test_commands(message),
    });
    let command = r#"node <<'NODE'
const { spawnSync } = require('node:child_process');
const args = JSON.parse(process.env.SELF_IMPROVEMENT_TASK_ARGS || '{}');
const input = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'self_improvement.create_task', arguments: args }
}) + '\n';
const result = spawnSync('bun', ['--bun', '/home/agent/tools/self-improvement-mcp-server.ts'], {
  cwd: '/home/agent',
  input,
  encoding: 'utf8',
  timeout: Number(process.env.MCP_TIMEOUT_MS || 1200000),
  maxBuffer: 64 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(result.error.stack || result.error.message || String(result.error));
  process.exit(1);
}
process.exit(result.status ?? 1);
NODE"#;
    let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: target.sidecar_url.clone(),
        command: command.to_string(),
        cwd: "/home/agent".to_string(),
        env_json: json!({
            "SELF_IMPROVEMENT_TASK_ARGS": args.to_string(),
            "MCP_TIMEOUT_MS": default_chat_agent_run_timeout_ms().to_string(),
        })
        .to_string(),
        timeout_ms: default_chat_agent_run_timeout_ms(),
    };

    let text = match ai_agent_sandbox_blueprint_lib::run_exec_request(
        &exec_req,
        &target.sidecar_token,
    )
    .await
    {
        Ok(response) => {
            let status = if response.exit_code == 0 {
                "dispatched"
            } else {
                "failed"
            };
            format!(
                "Self-improvement MCP task {status}. The request was routed through `self_improvement.create_task` with async multi-shot verification; task status can be checked with `self_improvement.status` or `self_improvement.list_tasks`.\n\nstdout:\n{}\n\nstderr:\n{}",
                trim_for_transcript(&response.stdout, 12_000),
                trim_for_transcript(&response.stderr, 4_000),
            )
        }
        Err(error) => format!(
            "Self-improvement MCP task lost its live exec transport. The product routed the owner request to MCP, then attempted recovery from persisted task state.\n\ntransport_error: {error}\n\nrecovery:\n{}",
            run_mcp_recovery_summary(target).await
        ),
    };

    append_transcript_message(
        target,
        session_id,
        "assistant",
        text,
        json!({ "transport": "self-improvement-mcp", "status": "dispatched_or_blocked" }),
    );
}

async fn run_mcp_recovery_summary(target: &SidecarChatTarget) -> String {
    let command = r#"printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"self_improvement.list_tasks","arguments":{"max_results":3}}}\n' | bun --bun /home/agent/tools/self-improvement-mcp-server.ts"#;
    let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
        sidecar_url: target.sidecar_url.clone(),
        command: command.to_string(),
        cwd: "/home/agent".to_string(),
        env_json: "{}".to_string(),
        timeout_ms: default_chat_agent_run_timeout_ms(),
    };

    match ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req, &target.sidecar_token).await {
        Ok(response) => format!(
            "exit_code={}\nstdout:\n{}\nstderr:\n{}",
            response.exit_code,
            trim_for_transcript(&response.stdout, 8_000),
            trim_for_transcript(&response.stderr, 2_000)
        ),
        Err(error) => format!("recovery_failed: {error}"),
    }
}

fn self_improvement_task_spec(message: &str) -> String {
    format!(
        "Owner requested a code-changing trading-agent capability through chat. Complete it as a small, tactical, paper-only self-improvement task.\n\nOwner request:\n{message}\n\nAcceptance: create durable code/artifacts, run deterministic executable checks, continue through failures for the allowed rounds, and leave live trading blocked unless separately authorized by the validator/trading API flow."
    )
}

fn self_improvement_test_commands(message: &str) -> Vec<String> {
    let commands = extract_bun_commands(message);
    if commands.is_empty() {
        return vec!["bun --bun /home/agent/tools/self-improvement-loop.ts status".to_string()];
    }
    commands
}

fn extract_bun_commands(message: &str) -> Vec<String> {
    let normalized = message.replace(['\n', '\r'], " ");
    let mut commands = Vec::new();
    let mut offset = 0;
    while let Some(relative) = normalized[offset..].find("bun ") {
        let start = offset + relative;
        if start >= 2 && &normalized[start - 2..start] == "--" {
            offset = start + "bun ".len();
            continue;
        }
        let tail = &normalized[start..];
        let mut end = tail.len();
        for delimiter in [
            " and ",
            " before ",
            ",",
            ";",
            ". The ",
            ". If ",
            ". Otherwise",
        ] {
            if let Some(index) = tail.find(delimiter) {
                end = end.min(index);
            }
        }
        let command = tail[..end]
            .trim()
            .trim_matches('`')
            .trim_matches('"')
            .trim()
            .to_string();
        if command.starts_with("bun ") && command.len() > "bun ".len() {
            commands.push(command);
        }
        offset = start + "bun ".len();
    }
    commands.sort();
    commands.dedup();
    commands
}

fn trim_for_transcript(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }
    let prefix = value.chars().take(max_chars).collect::<String>();
    format!(
        "{}...\n[truncated {} chars]",
        prefix,
        char_count.saturating_sub(max_chars)
    )
}

fn default_chat_agent_run_timeout_ms() -> u64 {
    std::env::var("CHAT_AGENT_RUN_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CHAT_AGENT_RUN_TIMEOUT_MS)
}

fn parse_session_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/agents/sessions/")?;
    let mut parts = rest.split('/').map(str::to_string).collect::<Vec<_>>();
    if parts.is_empty() || parts[0].is_empty() {
        return None;
    }
    let session_id = parts.remove(0);
    Some((session_id, parts.join("/")))
}

fn extract_message_text(body: &Value) -> String {
    if let Some(message) = body.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    body.get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| body.to_string())
}

fn append_transcript_message(
    target: &SidecarChatTarget,
    session_id: &str,
    role: &str,
    text: String,
    metadata: Value,
) -> Value {
    let message_id = format!(
        "{}-{}",
        role,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let timestamp = chrono::Utc::now().to_rfc3339();
    let message = json!({
        "info": {
            "id": message_id,
            "role": role,
            "timestamp": timestamp,
            "success": metadata
                .get("status")
                .and_then(Value::as_u64)
                .is_none_or(|status| status < 400),
        },
        "parts": [{ "type": "text", "text": text }],
        "metadata": metadata,
    });
    if let Ok(mut store) = CHAT_TRANSCRIPTS.lock() {
        store
            .entry(transcript_key(&target.sandbox_id, session_id))
            .or_default()
            .push(message.clone());
    }
    message
}

pub fn append_operator_transcript_message(
    target: &SidecarChatTarget,
    session_id: &str,
    role: &str,
    text: String,
    metadata: Value,
) -> Value {
    append_transcript_message(target, session_id, role, text, metadata)
}

pub fn transcript_messages_for_session(target: &SidecarChatTarget, session_id: &str) -> Value {
    CHAT_TRANSCRIPTS
        .lock()
        .ok()
        .and_then(|store| {
            store
                .get(&transcript_key(&target.sandbox_id, session_id))
                .cloned()
        })
        .map(Value::Array)
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

pub async fn proxy_chat_events(
    target: SidecarChatTarget,
    session_id: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let session_id = session_id.unwrap_or_else(|| default_manual_session_id(&target.sandbox_id));
    let messages = CHAT_TRANSCRIPTS
        .lock()
        .ok()
        .and_then(|store| {
            store
                .get(&transcript_key(&target.sandbox_id, &session_id))
                .cloned()
        })
        .unwrap_or_default();
    let event = Event::default()
        .event("sync")
        .json_data(json!({
            "sessionId": session_id,
            "messages": messages,
            "transport": "agents/run"
        }))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to encode chat event: {e}"),
            )
        })?;
    let event_stream = futures_util::stream::once(async move { Ok::<Event, Infallible>(event) });
    Ok(Sse::new(Box::pin(event_stream))
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use tempfile::tempdir;

    #[test]
    fn detects_autonomous_session_names() {
        let bot_id = "bot-123";

        for session_id in [
            "trading-bot-123",
            "trading-bot-123-1775823900",
            "fast-bot-123",
            "research-bot-123",
            "convo-bot-123",
        ] {
            assert!(is_autonomous_chat_session(bot_id, session_id));
        }
    }

    #[test]
    fn allows_manual_sessions_through() {
        let bot_id = "bot-123";

        for session_id in ["manual-1", "session-abc", "conversation-with-owner"] {
            assert!(!is_autonomous_chat_session(bot_id, session_id));
        }
    }

    #[test]
    fn routes_owner_code_change_requests_to_self_improvement_mcp() {
        let source = include_str!("operator_chat.rs");
        assert!(source.contains("\"wait_for_completion\": false"));
        assert!(source.contains("self_improvement.status"));

        assert!(should_route_owner_message_to_self_improvement(
            "Research Rain SDK, build a paper-trading prototype under tools/rain-paper, and run bun test tools/rain-paper/rain-paper.test.ts"
        ));
        assert!(should_route_owner_message_to_self_improvement(
            "Integrate Rain and market make with a paper strategy first"
        ));
        assert!(should_block_live_promotion_request("ok now run this live"));
        assert!(live_promotion_blocker_response().contains("Live promotion is blocked"));
        assert!(!should_route_owner_message_to_self_improvement(
            "What is my current ETH position?"
        ));
        assert!(!should_route_owner_message_to_self_improvement(
            "What strategy would you use for ETH today?"
        ));
    }

    #[test]
    fn agent_run_usage_event_preserves_reported_tokens_and_cost() {
        let target = SidecarChatTarget {
            sandbox_id: "sandbox-usage".to_string(),
            sidecar_url: "http://127.0.0.1:1".to_string(),
            sidecar_token: "test-token".to_string(),
        };
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "usage": {
                    "inputTokens": 1200,
                    "outputTokens": 345,
                    "costUsd": 0.017,
                    "model": "glm-4.7",
                    "provider": "zai-coding-plan"
                }
            }
        });
        let event = build_agent_run_usage_event(
            &target,
            "manual-sandbox-usage",
            "what happened?",
            "summary",
            StatusCode::OK,
            &payload,
            42,
        );

        assert_eq!(event["surface"], "operator-chat");
        assert_eq!(event["operation"], "agents-run");
        assert_eq!(event["input_tokens"], 1200);
        assert_eq!(event["output_tokens"], 345);
        assert_eq!(event["total_tokens"], 1545);
        assert_eq!(event["cost_usd"], 0.017);
        assert_eq!(event["token_count_status"], "reported");
        assert_eq!(event["provider"], "zai-coding-plan");
        assert_eq!(event["model"], "glm-4.7");
    }

    #[test]
    fn agent_run_usage_event_reads_runtime_metadata_usage() {
        let target = SidecarChatTarget {
            sandbox_id: "sandbox-runtime-usage".to_string(),
            sidecar_url: "http://127.0.0.1:1".to_string(),
            sidecar_token: "test-token".to_string(),
        };
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "finalText": "done",
                "metadata": {
                    "tokensIn": 222,
                    "tokensOut": 111,
                    "spentCreditsCents": 3.5,
                    "model": "conversation-runtime"
                }
            }
        });
        let event = build_agent_run_usage_event(
            &target,
            "manual-runtime-usage",
            "ping",
            "done",
            StatusCode::OK,
            &payload,
            25,
        );

        assert_eq!(event["input_tokens"], 222);
        assert_eq!(event["output_tokens"], 111);
        assert_eq!(event["total_tokens"], 333);
        assert_eq!(event["cost_usd"], 0.035);
        assert_eq!(event["cost_source"], "reported");
        assert_eq!(event["token_count_status"], "reported");
    }

    #[test]
    fn agent_run_usage_event_supports_observatory_metadata() {
        let target = SidecarChatTarget {
            sandbox_id: "sandbox-observatory".to_string(),
            sidecar_url: "http://127.0.0.1:1".to_string(),
            sidecar_token: "test-token".to_string(),
        };
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "usage": {
                    "inputTokens": 400,
                    "outputTokens": 90,
                    "traceId": "trace-observatory-1",
                    "provider": "zai",
                    "model": "glm-4.7"
                }
            }
        });
        let event = build_agent_run_usage_event_for(
            &target,
            "convo-bot-1-1775823900",
            "reflect",
            "Observed...",
            StatusCode::OK,
            &payload,
            200,
            "observatory",
            "read-only-reflection",
            Some("bot-1"),
            Some("obs-1"),
        );

        assert_eq!(event["surface"], "observatory");
        assert_eq!(event["operation"], "read-only-reflection");
        assert_eq!(event["bot_id"], "bot-1");
        assert_eq!(event["run_id"], "obs-1");
        assert_eq!(event["trace_id"], "trace-observatory-1");
        assert_eq!(event["input_tokens"], 400);
        assert_eq!(event["output_tokens"], 90);
    }

    #[test]
    fn extracts_requested_rain_verification_commands() {
        let commands = self_improvement_test_commands(
            "Run bun test tools/rain-paper/rain-paper.test.ts and bun --bun tools/rain-paper/run-demo.ts before reporting success.",
        );

        assert_eq!(
            commands,
            vec![
                "bun --bun tools/rain-paper/run-demo.ts".to_string(),
                "bun test tools/rain-paper/rain-paper.test.ts".to_string(),
            ]
        );
    }

    #[test]
    fn extracts_generic_bun_verification_commands_without_fixture_names() {
        let commands = self_improvement_test_commands(
            "At minimum: bun test tools/foo/foo.test.ts and bun --bun tools/foo/run-demo.ts. The tests must exercise behavior.",
        );

        assert_eq!(
            commands,
            vec![
                "bun --bun tools/foo/run-demo.ts".to_string(),
                "bun test tools/foo/foo.test.ts".to_string(),
            ]
        );
    }

    fn init_test_env() -> tempfile::TempDir {
        let dir = tempdir().expect("create temp state dir");
        unsafe {
            std::env::set_var("BLUEPRINT_STATE_DIR", dir.path());
        }
        dir
    }

    fn seed_sandbox_record(id: &str, sidecar_url: &str, token: &str) {
        let record = sandbox_runtime::SandboxRecord {
            id: id.to_string(),
            container_id: format!("container-{id}"),
            sidecar_url: sidecar_url.to_string(),
            sidecar_port: 8080,
            ssh_port: None,
            token: token.to_string(),
            created_at: chrono::Utc::now().timestamp() as u64,
            cpu_cores: 2,
            memory_mb: 4096,
            state: sandbox_runtime::runtime::SandboxState::Running,
            idle_timeout_seconds: 0,
            max_lifetime_seconds: 86_400,
            last_activity_at: chrono::Utc::now().timestamp() as u64,
            stopped_at: None,
            snapshot_image_id: None,
            snapshot_s3_url: None,
            container_removed_at: None,
            image_removed_at: None,
            original_image: "blueprint-sidecar:all-harness".to_string(),
            base_env_json: "{}".to_string(),
            user_env_json: String::new(),
            snapshot_destination: None,
            tee_deployment_id: None,
            tee_metadata_json: None,
            name: String::new(),
            agent_identifier: String::new(),
            metadata_json: String::new(),
            disk_gb: 0,
            stack: String::new(),
            owner: String::new(),
            service_id: None,
            tee_config: None,
            extra_ports: std::collections::HashMap::new(),
            ssh_login_user: None,
            ssh_authorized_keys: Vec::new(),
            capabilities_json: String::new(),
            tee_attestation_json: None,
        };

        sandbox_runtime::runtime::sandboxes()
            .expect("sandbox store")
            .insert(id.to_string(), record)
            .expect("insert sandbox record");
    }

    async fn spawn_mock_chat_sidecar() -> String {
        let app = Router::new()
            .route(
                "/health",
                get(|| async { Json(serde_json::json!({ "ok": true })) }),
            )
            .route(
                "/agents/run",
                post(|| async { Json(serde_json::json!({ "success": true, "response": "ok" })) }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock sidecar");
        let addr = listener.local_addr().expect("sidecar addr");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve mock sidecar");
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn run_request_retries_with_latest_sandbox_target() {
        let _dir = init_test_env();
        let sandbox_id = "sandbox-chat-retry";
        let fresh_url = spawn_mock_chat_sidecar().await;
        seed_sandbox_record(sandbox_id, &fresh_url, "test-token");

        let stale_target = SidecarChatTarget {
            sandbox_id: sandbox_id.to_string(),
            sidecar_url: "http://127.0.0.1:1".to_string(),
            sidecar_token: "test-token".to_string(),
        };

        let response = send_chat_request(
            &stale_target,
            reqwest::Method::POST,
            "/agents/run",
            Some(serde_json::json!({ "message": "hello" })),
            None,
        )
        .await
        .expect("request recovers");

        assert!(response.status().is_success());
        let payload: serde_json::Value = response.json().await.expect("json payload");
        assert_eq!(payload["response"], "ok");
    }
}
