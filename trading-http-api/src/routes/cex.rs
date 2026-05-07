//! Generalized CEX trading routes.
//!
//! Each route resolves the `{venue}` path parameter to a `DirectApiVenue`
//! client constructed from operator-provided env vars (the same secrets
//! pipeline used for AI keys and Hyperliquid). Clients are cached per-bot
//! per-venue so we don't pay TLS handshake / PEM parsing on every request.
//!
//! Live trades are gated by the same off-chain `apply_envelope_checks` that
//! Hyperliquid uses (see `routes::execute`); here we surface the bare CEX
//! REST surface for paper trading and read-only flows. Signed-envelope live
//! trading is wired in via `execute.rs` once an `ACTION_KIND_CEX_ORDER` lands.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;

use trading_runtime::cex::binance::{BinanceClient, BinanceConfig};
use trading_runtime::cex::coinbase::{CoinbaseClient, CoinbaseConfig};
use trading_runtime::cex::{
    CexAccountInfo, CexOpenOrder, CexOrderRequest, CexOrderResponse, CexTicker, DirectApiVenue,
};

use crate::{BotContext, MultiBotTradingState};

// ── Per-(bot,venue) client cache ────────────────────────────────────────────

type ClientCacheKey = (String, &'static str);
type ClientCache = HashMap<ClientCacheKey, Arc<dyn DirectApiVenue>>;

fn client_cache() -> &'static Mutex<ClientCache> {
    static CACHE: OnceLock<Mutex<ClientCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_venue(
    venue: &str,
    bot: &BotContext,
) -> Result<Arc<dyn DirectApiVenue>, (StatusCode, String)> {
    let normalized = venue.to_ascii_lowercase();
    let static_id: &'static str = match normalized.as_str() {
        "binance" => "binance",
        "coinbase" => "coinbase",
        other => {
            return Err((
                StatusCode::NOT_FOUND,
                format!("unknown CEX venue '{other}'"),
            ));
        }
    };

    let key = (bot.bot_id.clone(), static_id);
    if let Ok(cache) = client_cache().lock() {
        if let Some(client) = cache.get(&key) {
            return Ok(client.clone());
        }
    }

    let client: Arc<dyn DirectApiVenue> = match static_id {
        "binance" => Arc::new(
            BinanceClient::new(BinanceConfig::from_env().map_err(<(StatusCode, String)>::from)?)
                .map_err(<(StatusCode, String)>::from)?,
        ),
        "coinbase" => Arc::new(
            CoinbaseClient::new(CoinbaseConfig::from_env().map_err(<(StatusCode, String)>::from)?)
                .map_err(<(StatusCode, String)>::from)?,
        ),
        _ => unreachable!("guarded above"),
    };

    if let Ok(mut cache) = client_cache().lock() {
        cache.insert(key, client.clone());
    }
    Ok(client)
}

// ── Live-trade guard ────────────────────────────────────────────────────────

fn reject_live_direct_cex(venue: &str, bot: &BotContext) -> Result<(), (StatusCode, String)> {
    if bot.paper_trade {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        format!(
            "Live CEX direct routes are disabled for {venue}; live trades must flow through /execute so PerTrade or signed Envelope authorization can be verified"
        ),
    ))
}

// ── Request/response wrappers ───────────────────────────────────────────────

#[derive(Deserialize)]
struct CancelOrderQuery {
    symbol: String,
    venue_order_id: String,
}

#[derive(Deserialize)]
struct OpenOrdersQuery {
    #[serde(default)]
    symbol: Option<String>,
}

#[derive(Deserialize)]
struct TickerQuery {
    symbol: String,
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn place_order(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(venue): Path<String>,
    Extension(bot): Extension<BotContext>,
    Json(req): Json<CexOrderRequest>,
) -> Result<Json<CexOrderResponse>, (StatusCode, String)> {
    reject_live_direct_cex(&venue, &bot)?;
    let client = resolve_venue(&venue, &bot)?;
    let resp = client
        .place_order(&req)
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(resp))
}

async fn cancel_order(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(venue): Path<String>,
    Extension(bot): Extension<BotContext>,
    Query(q): Query<CancelOrderQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    reject_live_direct_cex(&venue, &bot)?;
    let client = resolve_venue(&venue, &bot)?;
    client
        .cancel_order(&q.symbol, &q.venue_order_id)
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_account(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(venue): Path<String>,
    Extension(bot): Extension<BotContext>,
) -> Result<Json<CexAccountInfo>, (StatusCode, String)> {
    let client = resolve_venue(&venue, &bot)?;
    let info = client
        .get_account()
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(info))
}

async fn get_open_orders(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(venue): Path<String>,
    Extension(bot): Extension<BotContext>,
    Query(q): Query<OpenOrdersQuery>,
) -> Result<Json<Vec<CexOpenOrder>>, (StatusCode, String)> {
    let client = resolve_venue(&venue, &bot)?;
    let orders = client
        .get_open_orders(q.symbol.as_deref())
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(orders))
}

async fn get_ticker(
    State(_state): State<Arc<MultiBotTradingState>>,
    Path(venue): Path<String>,
    Extension(bot): Extension<BotContext>,
    Query(q): Query<TickerQuery>,
) -> Result<Json<CexTicker>, (StatusCode, String)> {
    let client = resolve_venue(&venue, &bot)?;
    let ticker = client
        .get_ticker(&q.symbol)
        .await
        .map_err(<(StatusCode, String)>::from)?;
    Ok(Json(ticker))
}

// ── Router ──────────────────────────────────────────────────────────────────

pub fn multi_bot_router() -> Router<Arc<MultiBotTradingState>> {
    Router::new()
        .route("/cex/{venue}/order", post(place_order))
        .route("/cex/{venue}/order", delete(cancel_order))
        .route("/cex/{venue}/account", get(get_account))
        .route("/cex/{venue}/orders", get(get_open_orders))
        .route("/cex/{venue}/ticker", get(get_ticker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_unknown_venue_returns_404() {
        let bot = BotContext {
            bot_id: "test".into(),
            vault_address: "0x".into(),
            paper_trade: true,
            chain_id: 1,
            rpc_url: "http://localhost".into(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        };
        let err = match resolve_venue("kraken", &bot) {
            Ok(_) => panic!("unknown venue should 404"),
            Err(e) => e,
        };
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert!(err.1.contains("kraken"));
    }

    #[test]
    fn reject_live_direct_cex_blocks_live_bot() {
        let mut bot = BotContext {
            bot_id: "live".into(),
            vault_address: "0x".into(),
            paper_trade: false,
            chain_id: 1,
            rpc_url: "http://localhost".into(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec![],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        };
        assert!(reject_live_direct_cex("binance", &bot).is_err());
        bot.paper_trade = true;
        assert!(reject_live_direct_cex("binance", &bot).is_ok());
    }
}
