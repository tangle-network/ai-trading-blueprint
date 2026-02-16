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

/// Create a test state with wiremock-backed market data client.
async fn test_state(mock_uri: &str) -> Arc<TradingApiState> {
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
    })
}

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
                .header("authorization", format!("Bearer {TEST_TOKEN}"))
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
                .header("authorization", format!("Bearer {TEST_TOKEN}"))
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
                .header("authorization", format!("Bearer {TEST_TOKEN}"))
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
                .header("authorization", format!("Bearer {TEST_TOKEN}"))
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
                .header("authorization", format!("Bearer {TEST_TOKEN}"))
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
