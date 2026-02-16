use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, patch, post},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_stream::Stream;

use crate::TradingApiState;
use crate::session_auth;

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new()
        // Auth routes (no auth required)
        .route("/session/auth/challenge", post(auth_challenge))
        .route("/session/auth/verify", post(auth_verify))
        // Session CRUD (auth required — checked in handlers)
        .route("/session/sessions", get(list_sessions))
        .route("/session/sessions", post(create_session))
        .route("/session/sessions/{id}", get(get_session))
        .route("/session/sessions/{id}", delete(delete_session))
        .route("/session/sessions/{id}", patch(update_session))
        // Messages
        .route("/session/sessions/{id}/messages", get(list_messages))
        .route("/session/sessions/{id}/messages", post(send_message))
        // Abort
        .route("/session/sessions/{id}/abort", post(abort_session))
        // SSE events
        .route("/session/events", get(session_events))
}

// ── Auth routes (delegated to session_auth module) ──────────────────────

async fn auth_challenge(
    body: Json<session_auth::ChallengeRequest>,
) -> Result<Json<session_auth::ChallengeResponse>, (StatusCode, String)> {
    session_auth::challenge(body).await
}

async fn auth_verify(
    state: State<Arc<TradingApiState>>,
    body: Json<session_auth::VerifyRequest>,
) -> Result<Json<session_auth::VerifyResponse>, (StatusCode, String)> {
    session_auth::verify(state, body).await
}

// ── Owner auth helper ───────────────────────────────────────────────────

fn extract_owner_token(headers: &axum::http::HeaderMap) -> Result<String, (StatusCode, String)> {
    let header = headers
        .get("authorization")
        .or_else(|| headers.get("x-owner-token"))
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing auth token".into()))?;

    let token = if header.starts_with("Bearer ") {
        &header[7..]
    } else {
        header
    };

    if !token.starts_with("sess_") {
        return Err((StatusCode::UNAUTHORIZED, "Invalid session token".into()));
    }

    session_auth::validate_owner_token(token)
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid or expired session token".into()))?;

    Ok(token.to_string())
}

// ── Proxy helper ────────────────────────────────────────────────────────

async fn proxy_to_sidecar(
    state: &TradingApiState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    query: Option<&str>,
) -> Result<Response, (StatusCode, String)> {
    let client = reqwest::Client::new();

    let mut url = format!("{}{}", state.sidecar_url, path);
    if let Some(q) = query {
        url.push('?');
        url.push_str(q);
    }

    let mut req = client.request(method, &url);
    if !state.sidecar_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", state.sidecar_token));
    }
    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Sidecar proxy error: {e}");
            (StatusCode::BAD_GATEWAY, format!("Sidecar unreachable: {e}"))
        })?;

    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    let bytes = resp.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read sidecar response: {e}"),
        )
    })?;

    Ok((
        status,
        [(axum::http::header::CONTENT_TYPE, content_type)],
        bytes,
    )
        .into_response())
}

// ── Session CRUD ────────────────────────────────────────────────────────

async fn list_sessions(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    extract_owner_token(&headers)?;
    proxy_to_sidecar(&state, reqwest::Method::GET, "/agents/sessions", None, None).await
}

async fn create_session(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, (StatusCode, String)> {
    extract_owner_token(&headers)?;
    proxy_to_sidecar(
        &state,
        reqwest::Method::POST,
        "/agents/sessions",
        Some(body),
        None,
    )
    .await
}

async fn get_session(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    extract_owner_token(&headers)?;
    proxy_to_sidecar(
        &state,
        reqwest::Method::GET,
        &format!("/agents/sessions/{id}"),
        None,
        None,
    )
    .await
}

async fn delete_session(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    extract_owner_token(&headers)?;
    proxy_to_sidecar(
        &state,
        reqwest::Method::DELETE,
        &format!("/agents/sessions/{id}"),
        None,
        None,
    )
    .await
}

async fn update_session(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Response, (StatusCode, String)> {
    extract_owner_token(&headers)?;
    proxy_to_sidecar(
        &state,
        reqwest::Method::PATCH,
        &format!("/agents/sessions/{id}"),
        Some(body),
        None,
    )
    .await
}

// ── Messages ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct MessageQuery {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    50
}

async fn list_messages(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Query(params): Query<MessageQuery>,
) -> Result<Response, (StatusCode, String)> {
    let token = extract_owner_token(&headers)?;
    let bot_id = session_auth::get_token_bot_id(&token).unwrap_or_default();

    let mut query_parts = vec![format!("limit={}", params.limit)];
    if let Some(cursor) = &params.cursor {
        query_parts.push(format!("cursor={cursor}"));
    }
    let query_str = query_parts.join("&");

    let resp = proxy_to_sidecar(
        &state,
        reqwest::Method::GET,
        &format!("/agents/sessions/{id}/messages"),
        None,
        Some(&query_str),
    )
    .await?;

    // Enrich messages with source information
    let (parts, body) = resp.into_parts();
    let bytes = axum::body::to_bytes(body, 10 * 1024 * 1024)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read response body: {e}"),
            )
        })?;

    if let Ok(mut messages) = serde_json::from_slice::<Value>(&bytes) {
        enrich_message_sources(&mut messages, &bot_id);
        let enriched = serde_json::to_vec(&messages).unwrap_or_else(|_| bytes.to_vec());
        Ok(Response::from_parts(parts, axum::body::Body::from(enriched)))
    } else {
        Ok(Response::from_parts(parts, axum::body::Body::from(bytes)))
    }
}

