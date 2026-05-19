use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::Serialize;
use std::sync::Arc;

use crate::hyperliquid_nav::{self, HyperliquidNavSnapshot, reconcile_hyperliquid_nav};
use crate::{BotContext, MultiBotTradingState};

#[derive(Debug, Serialize)]
pub struct HyperliquidNavResponse {
    pub snapshot: HyperliquidNavSnapshot,
    pub stale: bool,
}

async fn get_nav(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<HyperliquidNavResponse>, (StatusCode, String)> {
    match hyperliquid_nav::latest_snapshot_for_bot(&bot.bot_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        Some(snapshot) if !snapshot.is_stale_at(Utc::now()) => Ok(Json(HyperliquidNavResponse {
            snapshot,
            stale: false,
        })),
        _ => post_nav(State(state), Extension(bot)).await,
    }
}

async fn post_nav(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<HyperliquidNavResponse>, (StatusCode, String)> {
    let snapshot = reconcile_hyperliquid_nav(&state, &bot).await?;
    Ok(Json(HyperliquidNavResponse {
        snapshot,
        stale: false,
    }))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/hyperliquid/nav", get(get_nav).post(post_nav))
}
