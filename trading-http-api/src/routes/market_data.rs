use crate::live_portfolio::{LiveRiskInput, resolve_live_token_usd_valuation};
use crate::{BotContext, MultiBotTradingState, TradingApiState};
use alloy::primitives::U256;
use axum::{Extension, Json, Router, extract::State, http::StatusCode, routing::post};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::supported_assets::{
    SupportedAsset, default_protocol_for_strategy, supported_assets_for_config,
};

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

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new().route("/market-data/prices", post(get_prices_multi_bot))
}

async fn get_prices(
    State(state): State<Arc<TradingApiState>>,
    Json(request): Json<PricesRequest>,
) -> Result<Json<PricesResponse>, (StatusCode, String)> {
    let prices = state
        .market_client
        .get_prices(&request.tokens)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let entries = prices
        .into_iter()
        .map(|p| PriceEntry {
            token: p.token,
            price_usd: p.price_usd.to_string(),
            source: p.source,
        })
        .collect();

    Ok(Json(PricesResponse { prices: entries }))
}

async fn get_prices_multi_bot(
    State(state): State<Arc<MultiBotTradingState>>,
    Extension(bot): Extension<BotContext>,
    Json(request): Json<PricesRequest>,
) -> Result<Json<PricesResponse>, (StatusCode, String)> {
    let client = MarketDataClient::new(state.market_data_base_url.clone());
    let protocol_chain_id =
        crate::protocol_chain_id_from_config(bot.chain_id, &bot.strategy_config);
    let configured_assets = configured_assets_for_bot(&bot, protocol_chain_id);
    let live_input =
        (!bot.paper_trade).then(|| LiveRiskInput::from_bot(&bot, &state.market_data_base_url));
    let prices = client
        .get_prices_for_chain(Some(protocol_chain_id), &request.tokens)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(
                error = %error,
                tokens = ?request.tokens,
                "Market data batch lookup failed; trying configured asset fallbacks"
            );
            Vec::new()
        });

    let entries = prices
        .into_iter()
        .map(|p| PriceEntry {
            token: p.token,
            price_usd: p.price_usd.to_string(),
            source: p.source,
        })
        .collect::<Vec<_>>();
    let entries = fill_configured_asset_price_gaps(
        &client,
        protocol_chain_id,
        &request.tokens,
        entries,
        &configured_assets,
        live_input.as_ref(),
    )
    .await;

    Ok(Json(PricesResponse { prices: entries }))
}

fn configured_assets_for_bot(bot: &BotContext, protocol_chain_id: u64) -> Vec<SupportedAsset> {
    let strategy_type = bot
        .strategy_config
        .get("strategy_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("dex");
    let Some(protocol) = default_protocol_for_strategy(strategy_type) else {
        return Vec::new();
    };

    supported_assets_for_config(
        strategy_type,
        protocol_chain_id,
        protocol,
        Some(&bot.strategy_config),
    )
}

async fn fill_configured_asset_price_gaps(
    client: &MarketDataClient,
    protocol_chain_id: u64,
    requested_tokens: &[String],
    mut entries: Vec<PriceEntry>,
    configured_assets: &[SupportedAsset],
    live_input: Option<&LiveRiskInput>,
) -> Vec<PriceEntry> {
    for requested in requested_tokens {
        if has_price_entry(&entries, requested) {
            continue;
        }

        let Some(asset) = configured_asset_for_token(configured_assets, requested) else {
            continue;
        };

        if let Some(entry) =
            price_configured_asset_from_market_data(client, protocol_chain_id, requested, asset)
                .await
        {
            entries.push(entry);
            continue;
        }

        if let Some(live_input) = live_input {
            if let Some(entry) =
                price_configured_asset_from_live_valuation(live_input, requested, asset).await
            {
                entries.push(entry);
            }
        }
    }

    entries
}

async fn price_configured_asset_from_market_data(
    client: &MarketDataClient,
    protocol_chain_id: u64,
    requested: &str,
    asset: &SupportedAsset,
) -> Option<PriceEntry> {
    for token in [&asset.address, &asset.symbol] {
        if normalize_token(token) == normalize_token(requested) {
            continue;
        }
        if let Ok(price) = client
            .get_price_for_chain(Some(protocol_chain_id), token)
            .await
        {
            return Some(PriceEntry {
                token: requested.to_string(),
                price_usd: price.price_usd.to_string(),
                source: price.source,
            });
        }
    }

    None
}

async fn price_configured_asset_from_live_valuation(
    live_input: &LiveRiskInput,
    requested: &str,
    asset: &SupportedAsset,
) -> Option<PriceEntry> {
    let one_token_raw = U256::from(10u64).pow(U256::from(asset.decimals));
    resolve_live_token_usd_valuation(live_input, &asset.address, one_token_raw, asset.decimals)
        .await
        .map(|valuation| PriceEntry {
            token: requested.to_string(),
            price_usd: valuation.price_usd.to_string(),
            source: "live_vault_valuation_adapter".to_string(),
        })
}

fn has_price_entry(entries: &[PriceEntry], token: &str) -> bool {
    let key = normalize_token(token);
    entries
        .iter()
        .any(|entry| normalize_token(&entry.token) == key)
}

fn configured_asset_for_token<'a>(
    assets: &'a [SupportedAsset],
    token: &str,
) -> Option<&'a SupportedAsset> {
    let key = normalize_token(token);
    assets.iter().find(|asset| {
        normalize_token(&asset.symbol) == key || normalize_token(&asset.address) == key
    })
}

fn normalize_token(token: &str) -> String {
    token.trim().to_ascii_lowercase()
}