/// Enrich messages with "source" field ("owner" or "system") based on tracked owner message IDs.
fn enrich_message_sources(messages: &mut Value, bot_id: &str) {
    let owner_ids = session_auth::OWNER_MESSAGES
        .get(bot_id)
        .map(|s| s.clone())
        .unwrap_or_default();

    let items = match messages {
        Value::Array(arr) => arr,
        Value::Object(obj) => {
            if let Some(Value::Array(arr)) = obj.get_mut("messages") {
                arr
            } else {
                return;
            }
        }
        _ => return,
    };

    for msg in items.iter_mut() {
        if let Value::Object(obj) = msg {
            // Try to get message ID from info.id or id
            let msg_id = obj
                .get("info")
                .and_then(|info| info.get("id"))
                .or_else(|| obj.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let source = if owner_ids.contains(&msg_id) {
                "owner"
            } else {
                "system"
            };
            obj.insert("source".to_string(), Value::String(source.to_string()));
        }
    }
}

#[derive(Deserialize)]
struct SendMessageBody {
    #[serde(flatten)]
    inner: Value,
}

async fn send_message(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<SendMessageBody>,
) -> Result<Response, (StatusCode, String)> {
    let token = extract_owner_token(&headers)?;
    let bot_id = session_auth::get_token_bot_id(&token).unwrap_or_default();

    let resp = proxy_to_sidecar(
        &state,
        reqwest::Method::POST,
        &format!("/agents/sessions/{id}/messages"),
        Some(body.inner),
        None,
    )
    .await?;

    // Track the message ID as owner-sent
    let (parts, resp_body) = resp.into_parts();
    let bytes = axum::body::to_bytes(resp_body, 1024 * 1024)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read response: {e}"),
            )
        })?;

    if let Ok(msg) = serde_json::from_slice::<Value>(&bytes) {
        let msg_id = msg
            .get("info")
            .and_then(|info| info.get("id"))
            .or_else(|| msg.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if !msg_id.is_empty() {
            session_auth::OWNER_MESSAGES
                .entry(bot_id)
                .or_default()
                .insert(msg_id);
        }
    }

    Ok(Response::from_parts(parts, axum::body::Body::from(bytes)))
}

// ── Abort ───────────────────────────────────────────────────────────────

async fn abort_session(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    extract_owner_token(&headers)?;
    proxy_to_sidecar(
        &state,
        reqwest::Method::POST,
        &format!("/agents/sessions/{id}/abort"),
        None,
        None,
    )
    .await
}

// ── SSE Events ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

async fn session_events(
    State(state): State<Arc<TradingApiState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    extract_owner_token(&headers)?;

    let mut url = format!("{}/agents/events", state.sidecar_url);
    if let Some(sid) = &params.session_id {
        url.push_str(&format!("?sessionId={sid}"));
    }

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if !state.sidecar_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", state.sidecar_token));
    }

    let resp = req
        .timeout(Duration::from_secs(3600))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("SSE proxy connect error: {e}");
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to connect to sidecar SSE: {e}"),
            )
        })?;

    if !resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Sidecar SSE returned status {}", resp.status()),
        ));
    }

    let byte_stream = resp.bytes_stream();

    // Parse SSE frames from the byte stream
    let event_stream = SseParser::new(byte_stream);

    Ok(Sse::new(event_stream).keep_alive(KeepAlive::default()))
}

/// Parses raw SSE byte stream into axum SSE events.
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
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
{
    type Item = Result<Event, Infallible>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();

        loop {
            // Check if we have a complete event in the buffer
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
                    } else if line.starts_with(':') {
                        // Comment — skip
                    }
                }

                if !data_parts.is_empty() {
                    let data = data_parts.join("\n");
                    let mut event = Event::default().data(data);
                    if let Some(et) = event_type {
                        event = event.event(et);
                    }
                    return std::task::Poll::Ready(Some(Ok(event)));
                }
                continue;
            }

            // Need more data from upstream
            match std::pin::Pin::new(&mut this.inner).poll_next(cx) {
                std::task::Poll::Ready(Some(Ok(bytes))) => {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        this.buffer.push_str(text);
                    }
                }
                std::task::Poll::Ready(Some(Err(_))) => {
                    return std::task::Poll::Ready(None);
                }
                std::task::Poll::Ready(None) => {
                    return std::task::Poll::Ready(None);
                }
                std::task::Poll::Pending => {
                    return std::task::Poll::Pending;
                }
            }
        }
    }
}

// ── Response types for documentation ────────────────────────────────────

#[derive(Serialize)]
#[allow(dead_code)]
struct SessionInfo {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
}
