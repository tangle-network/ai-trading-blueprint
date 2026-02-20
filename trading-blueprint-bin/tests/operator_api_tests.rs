//! Cloud operator API E2E tests.
//!
//! Tests exercise `build_operator_router()` with seeded bot records,
//! provision progress entries, and real PASETO auth tokens via
//! `tower::ServiceExt::oneshot`.

use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use once_cell::sync::Lazy;
use tower::ServiceExt;

use trading_blueprint_lib::state::{self, TradingBotRecord};

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

static SHARED_STATE_DIR: Lazy<tempfile::TempDir> = Lazy::new(|| {
    let dir = tempfile::tempdir().expect("create temp state dir");
    unsafe {
        std::env::set_var("BLUEPRINT_STATE_DIR", dir.path());
    }
    dir
});

fn init_test_env() -> &'static tempfile::TempDir {
    &SHARED_STATE_DIR
}

fn test_auth_header(address: &str) -> String {
    let token = sandbox_runtime::session_auth::create_test_token(address);
    format!("Bearer {token}")
}

const SUBMITTER: &str = "0xaaaa000000000000000000000000000000000001";

fn seed_bot(id: &str, strategy: &str, active: bool) -> TradingBotRecord {
    seed_bot_with_workflow(id, strategy, active, None)
}

fn seed_bot_with_workflow(
    id: &str,
    strategy: &str,
    active: bool,
    workflow_id: Option<u64>,
) -> TradingBotRecord {
    // If a workflow_id is provided, create a matching workflow entry
    if let Some(wf_id) = workflow_id {
        let wf_json = serde_json::json!({
            "sidecar_url": "http://127.0.0.1:19999",
            "prompt": "trading loop iteration",
            "session_id": format!("wf-{wf_id}"),
            "max_turns": 10,
            "timeout_ms": 120000,
            "sidecar_token": "tok",
        })
        .to_string();

        let next_run = ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run(
            "cron",
            "0 */5 * * * *",
            None,
        )
        .unwrap_or(None);

        let entry = ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
            id: wf_id,
            name: format!("trading-loop-{wf_id}"),
            workflow_json: wf_json,
            trigger_type: "cron".to_string(),
            trigger_config: "0 */5 * * * *".to_string(),
            sandbox_config_json: String::new(),
            active,
            next_run_at: next_run,
            last_run_at: None,
            owner: String::new(),
        };

        ai_agent_sandbox_blueprint_lib::workflows::workflows()
            .expect("workflows store")
            .insert(
                ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id),
                entry,
            )
            .expect("insert workflow");
    }

    let record = TradingBotRecord {
        id: id.to_string(),
        sandbox_id: format!("sandbox-{id}"),
        vault_address: format!("0xVAULT-{id}"),
        share_token: String::new(),
        strategy_type: strategy.to_string(),
        strategy_config: serde_json::json!({"max_slippage": 0.5}),
        risk_params: serde_json::json!({"max_drawdown_pct": 5.0}),
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        trading_api_url: "http://localhost:9100".to_string(),
        trading_api_token: "tok".to_string(),
        workflow_id,
        trading_active: active,
        created_at: chrono::Utc::now().timestamp() as u64,
        operator_address: "0xOP1".to_string(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: SUBMITTER.to_string(),
        trading_loop_cron: "0 */5 * * * *".to_string(),
        call_id: 0,
        service_id: 0,
    };
    state::bots()
        .expect("bots store")
        .insert(state::bot_key(id), record.clone())
        .expect("insert bot");
    record
}

/// Build the router from the binary's operator_api module.
/// We re-export it from the crate root for tests.
fn app() -> axum::Router {
    trading_blueprint_bin::build_operator_router()
}

// ---------------------------------------------------------------------------
// Auth endpoint tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_auth_challenge_returns_nonce_and_message() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/challenge")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["nonce"].is_string(), "challenge should contain nonce");
    assert!(json["message"].is_string(), "challenge should contain message");
    assert!(json["expires_at"].is_number(), "challenge should contain expires_at");
}

