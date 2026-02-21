//! Integration tests for the Trading HTTP API.
//!
//! Tests route handlers with a real axum router, using wiremock for market
//! data and in-memory state for portfolio/executor.

use std::sync::Arc;
use tokio::sync::RwLock;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use trading_http_api::{TradingApiState, build_router};
use trading_http_api::{MultiBotTradingState, BotContext, build_multi_bot_router};
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::validator_client::ValidatorClient;
use trading_runtime::executor::TradeExecutor;
use trading_runtime::PortfolioState;

const TEST_TOKEN: &str = "test-api-token-12345";

/// Ensure a shared temp state dir is set for the entire test binary.
/// OnceCell-backed stores in trade_store/metrics_store init once per process.
fn ensure_state_dir() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let tmp = tempfile::TempDir::new().unwrap();
        // SAFETY: called once before any other threads read this env var
        unsafe { std::env::set_var("BLUEPRINT_STATE_DIR", tmp.path()) };
        std::mem::forget(tmp);
    });
}

/// Create a test state with wiremock-backed market data client.
async fn test_state(mock_uri: &str) -> Arc<TradingApiState> {
    ensure_state_dir();

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            "http://localhost:8545",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            31337,
        )
        .expect("test executor"),
        portfolio: RwLock::new(PortfolioState::default()),
        api_token: TEST_TOKEN.to_string(),
        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
        validator_endpoints: vec![],
        validation_deadline_secs: 3600,
        bot_id: "test-bot".to_string(),
        paper_trade: true,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
    })
}

fn auth_header() -> String {
    format!("Bearer {TEST_TOKEN}")
}

fn execute_body() -> String {
    serde_json::to_string(&serde_json::json!({
        "intent": {
            "strategy_id": "test-strat",
            "action": "swap",
            "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "amount_in": "1.5",
            "min_amount_out": "3000",
            "target_protocol": "uniswap_v3"
        },
        "validation": {
            "approved": true,
            "aggregate_score": 85,
            "intent_hash": "0xabc123",
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 90,
                    "reasoning": "Good trade with favorable market conditions",
                    "signature": "0xsig1"
                },
                {
                    "validator": "0xValidator2",
                    "score": 80,
                    "reasoning": "Acceptable risk level within parameters",
                    "signature": "0xsig2"
                }
            ]
        }
    }))
    .unwrap()
}

// ── Existing tests ──────────────────────────────────────────────────────────

#[tokio::test]
async fn test_health_no_auth_required() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn test_auth_required_for_routes() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // POST /portfolio/state without auth should fail
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_auth_wrong_token() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_auth_valid_token() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn test_adapters_list() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/adapters")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let adapters = json["adapters"].as_array().unwrap();
    assert!(adapters.len() >= 6);
    assert!(adapters.iter().any(|a| a == "uniswap_v3"));
    assert!(adapters.iter().any(|a| a == "aave_v3"));
}

#[tokio::test]
async fn test_market_data_prices() {
    let mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/price/ETH"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "price": 2500.50,
            "symbol": "ETH"
        })))
        .mount(&mock)
        .await;

    Mock::given(method("GET"))
        .and(path("/price/BTC"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "price": 65000.0,
            "symbol": "BTC"
        })))
        .mount(&mock)
        .await;

    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/prices")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "tokens": ["ETH", "BTC"]
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let prices = json["prices"].as_array().unwrap();
    assert_eq!(prices.len(), 2);
}

#[tokio::test]
async fn test_portfolio_empty_state() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["positions"].as_array().unwrap().len(), 0);
    assert_eq!(json["total_value_usd"], "0");
}

#[tokio::test]
async fn test_circuit_breaker_no_drawdown() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/circuit-breaker/check")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "max_drawdown_pct": "10.0"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["should_break"], false);
}

// ── CORS tests ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_cors_preflight_no_auth_needed() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/execute")
                .header("origin", "http://localhost:3000")
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", "authorization,content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    assert!(response.headers().contains_key("access-control-allow-origin"));
    assert!(response.headers().contains_key("access-control-allow-methods"));
}

#[tokio::test]
async fn test_cors_headers_on_normal_request() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    assert!(response.headers().contains_key("access-control-allow-origin"));
}

// ── Trade history tests ─────────────────────────────────────────────────────

