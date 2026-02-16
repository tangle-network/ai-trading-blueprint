use axum::{Router, routing::get, Json};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::TradingApiState;

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}
