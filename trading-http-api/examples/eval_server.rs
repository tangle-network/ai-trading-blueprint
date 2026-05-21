use std::sync::Arc;

use tokio::sync::RwLock;
use trading_http_api::{TradingApiState, build_router};
use trading_runtime::PortfolioState;
use trading_runtime::executor::TradeExecutor;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::validator_client::ValidatorClient;

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async_main());
}

async fn async_main() {
    let port: u16 = std::env::var("EVAL_TRADING_API_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(19101);
    let token = std::env::var("EVAL_TRADING_API_TOKEN")
        .unwrap_or_else(|_| "eval-real-api-token".to_string());
    let bot_id =
        std::env::var("EVAL_TRADING_BOT_ID").unwrap_or_else(|_| "eval-real-api-bot".to_string());
    let state_dir = std::env::var("BLUEPRINT_STATE_DIR").unwrap_or_else(|_| {
        let path =
            std::env::temp_dir().join(format!("trading-http-api-eval-{}", uuid::Uuid::new_v4()));
        path.to_string_lossy().into_owned()
    });
    // SAFETY: this example is single-threaded until the router starts.
    unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", &state_dir) };

    let state = Arc::new(TradingApiState {
        market_client: MarketDataClient::new(
            std::env::var("MARKET_DATA_BASE_URL")
                .unwrap_or_else(|_| "https://api.coingecko.com/api/v3".to_string()),
        ),
        validator_client: ValidatorClient::new(vec![], 0),
        min_validator_score: 0,
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            "http://127.0.0.1:8545",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            31337,
        )
        .expect("paper executor"),
        portfolio: RwLock::new(PortfolioState::default()),
        api_token: token.clone(),
        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
        validator_endpoints: vec![],
        validation_deadline_secs: 3600,
        bot_id: bot_id.clone(),
        paper_trade: true,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: None,
        chain_id: None,
        clob_client: None,
        strategy_config: serde_json::Value::Null,
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind eval trading API");
    eprintln!(
        "eval trading API listening on http://127.0.0.1:{port} bot_id={bot_id} token={token} state_dir={state_dir}"
    );
    axum::serve(listener, build_router(state))
        .await
        .expect("serve eval trading API");
}
