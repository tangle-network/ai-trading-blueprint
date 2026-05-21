use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::hyperliquid_mode::{self, HyperliquidModeSnapshot};
use crate::{BotContext, MultiBotTradingState};

#[derive(Debug, Serialize)]
pub struct HyperliquidModeResponse {
    pub snapshot: HyperliquidModeSnapshot,
}

async fn get_mode(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<HyperliquidModeResponse>, (StatusCode, String)> {
    let snapshot =
        hyperliquid_mode::evaluate_hyperliquid_mode_with_nav_refresh(&state, &bot).await?;
    Ok(Json(HyperliquidModeResponse { snapshot }))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/hyperliquid/mode", get(get_mode))
}
