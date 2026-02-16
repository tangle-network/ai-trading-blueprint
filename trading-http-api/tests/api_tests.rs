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
