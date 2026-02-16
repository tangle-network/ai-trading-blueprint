use axum::{Router, routing::post, extract::State, Json};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::TradingApiState;

#[derive(Deserialize)]
pub struct CircuitBreakerRequest {
    pub max_drawdown_pct: String,
}

#[derive(Serialize)]
pub struct CircuitBreakerResponse {
    pub should_break: bool,
    pub current_drawdown_pct: String,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/circuit-breaker/check", post(check))
}

async fn check(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<CircuitBreakerRequest>,
) -> Result<Json<CircuitBreakerResponse>, (axum::http::StatusCode, String)> {
    let max_drawdown: Decimal = request.max_drawdown_pct.parse()
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, format!("Invalid max_drawdown_pct: {e}")))?;

    let portfolio = state.portfolio.read().await;
    let should_break = portfolio.should_circuit_break(max_drawdown);

    // Calculate current drawdown from high water mark
    let total_with_realized = portfolio.total_value_usd + portfolio.realized_pnl;
    let drawdown = if portfolio.high_water_mark > Decimal::ZERO
        && portfolio.high_water_mark > total_with_realized
    {
        (portfolio.high_water_mark - total_with_realized) / portfolio.high_water_mark
            * Decimal::new(100, 0)
    } else {
        Decimal::ZERO
    };

    Ok(Json(CircuitBreakerResponse {
        should_break,
        current_drawdown_pct: drawdown.to_string(),
    }))
}
