pub mod auth;
pub mod routes;
pub mod session_auth;
pub mod trade_store;
pub mod metrics_store;

use std::sync::Arc;
use tokio::sync::RwLock;
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

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

fn cors_layer() -> CorsLayer {
    let origins = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_default();
    if origins == "*" || origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let parsed: Vec<_> = origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(parsed)
            .allow_methods(Any)
            .allow_headers(Any)
    }
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
        .layer(cors_layer())
        .with_state(state)
}
