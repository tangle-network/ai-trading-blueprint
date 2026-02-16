use axum::{Router, routing::post, extract::State, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::TradingApiState;

#[derive(Deserialize)]
pub struct PricesRequest {
    pub tokens: Vec<String>,
}

#[derive(Serialize)]
pub struct PricesResponse {
    pub prices: Vec<PriceEntry>,
}

#[derive(Serialize)]
pub struct PriceEntry {
    pub token: String,
    pub price_usd: String,
    pub source: String,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/market-data/prices", post(get_prices))
}

async fn get_prices(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<PricesRequest>,
) -> Result<Json<PricesResponse>, (axum::http::StatusCode, String)> {
    let prices = state.market_client.get_prices(&request.tokens).await
        .map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, e.to_string()))?;

    let entries = prices.into_iter().map(|p| PriceEntry {
        token: p.token,
        price_usd: p.price_usd.to_string(),
        source: p.source,
    }).collect();

    Ok(Json(PricesResponse { prices: entries }))
}
