pub mod auth;
pub mod routes;
pub mod session_auth;
pub mod trade_store;
pub mod metrics_store;

use std::sync::Arc;
use tokio::sync::RwLock;
use axum::Router;

use trading_runtime::executor::TradeExecutor;
use trading_runtime::validator_client::ValidatorClient;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::PortfolioState;

pub struct TradingApiState {
    pub market_client: MarketDataClient,
    pub validator_client: ValidatorClient,
    pub executor: TradeExecutor,
    pub portfolio: RwLock<PortfolioState>,
    pub api_token: String,
    pub vault_address: String,
    pub validator_endpoints: Vec<String>,
    pub validation_deadline_secs: u64,
    /// Bot ID that owns this API instance.
    pub bot_id: String,
    /// Paper trading mode — trades are logged but not executed on-chain.
    pub paper_trade: bool,
    /// Wallet address of the bot owner (for session auth verification).
    pub operator_address: String,
    /// Address of the user who provisioned this bot (for session auth).
    #[allow(dead_code)]
    pub submitter_address: String,
    /// Sidecar container base URL (e.g. "http://localhost:8080").
    pub sidecar_url: String,
    /// Bearer token for authenticating with the sidecar API.
    pub sidecar_token: String,
}

pub fn build_router(state: Arc<TradingApiState>) -> Router {
    Router::new()
        .merge(routes::health::router())
        .merge(routes::market_data::router())
        .merge(routes::portfolio::router())
        .merge(routes::validate::router())
        .merge(routes::execute::router())
        .merge(routes::circuit::router())
        .merge(routes::adapters::router())
        .merge(routes::metrics::router())
        .merge(routes::trades::router())
        .merge(routes::session::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
        .with_state(state)
}

/// Resolved bot context for per-request state in multi-bot mode.
///
/// This is a lightweight struct that doesn't depend on `trading-blueprint-lib`.
/// The auth middleware resolves a bot by token and inserts this into extensions.
#[derive(Clone, Debug)]
pub struct BotContext {
    pub bot_id: String,
    pub vault_address: String,
    pub paper_trade: bool,
    pub chain_id: u64,
    pub rpc_url: String,
    pub validator_endpoints: Vec<String>,
}

/// Shared state for the multi-bot trading HTTP API.
///
/// Unlike `TradingApiState` (per-bot), this holds operator-level config.
/// Per-bot fields (vault_address, api_token, etc.) are resolved per-request
/// by the auth middleware via `resolve_bot`.
pub struct MultiBotTradingState {
    /// Operator private key for signing transactions (hex-encoded).
    pub operator_private_key: String,
    /// Market data API base URL (e.g., CoinGecko).
    pub market_data_base_url: String,
    /// Default validation deadline in seconds.
    pub validation_deadline_secs: u64,
    /// Minimum validator score for trade approval.
    pub min_validator_score: u32,
    /// Resolves a bearer token into a BotContext. Injected by the binary.
    pub resolve_bot: Box<dyn Fn(&str) -> Option<BotContext> + Send + Sync>,
}

/// Build a multi-bot trading HTTP API router.
///
/// This serves `/validate`, `/execute`, and `/health` for ALL bots.
/// The auth middleware resolves the calling bot from the bearer token and
/// injects the bot record into request extensions.
pub fn build_multi_bot_router(state: Arc<MultiBotTradingState>) -> Router {
    use axum::routing::get;
    Router::new()
        .route("/health", get(|| async {
            axum::Json(serde_json::json!({"status": "ok"}))
        }))
        .merge(routes::validate::multi_bot_router())
        .merge(routes::execute::multi_bot_router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::multi_bot_auth_middleware,
        ))
        .layer(sandbox_runtime::operator_api::build_cors_layer())
        .with_state(state)
}
