//! Instance operator API E2E tests.
//!
//! Tests exercise `build_instance_router()` with seeded singleton bot records
//! and real PASETO auth tokens via `tower::ServiceExt::oneshot`.
//!
//! **Serialised**: all tests acquire `HARNESS_LOCK` because they share the
//! process-global instance singleton store.

mod common;

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use tower::ServiceExt;

use trading_blueprint_lib::state;
use trading_instance_blueprint_lib::{build_instance_router, clear_instance_bot_id};

use common::fixtures;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn test_auth_header(address: &str) -> String {
    let token = sandbox_runtime::session_auth::create_test_token(address);
    format!("Bearer {token}")
}

const SUBMITTER: &str = "0xaaaa000000000000000000000000000000000001";

fn seed_singleton(strategy: &str) -> (String, String) {
    let (bot_id, sandbox_id) = fixtures::seed_instance_bot(strategy);
    // Set submitter_address for auth tests
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.submitter_address = SUBMITTER.to_string();
        })
        .unwrap();
    (bot_id, sandbox_id)
}

fn app() -> axum::Router {
    build_instance_router()
}

// ---------------------------------------------------------------------------
// GET /api/bot (singleton resolution)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_get_bot_when_provisioned() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, _sandbox_id) = seed_singleton("dex");

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["strategy_type"], "dex");
    assert_eq!(json["chain_id"], 31337);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_get_bot_when_not_provisioned() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);

    let _ = clear_instance_bot_id();
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_protected_routes_reject_no_auth() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let routes = vec![
        ("POST", "/api/bot/secrets"),
        ("DELETE", "/api/bot/secrets"),
        ("POST", "/api/bot/start"),
        ("POST", "/api/bot/stop"),
        ("POST", "/api/bot/run-now"),
    ];

    for (method, uri) in routes {
        let response = app()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            401,
            "{method} {uri} should require auth"
        );
    }
}

// ---------------------------------------------------------------------------
// Start / Stop singleton
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_start_stop_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("dex");

    // Seed a workflow so start/stop have something to toggle
    let wf_id = chrono::Utc::now().timestamp_millis() as u64 + 3000;
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:19999", "tok", "0 */5 * * * *");
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.workflow_id = Some(wf_id);
        })
        .unwrap();

    // Stop — operator API uses skip_docker=false, so Docker layer returns 500
    // (no real container). Verify auth + singleton resolution works (not 401/403/404).
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bot/stop")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status().as_u16();
    assert!(
        status == 200 || status == 500,
        "Expected 200 or 500 from Docker layer, got {status}"
    );

    // Start — same Docker limitation
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bot/start")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status().as_u16();
    assert!(
        status == 200 || status == 500,
        "Expected 200 or 500 from Docker layer, got {status}"
    );

    let _ = clear_instance_bot_id();
}

// ---------------------------------------------------------------------------
// Config update
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_update_config_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, _) = seed_singleton("perp");

    let body = serde_json::json!({
        "strategy_config_json": r#"{"leverage": 10}"#,
        "risk_params_json": r#"{"max_drawdown_pct": 2.0}"#,
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/bot/config")
                .header("content-type", "application/json")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "configured");

    let updated = state::get_bot(&bot_id).unwrap().unwrap();
    assert_eq!(updated.strategy_config["leverage"], 10);
    assert_eq!(updated.risk_params["max_drawdown_pct"], 2.0);

    let _ = clear_instance_bot_id();
}

// ---------------------------------------------------------------------------
// Run-now requires active bot
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_run_now_requires_active_bot() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, _) = seed_singleton("dex");

    // Deactivate bot
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.trading_active = false;
        })
        .unwrap();

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bot/run-now")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 409);

    let _ = clear_instance_bot_id();
}

// ---------------------------------------------------------------------------
// Metrics, trades, portfolio
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_metrics_and_trades() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, _) = seed_singleton("prediction");

    // GET /api/bot/metrics
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["portfolio_value_usd"].is_number());

    // GET /api/bot/trades
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/trades")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.is_array());

    // GET /api/bot/portfolio/state
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/portfolio/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["total_value_usd"].is_number());
    assert!(json["positions"].is_array());

    let _ = clear_instance_bot_id();
}

// ---------------------------------------------------------------------------
// Debug endpoints
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_debug_endpoints() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    // GET /api/debug/sandboxes
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/debug/sandboxes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["count"].is_number());
    assert!(json["sandboxes"].is_array());

    // GET /api/debug/workflows
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/debug/workflows")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["count"].is_number());
    assert!(json["workflows"].is_array());
}

// ---------------------------------------------------------------------------
// Pricing endpoints
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_pricing_endpoints() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    // POST /pricing/quote
    let body = serde_json::json!({
        "blueprint_id": "1",
        "ttl_blocks": "200",
    });
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/pricing/quote")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["total_cost"], "0");
    assert!(json["signature"].is_string());

    // POST /pricing/job-quote
    let body = serde_json::json!({
        "service_id": "0",
        "job_index": 0,
    });
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/pricing/job-quote")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["total_cost"], "0");
}

// ---------------------------------------------------------------------------
// Metrics history
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_metrics_history_empty() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, _) = seed_singleton("yield");

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/metrics/history")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.is_array());

    let _ = clear_instance_bot_id();
}

// ---------------------------------------------------------------------------
// Secrets injection success-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_configure_secrets_correct_submitter_reaches_activation() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, _sandbox_id) = seed_singleton("dex");

    let body = serde_json::json!({
        "env_json": { "ANTHROPIC_API_KEY": "sk-test-key-123" },
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bot/secrets")
                .header("content-type", "application/json")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status().as_u16();
    // Auth passed (not 401/403/404). The activation will fail at sandbox layer (500)
    // because there's no real Docker container, but that confirms we reached the
    // activation code path.
    assert_ne!(status, 401, "Should pass auth");
    assert_ne!(status, 403, "Should pass submitter check");
    assert_ne!(status, 404, "Bot should be found");
    assert_eq!(status, 500, "Expected 500 from sandbox/activation layer (no Docker container)");

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let err = String::from_utf8_lossy(&body);
    // The error should mention activation/sandbox, not auth
    assert!(
        err.contains("Bot") || err.contains("sandbox") || err.contains("secrets") || err.contains("inject") || err.contains("activate"),
        "Error should be from activation layer, got: {err}"
    );

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_wipe_secrets_requires_existing_secrets() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, _sandbox_id) = seed_singleton("dex");

    let response = app()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/bot/secrets")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status().as_u16();
    assert_ne!(status, 401, "Should pass auth");
    assert_ne!(status, 403, "Should pass submitter check");
    // Wipe fails because bot has no secrets configured (correct behavior)
    assert_eq!(status, 500, "Expected 500 — no secrets to wipe");

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let err = String::from_utf8_lossy(&body);
    assert!(
        err.contains("no secrets") || err.contains("has no") || err.contains("Bot") || err.contains("Sandbox") || err.contains("not found"),
        "Error should be from sandbox/secrets layer, got: {err}"
    );

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_configure_secrets_not_provisioned() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    // No singleton seeded — instance has no bot

    let body = serde_json::json!({
        "env_json": { "ANTHROPIC_API_KEY": "sk-test" },
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bot/secrets")
                .header("content-type", "application/json")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);

    let _ = clear_instance_bot_id();
}
