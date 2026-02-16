use axum::{Router, routing::get, Json};
use serde::Serialize;
use std::sync::Arc;
use crate::TradingApiState;

#[derive(Serialize)]
pub struct AdaptersResponse {
    pub adapters: Vec<String>,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/adapters", get(list_adapters))
}

async fn list_adapters() -> Json<AdaptersResponse> {
    Json(AdaptersResponse {
        adapters: vec![
            "uniswap_v3".into(),
            "aave_v3".into(),
            "gmx_v2".into(),
            "morpho".into(),
            "vertex".into(),
            "polymarket".into(),
        ],
    })
}
