pub mod auth;
pub mod routes;

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
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state)
}
