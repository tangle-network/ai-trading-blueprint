use crate::TradingApiState;
use axum::{Json, Router, routing::get};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}