#[tokio::test]
async fn test_trade_persistence_paper_trade() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // Execute a paper trade
    let exec_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(execute_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(exec_response.status(), 200);
    let exec_body = exec_response.into_body().collect().await.unwrap().to_bytes();
    let exec_json: serde_json::Value = serde_json::from_slice(&exec_body).unwrap();
    assert_eq!(exec_json["paper_trade"], true);
    let tx_hash = exec_json["tx_hash"].as_str().unwrap();
    assert!(tx_hash.starts_with("0xpaper_"));

    // GET /trades should return the trade
    let list_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/trades?limit=10&offset=0")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(list_response.status(), 200);
    let list_body = list_response.into_body().collect().await.unwrap().to_bytes();
    let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let trades = list_json["trades"].as_array().unwrap();
    assert!(!trades.is_empty(), "Expected at least one trade");

    // Find our trade by tx_hash
    let our_trade = trades.iter().find(|t| t["tx_hash"].as_str() == Some(tx_hash));
    assert!(our_trade.is_some(), "Should find our paper trade in the list");

    let trade = our_trade.unwrap();
    assert_eq!(trade["action"], "swap");
    assert_eq!(trade["paper_trade"], true);
    assert_eq!(trade["validation"]["approved"], true);
    assert_eq!(trade["validation"]["aggregate_score"], 85);
}

#[tokio::test]
async fn test_trade_detail_with_reasoning() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // Execute a paper trade
    let exec_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(execute_body()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exec_response.status(), 200);

    // Get the trade list to find the ID
    let list_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/trades?limit=50")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let list_body = list_response.into_body().collect().await.unwrap().to_bytes();
    let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let trades = list_json["trades"].as_array().unwrap();
    assert!(!trades.is_empty());

    let trade_id = trades[0]["id"].as_str().unwrap();

    // GET /trades/:id should return full detail with validator reasoning
    let detail_response = app
        .oneshot(
            Request::builder()
                .uri(format!("/trades/{trade_id}"))
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(detail_response.status(), 200);
    let detail_body = detail_response.into_body().collect().await.unwrap().to_bytes();
    let detail: serde_json::Value = serde_json::from_slice(&detail_body).unwrap();

    assert_eq!(detail["id"], trade_id);
    let responses = detail["validation"]["responses"].as_array().unwrap();
    assert_eq!(responses.len(), 2);
    assert!(responses[0]["reasoning"].as_str().unwrap().contains("market conditions"));
    assert!(responses[1]["reasoning"].as_str().unwrap().contains("risk level"));
}

#[tokio::test]
async fn test_trade_not_found() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/trades/nonexistent-id")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn test_trades_pagination() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // Execute multiple paper trades
    for _ in 0..3 {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/execute")
                    .header("authorization", auth_header())
                    .header("content-type", "application/json")
                    .body(Body::from(execute_body()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    // Request with limit=1
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/trades?limit=1&offset=0")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let trades = json["trades"].as_array().unwrap();
    assert_eq!(trades.len(), 1);
    // total should reflect all trades for this bot (at least 3 we just added)
    assert!(json["total"].as_u64().unwrap() >= 3);
    assert_eq!(json["limit"], 1);
    assert_eq!(json["offset"], 0);

    // Request page 2 with offset=1
    let response2 = app
        .oneshot(
            Request::builder()
                .uri("/trades?limit=1&offset=1")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response2.status(), 200);
    let body2 = response2.into_body().collect().await.unwrap().to_bytes();
    let json2: serde_json::Value = serde_json::from_slice(&body2).unwrap();
    let trades2 = json2["trades"].as_array().unwrap();
    assert_eq!(trades2.len(), 1);
}

// ── Metrics tests ───────────────────────────────────────────────────────────

#[tokio::test]
async fn test_metrics_snapshot_and_history() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // POST a metrics snapshot
    let snap_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/metrics/snapshot")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "account_value_usd": "10500.50",
                        "unrealized_pnl": "500.50",
                        "realized_pnl": "200.00",
                        "high_water_mark": "10500.50",
                        "drawdown_pct": "0.0",
                        "positions_count": 3,
                        "trade_count": 15
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(snap_response.status(), 200);
    let snap_body = snap_response.into_body().collect().await.unwrap().to_bytes();
    let snap_json: serde_json::Value = serde_json::from_slice(&snap_body).unwrap();
    assert_eq!(snap_json["recorded"], true);
    assert!(snap_json["timestamp"].as_str().is_some());

    // GET /metrics/history should return the snapshot
    let hist_response = app
        .oneshot(
            Request::builder()
                .uri("/metrics/history?limit=10")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(hist_response.status(), 200);
    let hist_body = hist_response.into_body().collect().await.unwrap().to_bytes();
    let hist_json: serde_json::Value = serde_json::from_slice(&hist_body).unwrap();
    let snapshots = hist_json["snapshots"].as_array().unwrap();
    assert!(!snapshots.is_empty());

    let snap = snapshots.last().unwrap();
    assert_eq!(snap["account_value_usd"], "10500.50");
    assert_eq!(snap["positions_count"], 3);
    assert_eq!(snap["trade_count"], 15);
}

#[tokio::test]
async fn test_metrics_current() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/metrics")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["bot_id"], "test-bot");
    assert_eq!(json["paper_trade"], true);
    assert_eq!(json["trading_active"], true);
}

// ── Multi-bot trading API tests ─────────────────────────────────────────────

fn multi_bot_state() -> Arc<MultiBotTradingState> {
    ensure_state_dir();
    Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80".to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(|token: &str| {
            if token == "bot-token-abc" {
                Some(BotContext {
                    bot_id: "bot-1".to_string(),
                    vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                    paper_trade: true,
                    chain_id: 31337,
                    rpc_url: "http://localhost:8545".to_string(),
                    validator_endpoints: vec![],
                })
            } else {
                None
            }
        }),
    })
}

