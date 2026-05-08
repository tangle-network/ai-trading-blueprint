//! WebSocket endpoint for the real-time NAV stream.
//!
//! `GET /v1/ws/nav?vault=<address>&chainId=<id>` upgrades the connection,
//! looks up (or spawns) the per-vault [`NavHub`], and forwards
//! [`NavMessage`]s as JSON text frames. The connection emits a heartbeat
//! every [`HEARTBEAT_INTERVAL_SECS`] so clients can detect liveness without
//! parsing application-level traffic.
//!
//! ### Why this is mounted on the outer router
//!
//! Bearer-token auth in axum middleware doesn't compose cleanly with WS
//! upgrades — many clients (browsers especially) cannot set arbitrary
//! `Authorization` headers on `WebSocket(...)`. Mounting on the outer
//! router (alongside `/metrics`) keeps the surface obvious and matches the
//! existing pattern. Adding an opt-in token query param (`token=…`) is a
//! follow-up; today the stream is read-only NAV which is already public on
//! chain.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::{Router, routing::get};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{Duration, interval};
use tracing::{debug, info, warn};

use crate::nav_stream::{
    HEARTBEAT_INTERVAL_SECS, NavHub, NavHubRegistry, NavMessage, NavStreamConfig, SourceFactoryFn,
    VaultKey,
};

/// Builds the WS router. The handler reaches the registry via
/// `NavStreamConfig`, so this can be merged into either the per-bot or
/// multi-bot router. The binary owns lifecycle — see [`NavStreamConfig`].
pub fn router(config: NavStreamConfig) -> Router {
    Router::new()
        .route("/v1/ws/nav", get(nav_ws_handler))
        .with_state(config)
}

#[derive(Debug, Deserialize)]
pub struct NavQuery {
    pub vault: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
}

async fn nav_ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<NavQuery>,
    State(config): State<NavStreamConfig>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    if !looks_like_evm_address(&params.vault) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "vault query parameter must be a 0x-prefixed 40-hex-char address, got '{}'",
                params.vault
            ),
        ));
    }
    if params.chain_id == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "chainId query parameter must be a positive integer".to_string(),
        ));
    }

    let key = VaultKey::new(&params.vault, params.chain_id);

    // Build the hub eagerly so `on_upgrade` only does the cheap subscribe.
    let registry = config.registry.clone();
    let factory = Arc::clone(&config.source_factory);
    let key_for_factory = key.clone();
    let hub = match build_or_get_hub(&registry, &factory, key_for_factory) {
        Ok(hub) => hub,
        Err(e) => {
            warn!(vault = %params.vault, error = %e, "nav-ws: source factory failed");
            return Err((StatusCode::SERVICE_UNAVAILABLE, e));
        }
    };

    let registry_for_drop = registry.clone();
    let hub_for_drop = hub.clone();
    let key_for_drop = key.clone();

    Ok(ws.on_upgrade(move |socket| async move {
        run_socket(socket, hub).await;
        // Tear down the hub when the last subscriber leaves.
        if hub_for_drop.decrement_subscriber() == 0 {
            registry_for_drop.remove_if_idle(&key_for_drop);
        }
    }))
}

fn build_or_get_hub(
    registry: &NavHubRegistry,
    factory: &Arc<SourceFactoryFn>,
    key: VaultKey,
) -> Result<Arc<NavHub>, String> {
    if let Some(existing) = registry.get(&key) {
        return Ok(existing);
    }
    let pair = factory(&key)?;
    Ok(registry.get_or_spawn(key, move || pair))
}

async fn run_socket(socket: WebSocket, hub: Arc<NavHub>) {
    let (mut sender, mut receiver) = socket.split();

    let (mut rx, snapshot) = hub.subscribe().await;

    if let Some(snapshot) = snapshot
        && let Err(e) = send_message(&mut sender, &snapshot).await
    {
        debug!(error = %e, "nav-ws: client closed before snapshot delivery");
        return;
    }

    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
    // Skip the first immediate tick — the snapshot is enough.
    heartbeat.tick().await;

    info!(vault = %hub.key().vault, chain_id = hub.key().chain_id, "nav-ws: subscriber connected");

    loop {
        tokio::select! {
            biased;

            // Drain client messages so close + ping handling work; we don't
            // expect application-level frames from the client today.
            client_msg = receiver.next() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        debug!(error = %e, "nav-ws: client read error; closing");
                        break;
                    }
                }
            }

            broadcast = rx.recv() => {
                match broadcast {
                    Ok(msg) => {
                        if let Err(e) = send_message(&mut sender, &msg).await {
                            debug!(error = %e, "nav-ws: send failed; closing");
                            break;
                        }
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        warn!(
                            skipped = skipped,
                            vault = %hub.key().vault,
                            "nav-ws: subscriber lagged; dropping messages"
                        );
                        // Re-send the latest snapshot so the lagged client
                        // catches up to a coherent state.
                        let (new_rx, snapshot) = hub.subscribe().await;
                        // We're effectively re-subscribing: bump-down the
                        // duplicate count we just added.
                        hub.decrement_subscriber();
                        rx = new_rx;
                        if let Some(snapshot) = snapshot
                            && send_message(&mut sender, &snapshot).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }

            _ = heartbeat.tick() => {
                let beat = NavMessage::Heartbeat { ts: chrono::Utc::now().timestamp() };
                if let Err(e) = send_message(&mut sender, &beat).await {
                    debug!(error = %e, "nav-ws: heartbeat send failed; closing");
                    break;
                }
            }
        }
    }

    debug!(vault = %hub.key().vault, "nav-ws: subscriber disconnected");
}

// `WebSocket` is `Stream + Sink<Message>`; we use the futures-util split.
use futures_util::{SinkExt, StreamExt, stream::SplitSink};

async fn send_message(
    sender: &mut SplitSink<WebSocket, Message>,
    msg: &NavMessage,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(msg).map_err(axum::Error::new)?;
    sender.send(Message::Text(payload.into())).await
}

fn looks_like_evm_address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_vault_addresses() {
        assert!(!looks_like_evm_address(""));
        assert!(!looks_like_evm_address("0x123"));
        assert!(!looks_like_evm_address(
            "0x000000000000000000000000000000000000000g"
        ));
        assert!(looks_like_evm_address(
            "0x1234567890abcdef1234567890ABCDEF12345678"
        ));
    }
}
