use crate::live_portfolio::{LiveRiskInput, reconcile_live_portfolio};
use crate::metrics_store;
use crate::{MultiBotTradingState, TradingApiState};
use axum::{Extension, Json, Router, extract::State, routing::post};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct CircuitBreakerRequest {
    pub max_drawdown_pct: Value,
}

#[derive(Serialize)]
pub struct CircuitBreakerResponse {
    pub should_break: bool,
    pub current_drawdown_pct: String,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/circuit-breaker/check", post(check))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/circuit-breaker/check", post(check_multi_bot))
        .route("/circuit-breaker/acknowledge", post(acknowledge_multi_bot))
}

/// Re-arm a tripped drawdown breaker by rebasing the risk baseline to current
/// NAV. The realized loss remains in snapshot history; only the reference
/// point for future drawdown moves. Without this, a breached bot is halted
/// permanently because the high-water mark never decreases.
async fn acknowledge_multi_bot(
    Extension(bot): Extension<crate::BotContext>,
) -> Result<Json<CircuitBreakerResponse>, (axum::http::StatusCode, String)> {
    let rebased = metrics_store::acknowledge_drawdown(&bot.bot_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if rebased.is_none() {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            "no metrics snapshot to rebase".to_string(),
        ));
    }
    Ok(Json(CircuitBreakerResponse {
        should_break: false,
        current_drawdown_pct: "0".to_string(),
    }))
}

fn parse_max_drawdown_pct(value: &Value) -> Result<Decimal, (axum::http::StatusCode, String)> {
    match value {
        Value::String(s) => s.parse().map_err(|e| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                format!("Invalid max_drawdown_pct: {e}"),
            )
        }),
        Value::Number(n) => n.to_string().parse().map_err(|e| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                format!("Invalid max_drawdown_pct: {e}"),
            )
        }),
        _ => Err((
            axum::http::StatusCode::BAD_REQUEST,
            "max_drawdown_pct must be a string or number".to_string(),
        )),
    }
}

async fn check(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<CircuitBreakerRequest>,
) -> Result<Json<CircuitBreakerResponse>, (axum::http::StatusCode, String)> {
    let max_drawdown = parse_max_drawdown_pct(&request.max_drawdown_pct)?;

    if !state.paper_trade {
        let input = LiveRiskInput::from_state(&state)?;
        let snapshot = reconcile_live_portfolio(&input).await?;
        return Ok(Json(CircuitBreakerResponse {
            should_break: snapshot.drawdown_pct >= max_drawdown,
            current_drawdown_pct: snapshot.drawdown_pct.to_string(),
        }));
    }

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

async fn check_multi_bot(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<crate::BotContext>,
    Json(request): Json<CircuitBreakerRequest>,
) -> Result<Json<CircuitBreakerResponse>, (axum::http::StatusCode, String)> {
    let max_drawdown = parse_max_drawdown_pct(&request.max_drawdown_pct)?;
    if !bot.paper_trade {
        let input = LiveRiskInput::from_bot(&bot, &state.market_data_base_url);
        let snapshot = reconcile_live_portfolio(&input).await?;
        return Ok(Json(CircuitBreakerResponse {
            should_break: snapshot.drawdown_pct >= max_drawdown,
            current_drawdown_pct: snapshot.drawdown_pct.to_string(),
        }));
    }

    let current_drawdown = metrics_store::latest_snapshot_for_bot(&bot.bot_id)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
        .and_then(|snapshot| snapshot.drawdown_pct.parse::<Decimal>().ok())
        .unwrap_or(Decimal::ZERO);

    Ok(Json(CircuitBreakerResponse {
        should_break: current_drawdown >= max_drawdown,
        current_drawdown_pct: current_drawdown.to_string(),
    }))
}
