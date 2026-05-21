use std::convert::Infallible;
use std::time::Duration;

use axum::http::{StatusCode, header::CONTENT_TYPE};
use axum::response::{
    IntoResponse, Response,
    sse::{Event, KeepAlive, Sse},
};
use bytes::Bytes;
use futures_core::Stream;
use serde_json::Value;
use tokio::time::sleep;

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

fn transform_session_entries(
    bot_id: &str,
    values: Vec<Value>,
    scope: ChatSessionScope,
) -> Vec<Value> {
    values
        .into_iter()
        .filter_map(|entry| match entry {
            Value::Object(mut map) => {
                let Some(session_id) = map.get("id").and_then(Value::as_str) else {
                    return Some(Value::Object(map));
                };

                if scope == ChatSessionScope::ManualOnly
                    && is_autonomous_chat_session(bot_id, session_id)
                {
                    return None;
                }

                map.insert(
                    "session_type".to_string(),
                    Value::String(chat_session_type(bot_id, session_id).to_string()),
                );
                Some(Value::Object(map))
            }
            other => Some(other),
        })
        .collect()
}

fn transform_sessions_payload(bot_id: &str, payload: Value, scope: ChatSessionScope) -> Value {
    match payload {
        Value::Array(values) => Value::Array(transform_session_entries(bot_id, values, scope)),
        Value::Object(mut map) => {
            if let Some(Value::Array(values)) = map.remove("sessions") {
                map.insert(
                    "sessions".to_string(),
                    Value::Array(transform_session_entries(bot_id, values, scope)),
                );
            }
            Value::Object(map)
        }
        other => other,
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
    if let Some(json) = body {
        req = req.json(&json);
    }

    req.timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Sidecar unreachable: {e}")))
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

async fn into_axum_response(resp: reqwest::Response) -> Result<Response, (StatusCode, String)> {
    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read sidecar response: {e}"),
        )
    })?;

    Ok((status, [(CONTENT_TYPE, content_type)], bytes).into_response())
}

pub async fn proxy_chat_request(
    target: &SidecarChatTarget,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    query: Option<&str>,
) -> Result<Response, (StatusCode, String)> {
    into_axum_response(send_chat_request(target, method, path, body, query).await?).await
}

pub async fn list_chat_sessions(
    target: &SidecarChatTarget,
    bot_id: &str,
    scope: ChatSessionScope,
) -> Result<Response, (StatusCode, String)> {
    let resp =
        send_chat_request(target, reqwest::Method::GET, "/agents/sessions", None, None).await?;
    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = resp.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read sidecar response: {e}"),
        )
    })?;

    if !status.is_success() {
        return Ok((status, [(CONTENT_TYPE, "application/json")], bytes).into_response());
    }

    let payload: Value = serde_json::from_slice(&bytes).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode sidecar session list: {e}"),
        )
    })?;
    let filtered = transform_sessions_payload(bot_id, payload, scope);
    let body = serde_json::to_vec(&filtered).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to encode filtered session list: {e}"),
        )
    })?;

    Ok((status, [(CONTENT_TYPE, "application/json")], body).into_response())
}

pub async fn list_chat_session_ids(
    target: &SidecarChatTarget,
) -> Result<Vec<String>, (StatusCode, String)> {
    let resp =
        send_chat_request(target, reqwest::Method::GET, "/agents/sessions", None, None).await?;
    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = resp.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read sidecar response: {e}"),
        )
    })?;

    if !status.is_success() {
        return Err((status, String::from_utf8_lossy(&bytes).into_owned()));
    }

    let payload: Value = serde_json::from_slice(&bytes).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to decode sidecar session list: {e}"),
        )
    })?;

    let entries: Vec<Value> = match payload {
        Value::Array(values) => values,
        Value::Object(mut map) => map
            .remove("sessions")
            .and_then(|sessions| sessions.as_array().cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    Ok(entries
        .into_iter()
        .filter_map(|entry| match entry {
            Value::Object(map) => map.get("id").and_then(Value::as_str).map(str::to_string),
            _ => None,
        })
        .collect())
}

pub async fn proxy_chat_events(
    target: SidecarChatTarget,
    session_id: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let client = reqwest::Client::new();
    let resp = match connect_chat_events_once(&client, &target, session_id.as_deref()).await {
        Ok(response) => response,
        Err(initial_error) => {
            let recovered_target = recover_chat_target(&target)
                .await
                .ok_or_else(|| initial_error.clone())?;
            connect_chat_events_once(&client, &recovered_target, session_id.as_deref())
                .await
                .inspect_err(|retry_error| {
                    tracing::warn!(
                        sandbox_id = %target.sandbox_id,
                        initial = %initial_error.1,
                        retry = %retry_error.1,
                        "chat SSE retry failed after recovery attempt"
                    );
                })?
        }
    };

    if !resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Sidecar SSE returned status {}", resp.status()),
        ));
    }

    let event_stream = SseParser::new(resp.bytes_stream());
    Ok(Sse::new(Box::pin(event_stream))
        .keep_alive(KeepAlive::default())
        .into_response())
}

