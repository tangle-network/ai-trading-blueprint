use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

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
        wait_for_sidecar_health(&refreshed.sidecar_url, 5).await;
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
    wait_for_sidecar_health(&next.sidecar_url, 10).await;
    Some(next)
}

async fn wait_for_sidecar_health(sidecar_url: &str, attempts: usize) {
    if attempts == 0 {
        return;
    }

    let client = reqwest::Client::new();
    let url = format!("{}/health", sidecar_url.trim_end_matches('/'));

    for attempt in 0..attempts {
        let is_healthy = client
            .get(&url)
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
    if should_route_owner_message_to_self_improvement(&message) {
        run_self_improvement_mcp_turn(&target, &session_id, &message).await;
        return;
    }

    let run_body = json!({
        "identifier": "default",
        "message": message,
        "sessionId": session_id.clone(),
        "timeout": default_chat_agent_run_timeout_ms()
    });
    let result = send_chat_request(
        &target,
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
                        &target,
                        &session_id,
                        "assistant",
                        format!("Agent run failed to return a readable response: {error}"),
                        json!({ "transport": "agents/run", "status": "read_error" }),
                    );
                    return;
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
    let assistant_text = payload
        .get("response")
        .and_then(Value::as_str)
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
    append_transcript_message(
        &target,
        &session_id,
        "assistant",
        text,
        json!({ "transport": "agents/run", "status": status.as_u16() }),
    );
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
) {
    let message_id = format!(
        "{}-{}",
        role,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let message = json!({
        "info": {
            "id": message_id,
            "role": role,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        },
        "parts": [{ "type": "text", "text": text }],
        "metadata": metadata,
    });
    if let Ok(mut store) = CHAT_TRANSCRIPTS.lock() {
        store
            .entry(transcript_key(&target.sandbox_id, session_id))
            .or_default()
            .push(message);
    }
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
        assert!(!should_route_owner_message_to_self_improvement(
            "What is my current ETH position?"
        ));
        assert!(!should_route_owner_message_to_self_improvement(
            "What strategy would you use for ETH today?"
        ));
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