#[tokio::test]
async fn test_auth_session_rejects_bad_signature() {
    let _dir = init_test_env();

    let body = serde_json::json!({
        "nonce": "bad-nonce",
        "signature": "0xbadsig",
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/session")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_protected_routes_reject_no_auth() {
    let _dir = init_test_env();

    let routes = vec![
        ("POST", "/api/bots/test/secrets"),
        ("DELETE", "/api/bots/test/secrets"),
        ("POST", "/api/bots/test/start"),
        ("POST", "/api/bots/test/stop"),
        ("POST", "/api/bots/test/run-now"),
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
// Bot listing tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_bots_empty() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["bots"].is_array());
    assert!(json["total"].is_number());
}

#[tokio::test]
async fn test_list_bots_returns_seeded() {
    let _dir = init_test_env();

    let bot = seed_bot("list-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let bots = json["bots"].as_array().unwrap();
    let found = bots.iter().any(|b| b["id"].as_str() == Some(&bot.id));
    assert!(found, "Seeded bot should appear in list");
}

#[tokio::test]
async fn test_get_bot_detail() {
    let _dir = init_test_env();

    let bot = seed_bot("detail-bot-1", "perp", false);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["id"], bot.id);
    assert_eq!(json["strategy_type"], "perp");
    assert_eq!(json["trading_active"], false);
    assert_eq!(json["paper_trade"], true);
    assert_eq!(json["chain_id"], 31337);
    assert_eq!(json["max_lifetime_days"], 30);
    // trading_api_token should be excluded from serialization
    assert!(json["trading_api_token"].is_null(), "token should not be serialized");
}

#[tokio::test]
async fn test_get_bot_not_found() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots/nonexistent-bot-xyz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);
}

// ---------------------------------------------------------------------------
// Bot control tests (with auth)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_start_bot_auth_resolves_bot() {
    let _dir = init_test_env();

    let bot = seed_bot("start-test-1", "dex", false);

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/bots/{}/start", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // start_core calls resume_sidecar (Docker) — no real container in test.
    // Verify auth + bot resolution worked (not 401/403/404), Docker layer returns 500.
    assert_eq!(response.status(), 500, "Expected 500 from Docker layer (no container)");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let err = String::from_utf8_lossy(&body);
    assert!(
        err.contains("Sandbox not found") || err.contains("sidecar") || err.contains("not found"),
        "Error should be from sandbox layer, got: {err}"
    );
}

