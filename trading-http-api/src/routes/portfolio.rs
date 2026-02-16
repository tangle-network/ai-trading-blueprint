use axum::{Router, routing::post, extract::State, Json};
use serde::Serialize;
use std::sync::Arc;
use crate::TradingApiState;

#[derive(Serialize)]
pub struct PortfolioResponse {
    pub positions: Vec<PositionEntry>,
    pub total_value_usd: String,
    pub unrealized_pnl: String,
    pub realized_pnl: String,
}

#[derive(Serialize)]
pub struct PositionEntry {
    pub token: String,
    pub amount: String,
    pub entry_price: String,
    pub current_price: String,
    pub unrealized_pnl: String,
    pub protocol: String,
    pub position_type: String,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/portfolio/state", post(get_state))
}

async fn get_state(
    State(state): State<Arc<TradingApiState>>,
) -> Json<PortfolioResponse> {
    let portfolio = state.portfolio.read().await;
    let entries: Vec<PositionEntry> = portfolio.positions.iter().map(|p| PositionEntry {
        token: p.token.clone(),
        amount: p.amount.to_string(),
        entry_price: p.entry_price.to_string(),
        current_price: p.current_price.to_string(),
        unrealized_pnl: p.unrealized_pnl.to_string(),
        protocol: p.protocol.clone(),
        position_type: serde_json::to_value(&p.position_type)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| format!("{:?}", p.position_type)),
    }).collect();

    Json(PortfolioResponse {
        total_value_usd: portfolio.total_value_usd.to_string(),
        unrealized_pnl: portfolio.unrealized_pnl.to_string(),
        realized_pnl: portfolio.realized_pnl.to_string(),
        positions: entries,
    })
}