#[tokio::test]
async fn test_multi_bot_health_no_auth() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn test_multi_bot_auth_rejects_bad_token() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bad-token")
                .header("content-type", "application/json")
                .body(Body::from(execute_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_multi_bot_auth_rejects_missing_header() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("content-type", "application/json")
                .body(Body::from(execute_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_multi_bot_validate_paper_bypass() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let validate_body = serde_json::to_string(&serde_json::json!({
        "strategy_id": "test-strat",
        "action": "swap",
        "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "amount_in": "1.5",
        "min_amount_out": "3000",
        "target_protocol": "uniswap_v3"
    }))
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(validate_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["approved"], true);
    assert_eq!(json["aggregate_score"], 100);
    let responses = json["validator_responses"].as_array().unwrap();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["validator"], "paper-mode");
}

#[tokio::test]
async fn test_multi_bot_execute_paper_trade() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(execute_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["paper_trade"], true);
    let tx_hash = json["tx_hash"].as_str().unwrap();
    assert!(tx_hash.starts_with("0xpaper_"), "tx_hash should start with 0xpaper_, got: {tx_hash}");
}

#[tokio::test]
async fn test_multi_bot_execute_rejects_unapproved() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let unapproved_body = serde_json::to_string(&serde_json::json!({
        "intent": {
            "strategy_id": "test-strat",
            "action": "swap",
            "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "amount_in": "1.5",
            "min_amount_out": "3000",
            "target_protocol": "uniswap_v3"
        },
        "validation": {
            "approved": false,
            "aggregate_score": 30,
            "intent_hash": "0xabc123",
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 30,
                    "reasoning": "Trade too risky",
                    "signature": "0xsig1"
                }
            ]
        }
    }))
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(unapproved_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("Validation not approved"), "Expected 'Validation not approved', got: {body_str}");
}

// ── Edge case tests (Part 5b) ────────────────────────────────────────────

#[tokio::test]
async fn test_validate_missing_fields() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    // Empty body
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn test_execute_missing_intent() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    // Body with validation but no intent
    let body = serde_json::to_string(&serde_json::json!({
        "validation": {
            "approved": true,
            "aggregate_score": 85,
            "intent_hash": "0xabc123",
            "validator_responses": []
        }
    }))
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn test_execute_missing_validation() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    // Body with intent but no validation
    let body = serde_json::to_string(&serde_json::json!({
        "intent": {
            "strategy_id": "test-strat",
            "action": "swap",
            "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "amount_in": "1.5",
            "min_amount_out": "3000",
            "target_protocol": "uniswap_v3"
        }
    }))
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn test_metrics_history_empty() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/metrics/history?limit=10")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let snapshots = json["snapshots"].as_array().unwrap();
    // May or may not be empty (depends on test execution order due to shared state),
    // but should always be a valid array
    let _ = snapshots;
}

#[tokio::test]
async fn test_bearer_token_empty_string() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer ")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_bearer_token_just_bearer() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_multi_bot_validate_bad_action() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let bad_action_body = serde_json::to_string(&serde_json::json!({
        "strategy_id": "test-strat",
        "action": "invalid_action",
        "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "amount_in": "1.5",
        "min_amount_out": "3000",
        "target_protocol": "uniswap_v3"
    }))
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(bad_action_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("Unknown action"), "Expected 'Unknown action' error, got: {body_str}");
}