#[tokio::test]
async fn test_stop_bot_auth_resolves_bot() {
    let _dir = init_test_env();

    let bot = seed_bot("stop-test-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/bots/{}/stop", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // stop_core calls pause_sidecar (Docker) — no real container in test.
    assert_eq!(response.status(), 500, "Expected 500 from Docker layer (no container)");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let err = String::from_utf8_lossy(&body);
    assert!(
        err.contains("Sandbox not found") || err.contains("sidecar") || err.contains("not found"),
        "Error should be from sandbox layer, got: {err}"
    );
}

#[tokio::test]
async fn test_configure_secrets_wrong_submitter() {
    let _dir = init_test_env();

    let bot = seed_bot("secrets-wrong-1", "dex", false);

    let body = serde_json::json!({
        "env_json": { "ANTHROPIC_API_KEY": "sk-test" },
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/bots/{}/secrets", bot.id))
                .header("content-type", "application/json")
                .header("authorization", test_auth_header("0xWRONGADDRESS"))
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn test_update_config_with_auth() {
    let _dir = init_test_env();

    let bot = seed_bot("config-test-1", "perp", true);

    let body = serde_json::json!({
        "strategy_config_json": "{\"leverage\": 5}",
        "risk_params_json": "{\"max_drawdown_pct\": 3.0}",
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(&format!("/api/bots/{}/config", bot.id))
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

    // Verify persisted
    let updated = state::get_bot(&bot.id).unwrap().unwrap();
    assert_eq!(updated.strategy_config["leverage"], 5);
}

// ---------------------------------------------------------------------------
// Metrics / trades / portfolio tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_get_bot_metrics() {
    let _dir = init_test_env();

    let bot = seed_bot("metrics-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}/metrics", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["portfolio_value_usd"].is_number());
    assert!(json["total_pnl"].is_number());
    assert!(json["trade_count"].is_number());
}

#[tokio::test]
async fn test_get_bot_trades() {
    let _dir = init_test_env();

    let bot = seed_bot("trades-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}/trades", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.is_array(), "trades should be an array");
}

#[tokio::test]
async fn test_get_bot_portfolio() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}/portfolio/state", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["total_value_usd"].is_number());
    assert!(json["cash_balance"].is_number());
    assert!(json["positions"].is_array());
}

#[tokio::test]
async fn test_get_bot_metrics_history() {
    let _dir = init_test_env();

    let bot = seed_bot("history-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}/metrics/history", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.is_array(), "metrics history should be an array");
}

// ---------------------------------------------------------------------------
// Activation progress tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_activation_progress_not_found() {
    let _dir = init_test_env();

    let bot = seed_bot("activation-nf-1", "dex", false);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}/activation-progress", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn test_activation_progress_returns_state() {
    let _dir = init_test_env();

    let bot = seed_bot("activation-ok-1", "dex", false);

    // Seed activation progress
    state::update_activation_progress(&bot.id, "setup", "Installing dependencies");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(&format!("/api/bots/{}/activation-progress", bot.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["bot_id"], bot.id);
    assert_eq!(json["phase"], "setup");
    assert_eq!(json["detail"], "Installing dependencies");
    assert!(json["started_at"].is_number());
    assert!(json["updated_at"].is_number());
}

// ---------------------------------------------------------------------------
// Provision progress tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_provisions() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/provisions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["provisions"].is_array());
}

#[tokio::test]
async fn test_get_provision_by_call_id() {
    let _dir = init_test_env();

    // Seed a provision
    sandbox_runtime::provision_progress::start_provision(42424242).unwrap();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/provisions/42424242")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["call_id"], 42424242);
    assert_eq!(json["phase"], "queued");
    assert_eq!(json["progress_pct"], 0);
}

#[tokio::test]
async fn test_provision_not_found() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/provisions/999999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);
}

// ---------------------------------------------------------------------------
// Pricing endpoint tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_pricing_quote() {
    let _dir = init_test_env();

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
    assert!(json["details"].is_object());
}

#[tokio::test]
async fn test_pricing_job_quote() {
    let _dir = init_test_env();

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
    assert!(json["details"]["job_index"].is_number());
}

// ---------------------------------------------------------------------------
// Debug endpoint tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_debug_sandboxes() {
    let _dir = init_test_env();

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
}

#[tokio::test]
async fn test_debug_workflows() {
    let _dir = init_test_env();

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
// Bot list filtering tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_bots_filter_by_strategy() {
    let _dir = init_test_env();

    seed_bot("filter-strat-dex", "dex", true);
    seed_bot("filter-strat-perp", "perp", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots?strategy=perp")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let bots = json["bots"].as_array().unwrap();
    // All returned bots should have strategy_type == "perp"
    for bot in bots {
        assert_eq!(bot["strategy_type"], "perp");
    }
}

#[tokio::test]
async fn test_list_bots_filter_by_status() {
    let _dir = init_test_env();

    seed_bot("filter-active-1", "dex", true);
    seed_bot("filter-inactive-1", "dex", false);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots?status=active")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let bots = json["bots"].as_array().unwrap();
    for bot in bots {
        assert_eq!(bot["trading_active"], true);
    }
}

// ---------------------------------------------------------------------------
// Run-now requires active bot
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_run_now_inactive_bot_returns_conflict() {
    let _dir = init_test_env();

    let bot = seed_bot("run-now-inactive-1", "dex", false);

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/bots/{}/run-now", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 409);
}
