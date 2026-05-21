use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::hyperliquid_settlement::{
    self, HyperliquidSettlementAttempt, HyperliquidSettlementState,
};
use crate::{BotContext, MultiBotTradingState};

#[derive(Debug, Serialize)]
pub struct HyperliquidSettlementResponse {
    pub state: HyperliquidSettlementState,
}

#[derive(Debug, Serialize)]
pub struct HyperliquidSettlementRunResponse {
    pub attempt: HyperliquidSettlementAttempt,
}

async fn get_settlement(
    Extension(bot): Extension<BotContext>,
) -> Result<Json<HyperliquidSettlementResponse>, (StatusCode, String)> {
    let state = hyperliquid_settlement::settlement_state(&bot).await?;
    Ok(Json(HyperliquidSettlementResponse { state }))
}

async fn run_settlement(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<HyperliquidSettlementRunResponse>, (StatusCode, String)> {
    let attempt = hyperliquid_settlement::run_settlement(&state, &bot).await?;
    Ok(Json(HyperliquidSettlementRunResponse { attempt }))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/hyperliquid/settlement", get(get_settlement))
        .route("/hyperliquid/settlement/run", post(run_settlement))
}