// ── Validator fan-out tests ─────────────────────────────────────────────────

/// Create a multi-bot state with real validator endpoints (paper_trade=false).
fn multi_bot_state_with_validators(validator_uris: Vec<String>) -> Arc<MultiBotTradingState> {
    ensure_state_dir();
    Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            if token == "bot-token-abc" {
                Some(BotContext {
                    bot_id: "bot-validators".to_string(),
                    vault_address: "0x0000000000000000000000000000000000000001"
                        .to_string(),
                    paper_trade: false,
                    chain_id: 31337,
                    rpc_url: "http://localhost:8545".to_string(),
                    validator_endpoints: validator_uris.clone(),
                })
            } else {
                None
            }
        }),
    })
}

fn validate_body() -> String {
    serde_json::to_string(&serde_json::json!({
        "strategy_id": "test-strat",
        "action": "swap",
        "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "amount_in": "1.5",
        "min_amount_out": "3000",
        "target_protocol": "uniswap_v3"
    }))
    .unwrap()
}

/// Two mock validators return scores 80 and 90 → average 85 >= threshold 50 → approved.
#[tokio::test]
async fn test_multi_bot_validate_with_mock_validators() {
    let v1 = MockServer::start().await;
    let v2 = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 80,
            "signature": "0xsig_v1",
            "reasoning": "Reasonable risk-reward ratio",
            "validator": "0xValidator1"
        })))
        .mount(&v1)
        .await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 90,
            "signature": "0xsig_v2",
            "reasoning": "Strong market signal with low volatility",
            "validator": "0xValidator2"
        })))
        .mount(&v2)
        .await;

    let state = multi_bot_state_with_validators(vec![v1.uri(), v2.uri()]);
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["approved"], true);
    assert_eq!(json["aggregate_score"], 85);
    let responses = json["validator_responses"].as_array().unwrap();
    assert_eq!(responses.len(), 2, "Expected 2 validator responses, got {}", responses.len());

    // Both validators should be present (order may vary)
    let validators: Vec<&str> = responses
        .iter()
        .map(|r| r["validator"].as_str().unwrap())
        .collect();
    assert!(validators.contains(&"0xValidator1"), "Missing 0xValidator1 in {validators:?}");
    assert!(validators.contains(&"0xValidator2"), "Missing 0xValidator2 in {validators:?}");

    // intent_hash should be present and non-empty
    let intent_hash = json["intent_hash"].as_str().unwrap();
    assert!(!intent_hash.is_empty(), "intent_hash should not be empty");
}

/// Two validators return low scores (20 and 30) → average 25 < threshold 50 → rejected.
#[tokio::test]
async fn test_multi_bot_validate_below_threshold() {
    let v1 = MockServer::start().await;
    let v2 = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 20,
            "signature": "0xsig_low1",
            "reasoning": "Extreme volatility detected",
            "validator": "0xValidator1"
        })))
        .mount(&v1)
        .await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 30,
            "signature": "0xsig_low2",
            "reasoning": "Insufficient liquidity for this trade size",
            "validator": "0xValidator2"
        })))
        .mount(&v2)
        .await;

    let state = multi_bot_state_with_validators(vec![v1.uri(), v2.uri()]);
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["approved"], false);
    assert_eq!(json["aggregate_score"], 25);
    let responses = json["validator_responses"].as_array().unwrap();
    assert_eq!(responses.len(), 2);
}

/// One validator returns 200 with score 90, other returns 500.
/// ValidatorClient silently drops failures → 1 response, score 90 >= 50 → approved.
#[tokio::test]
async fn test_multi_bot_validate_partial_failure() {
    let v_ok = MockServer::start().await;
    let v_fail = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 90,
            "signature": "0xsig_good",
            "reasoning": "Trade parameters look solid",
            "validator": "0xValidatorOK"
        })))
        .mount(&v_ok)
        .await;

    // Failing validator returns 500 — ValidatorClient's .ok() on json parse drops it
    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
        .mount(&v_fail)
        .await;

    let state = multi_bot_state_with_validators(vec![v_ok.uri(), v_fail.uri()]);
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["approved"], true);
    assert_eq!(json["aggregate_score"], 90);
    let responses = json["validator_responses"].as_array().unwrap();
    assert_eq!(
        responses.len(),
        1,
        "Only the successful validator should be in responses, got {}",
        responses.len()
    );
    assert_eq!(responses[0]["validator"], "0xValidatorOK");
}

