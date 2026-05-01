use crate::TradingApiState;
use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/health", get(health))
}

fn looks_like_address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        && value != "0x0000000000000000000000000000000000000000"
}

async fn health(State(state): State<Arc<TradingApiState>>) -> Json<Value> {
    let mode = if state.paper_trade { "paper" } else { "live" };
    let rpc_ready = state
        .rpc_url
        .as_ref()
        .is_some_and(|url| !url.trim().is_empty());
    let validator_count = state.validator_endpoints.len();
    let validator_quorum_ready = state.paper_trade || validator_count > 0;
    let simulation_ready = state.paper_trade || rpc_ready;
    let vault_ready = state.paper_trade || looks_like_address(&state.vault_address);
    let ready = validator_quorum_ready && simulation_ready && vault_ready;

    Json(json!({
        "status": if ready { "ok" } else { "degraded" },
        "mode": mode,
        "rpc_ready": rpc_ready,
        "validator_count": validator_count,
        "validator_quorum_ready": validator_quorum_ready,
        "simulation_ready": simulation_ready,
        "vault_ready": vault_ready,
    }))
}
