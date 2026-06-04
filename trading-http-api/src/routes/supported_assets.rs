use crate::{MultiBotTradingState, TradingApiState};
use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing::get};
use serde::Deserialize;
use std::sync::Arc;
use trading_runtime::supported_assets::{
    default_protocol_for_strategy, supported_assets_for_config,
};

#[derive(Debug, Deserialize)]
struct SupportedAssetsQuery {
    #[serde(default)]
    strategy_type: Option<String>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    chain_id: Option<u64>,
}

pub fn router() -> Router<Arc<TradingApiState>> {
    Router::new().route("/supported-assets", get(supported_assets))
}

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/supported-assets", get(supported_assets_multi_bot))
}

fn strategy_type_for_protocol(protocol: &str) -> Option<&'static str> {
    match protocol {
        "uniswap_v3" | "aerodrome" => Some("dex"),
        "aave_v3" | "morpho_vault" => Some("yield"),
        "polymarket_clob" => Some("prediction"),
        "hyperliquid" => Some("hyperliquid_perp"),
        _ => None,
    }
}

async fn supported_assets(
    State(state): State<Arc<TradingApiState>>,
    Query(query): Query<SupportedAssetsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let chain_id = query
        .chain_id
        .or_else(|| state.chain_id.map(crate::protocol_chain_id_from_env))
        .unwrap_or(1);
    let strategy_type = query.strategy_type.as_deref().unwrap_or("dex");
    let protocol = query
        .protocol
        .as_deref()
        .or_else(|| default_protocol_for_strategy(strategy_type))
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "strategy_type or protocol is required".to_string(),
            )
        })?;

    // Pass the bot's strategy_config through so a configured asset universe
    // (when populated by the bin) is honored. Falls back to the default-asset
    // registry when strategy_config is Value::Null — same semantics as the
    // multi-bot endpoint.
    Ok(Json(serde_json::json!({
        "strategy_type": strategy_type,
        "chain_id": chain_id,
        "protocol": protocol,
        "assets": supported_assets_for_config(
            strategy_type,
            chain_id,
            protocol,
            Some(&state.strategy_config),
        ),
    })))
}

async fn supported_assets_multi_bot(
    State(_state): State<Arc<MultiBotTradingState>>,
    Query(query): Query<SupportedAssetsQuery>,
    request: Request,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bot = request
        .extensions()
        .get::<crate::BotContext>()
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Bot context not resolved — check auth middleware".into(),
            )
        })?;
    let configured_strategy = bot
        .strategy_config
        .get("strategy_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("dex");
    let requested_protocol = query.protocol.as_deref();
    let strategy_type = query
        .strategy_type
        .as_deref()
        .or_else(|| requested_protocol.and_then(strategy_type_for_protocol))
        .unwrap_or(configured_strategy);
    let protocol = query
        .protocol
        .as_deref()
        .or_else(|| default_protocol_for_strategy(strategy_type))
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "strategy_type or protocol is required".to_string(),
            )
        })?;
    let chain_id = query.chain_id.unwrap_or_else(|| {
        crate::protocol_chain_id_for_protocol_from_config(
            bot.chain_id,
            &bot.strategy_config,
            protocol,
        )
    });

    Ok(Json(serde_json::json!({
        "bot_id": bot.bot_id,
        "strategy_type": strategy_type,
        "chain_id": chain_id,
        "protocol": protocol,
        "assets": supported_assets_for_config(strategy_type, chain_id, protocol, Some(&bot.strategy_config)),
    })))
}