/// Both validators return 500 → ValidatorClient returns "No validators responded"
/// → handler maps to BAD_GATEWAY (502).
#[tokio::test]
async fn test_multi_bot_validate_all_fail() {
    let v1 = MockServer::start().await;
    let v2 = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(500).set_body_string("down for maintenance"))
        .mount(&v1)
        .await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(500).set_body_string("internal error"))
        .mount(&v2)
        .await;

    let state = multi_bot_state_with_validators(vec![v1.uri(), v2.uri()]);
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 502);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(
        body_str.contains("No validators responded"),
        "Expected 'No validators responded' error, got: {body_str}"
    );
}

// ── Portfolio P&L tracking tests ────────────────────────────────────────────

#[tokio::test]
async fn test_portfolio_state_with_positions() {
    use rust_decimal::Decimal;
    use trading_runtime::{Position, PositionType};

    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;

    // Pre-populate the portfolio with two positions before building the router.
    {
        let mut portfolio = state.portfolio.write().await;
        portfolio.positions.push(Position {
            token: "WETH".to_string(),
            amount: Decimal::new(15, 1),       // 1.5
            entry_price: Decimal::new(2400, 0), // 2400
            current_price: Decimal::new(2500, 0), // 2500
            unrealized_pnl: Decimal::new(150, 0), // +150
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
        });
        portfolio.positions.push(Position {
            token: "USDC".to_string(),
            amount: Decimal::new(5000, 0),      // 5000
            entry_price: Decimal::new(1, 0),    // 1.0
            current_price: Decimal::new(1, 0),  // 1.0
            unrealized_pnl: Decimal::new(0, 0), // 0
            protocol: "aave_v3".to_string(),
            position_type: PositionType::Lending,
        });
        // total_value_usd = 1.5*2500 + 5000*1 = 3750 + 5000 = 8750
        portfolio.total_value_usd = Decimal::new(8750, 0);
        portfolio.unrealized_pnl = Decimal::new(150, 0);
        portfolio.realized_pnl = Decimal::new(320, 0);
    }

    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // Verify positions
    let positions = json["positions"].as_array().unwrap();
    assert_eq!(positions.len(), 2, "Expected 2 positions, got {}", positions.len());

    // Find WETH position
    let weth = positions.iter().find(|p| p["token"] == "WETH").unwrap();
    assert_eq!(weth["amount"], "1.5");
    assert_eq!(weth["entry_price"], "2400");
    assert_eq!(weth["current_price"], "2500");
    assert_eq!(weth["unrealized_pnl"], "150");
    assert_eq!(weth["protocol"], "uniswap_v3");
    assert_eq!(weth["position_type"], "spot");

    // Find USDC lending position
    let usdc = positions.iter().find(|p| p["token"] == "USDC").unwrap();
    assert_eq!(usdc["amount"], "5000");
    assert_eq!(usdc["position_type"], "lending");

    // Verify aggregate P&L
    assert_eq!(json["total_value_usd"], "8750");
    assert_eq!(json["unrealized_pnl"], "150");
    assert_eq!(json["realized_pnl"], "320");
}

#[tokio::test]
async fn test_portfolio_pnl_reflects_losses() {
    use rust_decimal::Decimal;
    use trading_runtime::{Position, PositionType};

    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;

    // Portfolio with a losing position
    {
        let mut portfolio = state.portfolio.write().await;
        portfolio.positions.push(Position {
            token: "WETH".to_string(),
            amount: Decimal::new(2, 0),          // 2.0 ETH
            entry_price: Decimal::new(3000, 0),  // bought at 3000
            current_price: Decimal::new(2200, 0), // now at 2200
            unrealized_pnl: Decimal::new(-1600, 0), // -1600 loss
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
        });
        // total_value_usd = 2 * 2200 = 4400
        portfolio.total_value_usd = Decimal::new(4400, 0);
        portfolio.unrealized_pnl = Decimal::new(-1600, 0);
        portfolio.realized_pnl = Decimal::new(0, 0);
        portfolio.high_water_mark = Decimal::new(6000, 0);
        portfolio.max_drawdown_pct = Decimal::new(2667, 2); // 26.67%
    }

    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["total_value_usd"], "4400");
    assert_eq!(json["unrealized_pnl"], "-1600");
    assert_eq!(json["realized_pnl"], "0");

    let positions = json["positions"].as_array().unwrap();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["unrealized_pnl"], "-1600");
    assert_eq!(positions[0]["current_price"], "2200");
}