async fn connect_chat_events_once(
    client: &reqwest::Client,
    target: &SidecarChatTarget,
    session_id: Option<&str>,
) -> Result<reqwest::Response, (StatusCode, String)> {
    let mut url = format!("{}/agents/events", target.sidecar_url.trim_end_matches('/'));
    if let Some(sid) = session_id
        && !sid.is_empty()
    {
        url.push_str(&format!("?sessionId={sid}"));
    }

    let mut req = client.get(&url);
    if !target.sidecar_token.is_empty() {
        req = req.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", target.sidecar_token),
        );
    }

    req.timeout(Duration::from_secs(3600))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to connect to sidecar SSE: {e}"),
            )
        })
}

struct SseParser<S> {
    inner: S,
    buffer: String,
}

impl<S> SseParser<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            buffer: String::new(),
        }
    }
}

impl<S> Stream for SseParser<S>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    type Item = Result<Event, Infallible>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();

        loop {
            if let Some(pos) = this.buffer.find("\n\n") {
                let event_text = this.buffer[..pos].to_string();
                this.buffer = this.buffer[pos + 2..].to_string();

                let mut event_type = None;
                let mut data_parts = Vec::new();

                for line in event_text.lines() {
                    if let Some(rest) = line.strip_prefix("event:") {
                        event_type = Some(rest.trim().to_string());
                    } else if let Some(rest) = line.strip_prefix("data:") {
                        data_parts.push(rest.trim().to_string());
                    }
                }

                if !data_parts.is_empty() {
                    let data = data_parts.join("\n");
                    let mut event = Event::default().data(data);
                    if let Some(kind) = event_type {
                        event = event.event(kind);
                    }
                    return std::task::Poll::Ready(Some(Ok(event)));
                }
                continue;
            }

            match std::pin::Pin::new(&mut this.inner).poll_next(cx) {
                std::task::Poll::Ready(Some(Ok(bytes))) => {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        this.buffer.push_str(text);
                    }
                }
                std::task::Poll::Ready(Some(Err(_))) => return std::task::Poll::Ready(None),
                std::task::Poll::Ready(None) => return std::task::Poll::Ready(None),
                std::task::Poll::Pending => return std::task::Poll::Pending,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::get};
    use tempfile::tempdir;

    #[test]
    fn detects_legacy_and_current_autonomous_session_names() {
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
    fn transforms_manual_sessions_with_session_type() {
        let payload = serde_json::json!([
            {"id": "manual-1", "title": "New Chat"},
            {"id": "fast-bot-123", "title": "Fast"}
        ]);

        let transformed =
            transform_sessions_payload("bot-123", payload, ChatSessionScope::ManualOnly);

        assert_eq!(
            transformed,
            serde_json::json!([
                {"id": "manual-1", "title": "New Chat", "session_type": "manual"}
            ])
        );
    }

    #[test]
    fn includes_autonomous_sessions_when_scope_is_all() {
        let payload = serde_json::json!([
            {"id": "manual-1", "title": "New Chat"},
            {"id": "fast-bot-123"},
            {"id": "research-bot-123"}
        ]);

        let transformed = transform_sessions_payload("bot-123", payload, ChatSessionScope::All);

        assert_eq!(
            transformed,
            serde_json::json!([
                {"id": "manual-1", "title": "New Chat", "session_type": "manual"},
                {"id": "fast-bot-123", "session_type": "autonomous"},
                {"id": "research-bot-123", "session_type": "autonomous"}
            ])
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
                "/agents/sessions",
                get(|| async { Json(serde_json::json!([{ "id": "manual-1" }])) }),
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
    async fn chat_request_retries_with_latest_sandbox_target() {
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
            reqwest::Method::GET,
            "/agents/sessions",
            None,
            None,
        )
        .await
        .expect("request recovers");

        assert!(response.status().is_success());
        let payload: serde_json::Value = response.json().await.expect("json payload");
        assert_eq!(payload, serde_json::json!([{ "id": "manual-1" }]));
    }
}
