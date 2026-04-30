//! Cloud operator API E2E tests.
//!
//! Tests exercise `build_operator_router()` with seeded bot records,
//! provision progress entries, and real PASETO auth tokens via
//! `tower::ServiceExt::oneshot`.

use axum::body::Body;
use axum::extract::Path;
use axum::http::header::CONTENT_TYPE;
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use hyper::{Request, StatusCode};
use once_cell::sync::Lazy;
use serde_json::json;
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

fn seed_sandbox_record(id: &str) {
    let record = sandbox_runtime::SandboxRecord {
        id: id.to_string(),
        container_id: format!("container-{id}"),
        sidecar_url: "http://127.0.0.1:19999".to_string(),
        sidecar_port: 8080,
        ssh_port: None,
        token: "test-token".to_string(),
        created_at: chrono::Utc::now().timestamp() as u64,
        cpu_cores: 2,
        memory_mb: 4096,
        state: sandbox_runtime::runtime::SandboxState::Running,
        idle_timeout_seconds: 0,
        max_lifetime_seconds: 86400,
        last_activity_at: chrono::Utc::now().timestamp() as u64,
        stopped_at: None,
        snapshot_image_id: None,
        snapshot_s3_url: None,
        container_removed_at: None,
        image_removed_at: None,
        original_image: "tangle-sidecar:local".to_string(),
        base_env_json: "{}".to_string(),
        user_env_json: String::new(),
        snapshot_destination: None,
        tee_deployment_id: None,
        tee_metadata_json: None,
        name: String::new(),
        agent_identifier: String::new(),
        metadata_json: String::new(),
        disk_gb: 0,
        stack: String::new(),
        owner: String::new(),
        service_id: None,
        tee_config: None,
        extra_ports: std::collections::HashMap::new(),
        ssh_login_user: None,
        ssh_authorized_keys: Vec::new(),
        tee_attestation_json: None,
    };

    sandbox_runtime::runtime::sandboxes()
        .expect("sandbox store")
        .insert(id.to_string(), record)
        .expect("insert sandbox");
}

fn mark_sandbox_secrets_configured(id: &str) {
    let mut record = sandbox_runtime::runtime::get_sandbox_by_id(id).expect("sandbox exists");
    record.user_env_json = r#"{"ANTHROPIC_API_KEY":"sk-test"}"#.to_string();
    sandbox_runtime::runtime::sandboxes()
        .expect("sandbox store")
        .insert(id.to_string(), record)
        .expect("update sandbox");
}

fn set_sandbox_sidecar_url(id: &str, sidecar_url: &str) {
    let mut record = sandbox_runtime::runtime::get_sandbox_by_id(id).expect("sandbox exists");
    record.sidecar_url = sidecar_url.to_string();
    sandbox_runtime::runtime::sandboxes()
        .expect("sandbox store")
        .insert(id.to_string(), record)
        .expect("update sandbox");
}

fn seed_bot(id: &str, strategy: &str, active: bool) -> TradingBotRecord {
    seed_bot_with_workflow(id, strategy, active, None)
}

fn seed_bot_with_workflow(
    id: &str,
    strategy: &str,
    active: bool,
    workflow_id: Option<u64>,
) -> TradingBotRecord {
    seed_bot_with_identity(
        id,
        strategy,
        active,
        workflow_id,
        0,
        0,
        chrono::Utc::now().timestamp() as u64,
    )
}

fn seed_bot_with_identity(
    id: &str,
    strategy: &str,
    active: bool,
    workflow_id: Option<u64>,
    call_id: u64,
    service_id: u64,
    created_at: u64,
) -> TradingBotRecord {
    let sandbox_id = format!("sandbox-{id}");
    seed_sandbox_record(&sandbox_id);

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
            target_kind: ai_agent_sandbox_blueprint_lib::workflows::WORKFLOW_TARGET_SANDBOX,
            target_sandbox_id: sandbox_id.clone(),
            target_service_id: 0,
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
        name: format!("Bot {id}"),
        sandbox_id,
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
        created_at,
        operator_address: "0xOP1".to_string(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: SUBMITTER.to_string(),
        trading_loop_cron: "0 */5 * * * *".to_string(),
        call_id,
        service_id,
        harness_json: serde_json::Value::default(),
        validation_trust: trading_runtime::ValidationTrust::default(),
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

async fn spawn_mock_trading_api() -> String {
    let app = Router::new()
        .route(
            "/trades",
            get(|| async {
                Json(json!({
                    "trades": [{
                        "id": "remote-trade-1",
                        "bot_id": "remote-bot",
                        "timestamp": "2026-01-01T00:00:00Z",
                        "action": "buy",
                        "token_in": "USDC",
                        "token_out": "ETH",
                        "amount_in": "100",
                        "min_amount_out": "0.05",
                        "target_protocol": "uniswap",
                        "tx_hash": "0xremote",
                        "paper_trade": false,
                        "validation": {
                            "approved": true,
                            "aggregate_score": 91,
                            "intent_hash": "0xintent",
                            "responses": [{
                                "validator": "validator-1",
                                "score": 91,
                                "reasoning": "trade looks safe",
                                "signature": "0xsig"
                            }]
                        }
                    }],
                    "total": 1,
                    "limit": 50,
                    "offset": 0
                }))
            }),
        )
        .route(
            "/metrics/history",
            get(|| async {
                Json(json!({
                    "snapshots": [{
                        "timestamp": "2026-01-01T00:00:00Z",
                        "bot_id": "remote-bot",
                        "account_value_usd": 10123.45,
                        "unrealized_pnl": 12.0,
                        "realized_pnl": 34.0,
                        "high_water_mark": 10123.45,
                        "drawdown_pct": 0.0,
                        "positions_count": 1,
                        "trade_count": 1
                    }],
                    "total": 1
                }))
            }),
        )
        .route(
            "/portfolio/state",
            post(|| async {
                Json(json!({
                    "positions": [{
                        "token": "WETH",
                        "amount": "0.5",
                        "value_usd": "1050",
                        "entry_price": "2000",
                        "current_price": "2100",
                        "valuation_status": "priced"
                    }],
                    "total_value_usd": "1050",
                    "cash_balance": null,
                    "warnings": [],
                    "has_unpriced_positions": false
                }))
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock trading api");
    let addr = listener.local_addr().expect("mock trading api addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock trading api");
    });
    format!("http://{addr}")
}

async fn spawn_mock_trading_api_value_only() -> String {
    let app = Router::new().route(
        "/portfolio/state",
        post(|| async {
            Json(json!({
                "positions": [{
                    "token": "WETH",
                    "amount": "0.5",
                    "value_usd": "1050",
                    "current_price": "2100",
                    "valuation_status": "value_only"
                }],
                "total_value_usd": "1050",
                "cash_balance": "9000",
                "warnings": ["Some positions have current market value, but entry price or PnL are unavailable."],
                "has_unpriced_positions": false,
                "has_value_only_positions": true
            }))
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock trading api");
    let addr = listener.local_addr().expect("mock trading api addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock trading api");
    });
    format!("http://{addr}")
}

async fn spawn_mock_trading_api_with_address_portfolio(token: &'static str) -> String {
    let app = Router::new().route(
        "/portfolio/state",
        post(move || async move {
            Json(json!({
                "positions": [{
                    "token": token,
                    "amount": "647.24",
                    "value_usd": "647.063",
                    "entry_price": "1",
                    "current_price": "1",
                    "valuation_status": "priced"
                }],
                "total_value_usd": "647.063",
                "cash_balance": null,
                "warnings": [],
                "has_unpriced_positions": false
            }))
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock trading api");
    let addr = listener.local_addr().expect("mock trading api addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock trading api");
    });
    format!("http://{addr}")
}

async fn spawn_mock_terminal_sidecar() -> String {
    let app = Router::new()
        .route(
            "/terminals",
            get(|| async {
                Json(json!({
                    "success": true,
                    "data": [{
                        "sessionId": "term-1",
                        "title": "Shell",
                        "streamUrl": "/terminals/term-1/stream"
                    }]
                }))
            })
            .post(|| async {
                Json(json!({
                    "success": true,
                    "data": {
                        "sessionId": "term-1",
                        "title": "Shell",
                        "streamUrl": "/terminals/term-1/stream"
                    }
                }))
            }),
        )
        .route(
            "/terminals/term-1",
            get(|| async {
                Json(json!({
                    "success": true,
                    "data": {
                        "sessionId": "term-1",
                        "title": "Shell",
                        "streamUrl": "/terminals/term-1/stream"
                    }
                }))
            })
            .patch(|| async {
                Json(json!({
                    "success": true,
                    "data": {
                        "sessionId": "term-1",
                        "streamUrl": "/terminals/term-1/stream"
                    }
                }))
            })
            .delete(|| async {
                Json(json!({
                    "success": true
                }))
            }),
        )
        .route(
            "/terminals/term-1/input",
            post(|| async {
                Json(json!({
                    "success": true
                }))
            }),
        )
        .route(
            "/terminals/term-1/stream",
            get(|| async move {
                (
                    [(CONTENT_TYPE, "text/event-stream")],
                    "event: data.stdout\ndata: {\"type\":\"data.stdout\",\"properties\":{\"text\":\"hello from shell\\r\\n\"}}\n\n",
                )
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock terminal sidecar");
    let addr = listener.local_addr().expect("mock terminal sidecar addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock terminal sidecar");
    });
    format!("http://{addr}")
}

async fn spawn_mock_chat_sidecar(bot_id: &str) -> String {
    let workflow_session = format!("trading-{bot_id}");
    let tick_session = format!("trading-{bot_id}-1775823900");
    let fast_session = format!("fast-{bot_id}");
    let research_session = format!("research-{bot_id}");
    let convo_session = format!("convo-{bot_id}");
    let app = Router::new()
        .route(
            "/agents/sessions",
            get(move || {
                let workflow_session = workflow_session.clone();
                let tick_session = tick_session.clone();
                let fast_session = fast_session.clone();
                let research_session = research_session.clone();
                let convo_session = convo_session.clone();
                async move {
                    Json(json!([
                        {"id": "manual-1", "title": "New Chat"},
                        {"id": workflow_session},
                        {"id": tick_session},
                        {"id": fast_session},
                        {"id": research_session},
                        {"id": convo_session}
                    ]))
                }
            }),
        )
        .route(
            "/agents/sessions/{id}",
            get(|Path(id): Path<String>| async move {
                Json(json!({
                    "id": id,
                    "title": "New Chat"
                }))
            }),
        )
        .route(
            "/agents/sessions/{id}/messages",
            get(|| async { Json(json!([])) }).post(|| async { Json(json!({"ok": true})) }),
        )
        .route(
            "/agents/sessions/{id}/abort",
            post(|| async { Json(json!({"ok": true})) }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock chat sidecar");
    let addr = listener.local_addr().expect("mock chat sidecar addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock chat sidecar");
    });
    format!("http://{addr}")
}

async fn spawn_mock_chat_sidecar_with_message_status(
    bot_id: &str,
    message_status: StatusCode,
) -> String {
    let workflow_session = format!("trading-{bot_id}");
    let tick_session = format!("trading-{bot_id}-1775823900");
    let fast_session = format!("fast-{bot_id}");
    let research_session = format!("research-{bot_id}");
    let convo_session = format!("convo-{bot_id}");
    let app = Router::new()
        .route(
            "/agents/sessions",
            get(move || {
                let workflow_session = workflow_session.clone();
                let tick_session = tick_session.clone();
                let fast_session = fast_session.clone();
                let research_session = research_session.clone();
                let convo_session = convo_session.clone();
                async move {
                    Json(json!([
                        {"id": "manual-1", "title": "New Chat"},
                        {"id": workflow_session},
                        {"id": tick_session},
                        {"id": fast_session},
                        {"id": research_session},
                        {"id": convo_session}
                    ]))
                }
            }),
        )
        .route(
            "/agents/sessions/{id}",
            get(|Path(id): Path<String>| async move {
                Json(json!({
                    "id": id,
                    "title": "New Chat"
                }))
            }),
        )
        .route(
            "/agents/sessions/{id}/messages",
            get(move || async move {
                (
                    message_status,
                    Json(json!({ "error": format!("mock status {}", message_status.as_u16()) })),
                )
            })
            .post(|| async { Json(json!({"ok": true})) }),
        )
        .route(
            "/agents/sessions/{id}/abort",
            post(|| async { Json(json!({"ok": true})) }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock chat sidecar");
    let addr = listener.local_addr().expect("mock chat sidecar addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock chat sidecar");
    });
    format!("http://{addr}")
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
    assert!(
        json["message"].is_string(),
        "challenge should contain message"
    );
    assert!(
        json["expires_at"].is_number(),
        "challenge should contain expires_at"
    );
}

#[tokio::test]
async fn test_operator_meta_reports_fleet_contract() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["deployment_kind"], "fleet");
    assert!(json["features"]["chat"].is_boolean());
    assert!(json["features"]["terminal"].is_boolean());
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
        ("GET", "/api/bots"),
        ("GET", "/api/bots/test"),
        ("GET", "/api/bots/test/metrics"),
        ("GET", "/api/bots/test/metrics/history"),
        ("GET", "/api/bots/test/trades"),
        ("GET", "/api/bots/test/portfolio/state"),
        ("GET", "/api/bots/test/activation-progress"),
        ("GET", "/api/bots/test/live/terminal/sessions"),
        ("POST", "/api/bots/test/live/terminal/sessions"),
        ("GET", "/api/bots/test/live/terminal/sessions/term-1/stream"),
        ("PATCH", "/api/bots/test/live/terminal/sessions/term-1"),
        ("DELETE", "/api/bots/test/live/terminal/sessions/term-1"),
        ("POST", "/api/bots/test/live/terminal/sessions/term-1/input"),
        ("GET", "/api/debug/sandboxes"),
        ("GET", "/api/debug/workflows"),
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

        assert_eq!(response.status(), 401, "{method} {uri} should require auth");
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
                .header("authorization", test_auth_header(SUBMITTER))
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
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let bots = json["bots"].as_array().unwrap();
    let listed = bots
        .iter()
        .find(|b| b["id"].as_str() == Some(&bot.id))
        .expect("Seeded bot should appear in list");
    assert_eq!(listed["submitter_address"], SUBMITTER);
}

#[tokio::test]
async fn test_list_bots_by_call_id_ignores_stale_matches() {
    let _dir = init_test_env();

    let old_bot = seed_bot_with_identity("dup-old", "dex", false, None, 7, 9, 1000);
    let new_bot = seed_bot_with_identity("dup-new", "dex", false, None, 7, 9, 2000);
    let _ = sandbox_runtime::runtime::sandboxes()
        .expect("sandbox store")
        .remove(&old_bot.sandbox_id);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots?call_id=7&service_id=9")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let bots = json["bots"].as_array().expect("bots array");

    assert_eq!(
        bots.len(),
        1,
        "call_id/service_id lookup should resolve to one live bot"
    );
    assert_eq!(bots[0]["id"], new_bot.id);
    assert_ne!(bots[0]["id"], old_bot.id);
}

#[tokio::test]
async fn test_list_bots_by_call_id_returns_conflict_for_multiple_live_matches() {
    let _dir = init_test_env();

    let _first = seed_bot_with_identity("dup-live-1", "dex", false, None, 17, 19, 1000);
    let _second = seed_bot_with_identity("dup-live-2", "dex", false, None, 17, 19, 2000);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots?call_id=17&service_id=19")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], "conflict");
    assert!(
        json["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Multiple live bots found")
    );
}

#[tokio::test]
async fn test_get_bot_detail() {
    let _dir = init_test_env();

    let bot = seed_bot("detail-bot-1", "perp", false);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
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
    assert!(
        json["trading_api_token"].is_null(),
        "token should not be serialized"
    );
}

#[tokio::test]
async fn test_get_bot_not_found() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots/nonexistent-bot-xyz")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn test_terminal_routes_proxy_live_session_lifecycle() {
    let _dir = init_test_env();

    let bot = seed_bot("terminal-bot-1", "dex", true);
    let sidecar_url = spawn_mock_terminal_sidecar().await;
    set_sandbox_sidecar_url(&bot.sandbox_id, &sidecar_url);
    let auth = test_auth_header(SUBMITTER);

    let list_response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/live/terminal/sessions", bot.id))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = list_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    assert_eq!(list_json["sessions"][0]["session_id"], "term-1");

    let create_response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/bots/{}/live/terminal/sessions", bot.id))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"cols":120,"rows":32}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::OK);
    let create_body = create_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let create_json: serde_json::Value = serde_json::from_slice(&create_body).unwrap();
    assert_eq!(create_json["session_id"], "term-1");

    let resize_response = app()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/bots/{}/live/terminal/sessions/term-1",
                    bot.id
                ))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"cols":100,"rows":28}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resize_response.status(), StatusCode::OK);

    let input_response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/bots/{}/live/terminal/sessions/term-1/input",
                    bot.id
                ))
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"data":"pwd\n"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(input_response.status(), StatusCode::OK);

    let stream_response = app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/bots/{}/live/terminal/sessions/term-1/stream",
                    bot.id
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stream_response.status(), StatusCode::OK);
    assert_eq!(
        stream_response.headers().get(CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let stream_body = stream_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let stream_text = String::from_utf8(stream_body.to_vec()).unwrap();
    assert!(stream_text.contains("hello from shell"));

    let delete_response = app()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!(
                    "/api/bots/{}/live/terminal/sessions/term-1",
                    bot.id
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::OK);
    let delete_body = delete_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let delete_json: serde_json::Value = serde_json::from_slice(&delete_body).unwrap();
    assert_eq!(delete_json["deleted"], true);
    assert_eq!(delete_json["session_id"], "term-1");
}

#[tokio::test]
async fn test_chat_routes_only_expose_manual_sessions() {
    let _ = init_test_env();
    let bot = seed_bot("test-bot", "dex", true);
    let sidecar_url = spawn_mock_chat_sidecar(&bot.id).await;
    set_sandbox_sidecar_url(&bot.sandbox_id, &sidecar_url);
    let auth = test_auth_header(SUBMITTER);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots/test-bot/session/sessions")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        json,
        json!([{ "id": "manual-1", "title": "New Chat", "session_type": "manual" }])
    );

    let auto_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots/test-bot/session/sessions/trading-test-bot")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(auto_response.status(), StatusCode::OK);

    for blocked_session in ["fast-test-bot", "research-test-bot", "convo-test-bot"] {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/bots/test-bot/session/sessions/{blocked_session}"
                    ))
                    .header("authorization", &auth)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let all_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots/test-bot/session/sessions?includeAutonomous=1")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(all_response.status(), StatusCode::OK);
    let all_body = all_response.into_body().collect().await.unwrap().to_bytes();
    let all_json: serde_json::Value = serde_json::from_slice(&all_body).unwrap();
    assert_eq!(
        all_json,
        json!([
            { "id": "manual-1", "title": "New Chat", "session_type": "manual" },
            { "id": "trading-test-bot", "session_type": "autonomous" },
            { "id": "trading-test-bot-1775823900", "session_type": "autonomous" },
            { "id": "fast-test-bot", "session_type": "autonomous" },
            { "id": "research-test-bot", "session_type": "autonomous" },
            { "id": "convo-test-bot", "session_type": "autonomous" }
        ])
    );

    let auto_messages_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bots/test-bot/session/sessions/fast-test-bot/messages")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(auto_messages_response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_runs_routes_expose_autonomous_history_without_transcript() {
    let _ = init_test_env();
    let bot = seed_bot_with_workflow("runs-bot", "dex", true, Some(9_100_001));
    let auth = test_auth_header(SUBMITTER);

    ai_agent_sandbox_blueprint_lib::workflows::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "run-success".to_string(),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunRecord {
                run_id: "run-success".to_string(),
                workflow_id: 9_100_002,
                status: ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunStatus::Completed,
                started_at: 1_775_823_700,
                completed_at: Some(1_775_823_760),
                session_id: Some("research-runs-bot-1775823700".to_string()),
                trace_id: Some("trace-success".to_string()),
                duration_ms: 60_000,
                input_tokens: 120,
                output_tokens: 48,
                result: Some("No trade placed".to_string()),
                error: None,
            },
        )
        .expect("insert successful run");
    ai_agent_sandbox_blueprint_lib::workflows::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "run-failed".to_string(),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunRecord {
                run_id: "run-failed".to_string(),
                workflow_id: bot.workflow_id.expect("workflow id"),
                status: ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunStatus::Failed,
                started_at: 1_775_823_900,
                completed_at: Some(1_775_823_901),
                session_id: None,
                trace_id: None,
                duration_ms: 0,
                input_tokens: 0,
                output_tokens: 0,
                result: None,
                error: Some("AGENT_EXECUTION_FAILED".to_string()),
            },
        )
        .expect("insert failed run");
    ai_agent_sandbox_blueprint_lib::workflows::insert_workflow_run_transcript_for_testing(
        ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunTranscriptRecord {
            run_id: "run-success".to_string(),
            session_id: "research-runs-bot-1775823700".to_string(),
            captured_at: 1_775_823_760,
            messages: json!([
                {
                    "info": {
                        "id": "msg-user",
                        "role": "user",
                        "timestamp": "2026-04-24T07:00:00.000Z"
                    },
                    "parts": [{ "type": "text", "text": "Research tick" }]
                },
                {
                    "info": {
                        "id": "msg-assistant",
                        "role": "assistant",
                        "timestamp": "2026-04-24T07:00:10.000Z"
                    },
                    "parts": [{ "type": "text", "text": "Conversation loop completed" }]
                }
            ]),
        },
    )
    .expect("insert transcript snapshot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/runs", bot.id))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["runs"][0]["run_id"], "run-failed");
    assert_eq!(json["runs"][0]["workflow_kind"], "trading");
    assert_eq!(json["runs"][0]["status"], "failed");
    assert_eq!(json["runs"][0]["transcript_available"], false);
    assert_eq!(json["runs"][0]["error"], "AGENT_EXECUTION_FAILED");
    assert_eq!(json["runs"][1]["run_id"], "run-success");
    assert_eq!(json["runs"][1]["workflow_kind"], "research");
    assert_eq!(json["runs"][1]["transcript_available"], true);
    assert!(json["next_cursor"].is_null());

    let transcript_response = app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/bots/{}/session/sessions/research-runs-bot-1775823700/messages?limit=200",
                    bot.id
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(transcript_response.status(), StatusCode::OK);
    let transcript_body = transcript_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let transcript_json: serde_json::Value = serde_json::from_slice(&transcript_body).unwrap();
    assert_eq!(transcript_json[0]["info"]["id"], "msg-user");
    assert_eq!(transcript_json[1]["info"]["id"], "msg-assistant");

    let detail_response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/runs/run-failed", bot.id))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(detail_response.status(), StatusCode::OK);
    let detail_body = detail_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let detail_json: serde_json::Value = serde_json::from_slice(&detail_body).unwrap();
    assert_eq!(detail_json["run_id"], "run-failed");
    assert_eq!(detail_json["transcript_available"], false);
    assert_eq!(detail_json["error"], "AGENT_EXECUTION_FAILED");
}

#[tokio::test]
async fn test_running_autonomous_sessions_preserve_live_message_errors() {
    let _ = init_test_env();
    let bot = seed_bot_with_workflow("runs-live-error-bot", "dex", true, Some(9_100_101));
    let auth = test_auth_header(SUBMITTER);
    let sidecar_url =
        spawn_mock_chat_sidecar_with_message_status(&bot.id, StatusCode::INTERNAL_SERVER_ERROR)
            .await;
    set_sandbox_sidecar_url(&bot.sandbox_id, &sidecar_url);

    ai_agent_sandbox_blueprint_lib::workflows::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "run-live-error".to_string(),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunRecord {
                run_id: "run-live-error".to_string(),
                workflow_id: bot.workflow_id.expect("workflow id"),
                status: ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunStatus::Running,
                started_at: 1_775_823_950,
                completed_at: None,
                session_id: Some("research-runs-live-error-bot".to_string()),
                trace_id: Some("trace-live-error".to_string()),
                duration_ms: 15_000,
                input_tokens: 42,
                output_tokens: 21,
                result: None,
                error: None,
            },
        )
        .expect("insert running run");
    ai_agent_sandbox_blueprint_lib::workflows::insert_workflow_run_transcript_for_testing(
        ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunTranscriptRecord {
            run_id: "run-live-error".to_string(),
            session_id: "research-runs-live-error-bot".to_string(),
            captured_at: 1_775_823_955,
            messages: json!([
                {
                    "info": {
                        "id": "stale-msg",
                        "role": "assistant",
                        "timestamp": "2026-04-24T07:05:00.000Z"
                    },
                    "parts": [{ "type": "text", "text": "stale transcript" }]
                }
            ]),
        },
    )
    .expect("insert stale transcript snapshot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/bots/{}/session/sessions/research-runs-live-error-bot/messages?limit=200",
                    bot.id
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn test_archived_transcript_replay_honors_limit_and_cursor() {
    let _ = init_test_env();
    let bot = seed_bot_with_workflow("runs-paged-bot", "dex", true, Some(9_100_201));
    let auth = test_auth_header(SUBMITTER);
    let sidecar_url =
        spawn_mock_chat_sidecar_with_message_status(&bot.id, StatusCode::NOT_FOUND).await;
    set_sandbox_sidecar_url(&bot.sandbox_id, &sidecar_url);

    ai_agent_sandbox_blueprint_lib::workflows::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "run-paged".to_string(),
            ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunRecord {
                run_id: "run-paged".to_string(),
                workflow_id: bot.workflow_id.expect("workflow id"),
                status: ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunStatus::Completed,
                started_at: 1_775_824_000,
                completed_at: Some(1_775_824_060),
                session_id: Some("research-runs-paged-bot".to_string()),
                trace_id: Some("trace-paged".to_string()),
                duration_ms: 60_000,
                input_tokens: 30,
                output_tokens: 18,
                result: Some("Replay finished".to_string()),
                error: None,
            },
        )
        .expect("insert completed run");
    ai_agent_sandbox_blueprint_lib::workflows::insert_workflow_run_transcript_for_testing(
        ai_agent_sandbox_blueprint_lib::workflows::WorkflowRunTranscriptRecord {
            run_id: "run-paged".to_string(),
            session_id: "research-runs-paged-bot".to_string(),
            captured_at: 1_775_824_060,
            messages: json!([
                {
                    "info": { "id": "msg-1", "role": "user", "timestamp": "2026-04-24T07:10:00.000Z" },
                    "parts": [{ "type": "text", "text": "first" }]
                },
                {
                    "info": { "id": "msg-2", "role": "assistant", "timestamp": "2026-04-24T07:10:05.000Z" },
                    "parts": [{ "type": "text", "text": "second" }]
                },
                {
                    "info": { "id": "msg-3", "role": "assistant", "timestamp": "2026-04-24T07:10:10.000Z" },
                    "parts": [{ "type": "text", "text": "third" }]
                }
            ]),
        },
    )
    .expect("insert transcript snapshot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/bots/{}/session/sessions/research-runs-paged-bot/messages?limit=2",
                    bot.id
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["messages"][0]["info"]["id"], "msg-2");
    assert_eq!(json["messages"][1]["info"]["id"], "msg-3");
    assert_eq!(json["next_cursor"], "1");

    let cursor_response = app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/bots/{}/session/sessions/research-runs-paged-bot/messages?limit=1&cursor=1",
                    bot.id
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cursor_response.status(), StatusCode::OK);
    let cursor_body = cursor_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let cursor_json: serde_json::Value = serde_json::from_slice(&cursor_body).unwrap();
    assert_eq!(cursor_json["messages"][0]["info"]["id"], "msg-1");
    assert!(cursor_json["next_cursor"].is_null());
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
                .uri(format!("/api/bots/{}/start", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // start_core uses best-effort Docker ops — no real container in test,
    // but handler succeeds (logs warning instead of failing).
    let status = response.status().as_u16();
    assert_ne!(status, 401, "Should pass auth");
    assert_ne!(status, 403, "Should pass submitter check");
    assert_ne!(status, 404, "Bot should be found");
    assert!(
        status == 200 || status == 500,
        "Expected 200 (best-effort Docker) or 500, got {status}"
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
                .uri(format!("/api/bots/{}/stop", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // stop_core uses best-effort Docker ops — no real container in test,
    // but handler succeeds (logs warning instead of failing).
    let status = response.status().as_u16();
    assert_ne!(status, 401, "Should pass auth");
    assert_ne!(status, 403, "Should pass submitter check");
    assert_ne!(status, 404, "Bot should be found");
    assert!(
        status == 200 || status == 500,
        "Expected 200 (best-effort Docker) or 500, got {status}"
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
                .uri(format!("/api/bots/{}/secrets", bot.id))
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
async fn test_get_secrets_returns_owner_env() {
    let _dir = init_test_env();

    let bot = seed_bot("secrets-get-1", "dex", false);
    mark_sandbox_secrets_configured(&bot.sandbox_id);

    let response = app()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/bots/{}/secrets", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["sandbox_id"], bot.sandbox_id);
    assert_eq!(json["env_json"]["ANTHROPIC_API_KEY"], "sk-test");
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
                .uri(format!("/api/bots/{}/config", bot.id))
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
                .uri(format!("/api/bots/{}/metrics", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
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
async fn test_get_bot_metrics_prefers_remote_portfolio_and_history_summary() {
    let _dir = init_test_env();

    let bot = seed_bot("metrics-bot-remote", "dex", true);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/metrics", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["portfolio_value_usd"], 1050.0);
    assert_eq!(json["total_pnl"], 46.0);
    assert_eq!(json["trade_count"], 1);
}

#[tokio::test]
async fn test_get_bot_trades() {
    let _dir = init_test_env();

    let bot = seed_bot("trades-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/trades", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
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
async fn test_get_bot_trades_prefers_remote_trading_api_payload() {
    let _dir = init_test_env();

    let bot = seed_bot("trades-bot-remote", "dex", true);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/trades", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json[0]["id"], "remote-trade-1");
    assert_eq!(
        json[0]["validation"]["responses"][0]["reasoning"],
        "trade looks safe"
    );
}

#[tokio::test]
async fn test_get_bot_portfolio() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-bot-1", "dex", true);
    mark_sandbox_secrets_configured(&bot.sandbox_id);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/portfolio/state", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["total_value_usd"].is_number());
    assert!(json["cash_balance"].is_null());
    assert!(json["positions"].is_array());
}

#[tokio::test]
async fn test_get_bot_portfolio_prefers_remote_trading_api_payload() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-bot-remote", "dex", true);
    mark_sandbox_secrets_configured(&bot.sandbox_id);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/portfolio/state", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["total_value_usd"], 1050.0);
    assert!(json["cash_balance"].is_null());
    assert_eq!(json["positions"][0]["token"], "WETH");
    assert_eq!(json["positions"][0]["value_usd"], 1050.0);
    assert_eq!(json["positions"][0]["valuation_status"], "priced");
}

#[tokio::test]
async fn test_get_bot_portfolio_preserves_full_remote_token_addresses() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-bot-remote-address", "dex", true);
    mark_sandbox_secrets_configured(&bot.sandbox_id);
    let trading_api_url =
        spawn_mock_trading_api_with_address_portfolio("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
            .await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/portfolio/state", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        json["positions"][0]["token"],
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    );
    assert_eq!(
        json["positions"][0]["symbol"],
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    );
}

#[tokio::test]
async fn test_get_bot_portfolio_prefers_remote_payload_even_when_stopped() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-bot-stopped-remote", "dex", false);
    mark_sandbox_secrets_configured(&bot.sandbox_id);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/portfolio/state", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["total_value_usd"], 1050.0);
    assert_eq!(json["positions"][0]["token"], "WETH");
    assert_eq!(json["positions"][0]["current_price"], 2100.0);
}

#[tokio::test]
async fn test_get_bot_portfolio_preserves_remote_value_only_positions() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-bot-value-only-remote", "dex", true);
    mark_sandbox_secrets_configured(&bot.sandbox_id);
    let trading_api_url = spawn_mock_trading_api_value_only().await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/portfolio/state", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["cash_balance"], 9000.0);
    assert_eq!(json["has_value_only_positions"], true);
    assert_eq!(json["positions"][0]["valuation_status"], "value_only");
    assert!(json["positions"][0]["entry_price"].is_null());
}

#[tokio::test]
async fn test_fallback_portfolio_recovers_swap_trade_store_positions() {
    let _dir = init_test_env();

    let bot = seed_bot("portfolio-swap-fallback", "dex", true);
    mark_sandbox_secrets_configured(&bot.sandbox_id);
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url.clear();
            record.trading_api_token.clear();
        })
        .expect("update bot");

    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: "swap-only-trade".to_string(),
        bot_id: bot.id.clone(),
        timestamp: chrono::Utc::now(),
        action: "swap".to_string(),
        token_in: "USDC".to_string(),
        token_out: "WETH".to_string(),
        amount_in: "1000".to_string(),
        min_amount_out: "0.5".to_string(),
        target_protocol: "uniswap_v3".to_string(),
        tx_hash: "0xfallback".to_string(),
        block_number: Some(1),
        gas_used: Some("21000".to_string()),
        paper_trade: true,
        execution_status: None,
        clob_order_id: None,
        amount_out: None,
        entry_price_usd: None,
        notional_usd: None,
        requested_price_usd: None,
        filled_price_usd: None,
        filled_amount: None,
        slippage_bps: None,
        execution_reason: None,
        prediction_metadata: None,
        valuation_status: trading_http_api::trade_store::TradeValuationStatus::Unpriced,
        validation: trading_http_api::trade_store::StoredValidation {
            approved: true,
            aggregate_score: 100,
            intent_hash: "0xintent-fallback".to_string(),
            responses: Vec::new(),
            simulation: None,
        },
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    })
    .await
    .expect("record trade");

    let portfolio_response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/portfolio/state", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(portfolio_response.status(), 200);
    let portfolio_body = portfolio_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let portfolio_json: serde_json::Value = serde_json::from_slice(&portfolio_body).unwrap();
    let positions = portfolio_json["positions"]
        .as_array()
        .expect("portfolio positions array");
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["token"], "WETH");
    assert_eq!(positions[0]["amount"], 0.5);
    assert_eq!(positions[0]["valuation_status"], "value_only");
    assert_eq!(positions[0]["current_price"], 2000.0);
    assert_eq!(portfolio_json["cash_balance"], 0.0);
    assert_eq!(portfolio_json["has_value_only_positions"], true);
}

#[tokio::test]
async fn test_get_bot_metrics_history() {
    let _dir = init_test_env();

    let bot = seed_bot("history-bot-1", "dex", true);

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/metrics/history", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
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

#[tokio::test]
async fn test_get_bot_metrics_history_prefers_remote_trading_api_payload() {
    let _dir = init_test_env();

    let bot = seed_bot("history-bot-remote", "dex", true);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = trading_api_url.clone();
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/metrics/history", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json[0]["account_value_usd"], 10123.45);
}

#[tokio::test]
async fn test_get_bot_metrics_history_falls_back_when_remote_payload_is_empty() {
    let _dir = init_test_env();

    let bot = seed_bot("history-bot-empty-remote", "dex", true);
    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: "executed-trade-1".to_string(),
        bot_id: bot.id.clone(),
        timestamp: chrono::Utc::now(),
        action: "swap".to_string(),
        token_in: "WETH".to_string(),
        token_out: "USDC".to_string(),
        amount_in: "0.05".to_string(),
        min_amount_out: "100".to_string(),
        target_protocol: "uniswap_v3".to_string(),
        tx_hash: "0xremote-empty".to_string(),
        block_number: Some(1),
        gas_used: Some("21000".to_string()),
        paper_trade: false,
        execution_status: None,
        clob_order_id: None,
        amount_out: Some("105".to_string()),
        entry_price_usd: Some("2100".to_string()),
        notional_usd: Some("105".to_string()),
        requested_price_usd: None,
        filled_price_usd: None,
        filled_amount: None,
        slippage_bps: None,
        execution_reason: None,
        prediction_metadata: None,
        valuation_status: trading_http_api::trade_store::TradeValuationStatus::Priced,
        validation: trading_http_api::trade_store::StoredValidation {
            approved: true,
            aggregate_score: 100,
            intent_hash: "0xintent-empty-remote".to_string(),
            responses: Vec::new(),
            simulation: None,
        },
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    })
    .await
    .expect("record trade");

    let mock_app = Router::new().route(
        "/metrics/history",
        get(|| async { Json(json!({ "snapshots": [], "total": 0 })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock trading api");
    let addr = listener.local_addr().expect("mock trading api addr");
    tokio::spawn(async move {
        axum::serve(listener, mock_app)
            .await
            .expect("serve mock trading api");
    });

    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = format!("http://{addr}");
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/metrics/history", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let snapshots = json.as_array().expect("metrics history should be an array");
    assert!(
        snapshots.len() >= 2,
        "fallback history should synthesize snapshots"
    );
    let latest = snapshots.last().expect("latest snapshot");
    assert_eq!(latest["trade_count"], 1);
}

#[tokio::test]
async fn test_get_bot_metrics_history_fallback_respects_limit_query() {
    let _dir = init_test_env();

    let bot = seed_bot("history-bot-empty-remote-limit", "dex", true);
    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: "executed-trade-limit-1".to_string(),
        bot_id: bot.id.clone(),
        timestamp: chrono::Utc::now(),
        action: "swap".to_string(),
        token_in: "WETH".to_string(),
        token_out: "USDC".to_string(),
        amount_in: "0.05".to_string(),
        min_amount_out: "100".to_string(),
        target_protocol: "uniswap_v3".to_string(),
        tx_hash: "0xremote-empty-limit".to_string(),
        block_number: Some(1),
        gas_used: Some("21000".to_string()),
        paper_trade: false,
        execution_status: None,
        clob_order_id: None,
        amount_out: Some("105".to_string()),
        entry_price_usd: Some("2100".to_string()),
        notional_usd: Some("105".to_string()),
        requested_price_usd: None,
        filled_price_usd: None,
        filled_amount: None,
        slippage_bps: None,
        execution_reason: None,
        prediction_metadata: None,
        valuation_status: trading_http_api::trade_store::TradeValuationStatus::Priced,
        validation: trading_http_api::trade_store::StoredValidation {
            approved: true,
            aggregate_score: 100,
            intent_hash: "0xintent-empty-remote-limit".to_string(),
            responses: Vec::new(),
            simulation: None,
        },
        signal_price: None,
        fill_price: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
    })
    .await
    .expect("record trade");

    let mock_app = Router::new().route(
        "/metrics/history",
        get(|| async { Json(json!({ "snapshots": [], "total": 0 })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock trading api");
    let addr = listener.local_addr().expect("mock trading api addr");
    tokio::spawn(async move {
        axum::serve(listener, mock_app)
            .await
            .expect("serve mock trading api");
    });

    state::bots()
        .expect("bots store")
        .update(&state::bot_key(&bot.id), |record| {
            record.trading_api_url = format!("http://{addr}");
            record.trading_api_token = "remote-token".to_string();
        })
        .expect("update bot");

    let response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bots/{}/metrics/history?limit=1", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let snapshots = json.as_array().expect("metrics history should be an array");
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0]["trade_count"], 0);
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
                .uri(format!("/api/bots/{}/activation-progress", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
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
                .uri(format!("/api/bots/{}/activation-progress", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
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
    assert_eq!(json["pricing_model"], "subscription");
    assert!(json["job_multipliers"].is_object());
    assert_eq!(json["job_multipliers"]["provision"], 50);
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
    assert_eq!(json["pricing_model"], "subscription");
    assert_eq!(json["per_job_cost"], "0");
    assert_eq!(json["job_index"], 0);
    assert_eq!(json["multiplier"], 50); // provision = 50x
}

#[tokio::test]
async fn test_pricing_config() {
    let _dir = init_test_env();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/pricing/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["pricing_model"], "subscription");
    assert!(json["subscription_rate"].is_string());
    assert!(json["subscription_interval"].is_number());
    assert!(json["job_multipliers"].is_object());
    assert_eq!(json["job_multipliers"]["provision"], 50);
    assert_eq!(json["job_multipliers"]["status"], 0);
}

#[tokio::test]
async fn test_billing_status_requires_tangle_contract() {
    let _dir = init_test_env();
    // TANGLE_CONTRACT is not set, so billing status should return 503
    unsafe { std::env::remove_var("TANGLE_CONTRACT") };

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/pricing/billing/1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
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
                .header("authorization", test_auth_header(SUBMITTER))
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
                .header("authorization", test_auth_header(SUBMITTER))
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
                .header("authorization", test_auth_header(SUBMITTER))
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
                .header("authorization", test_auth_header(SUBMITTER))
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
                .uri(format!("/api/bots/{}/run-now", bot.id))
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 409);
}

// ---------------------------------------------------------------------------
// Secrets injection success-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_configure_secrets_correct_submitter_reaches_activation() {
    let _dir = init_test_env();
    let bot = seed_bot("secrets-ok-1", "dex", false);

    let body = serde_json::json!({
        "env_json": { "ANTHROPIC_API_KEY": "sk-test-key-123" },
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/bots/{}/secrets", bot.id))
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
    assert_eq!(
        status, 500,
        "Expected 500 from sandbox/activation layer (no Docker container)"
    );

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let err = String::from_utf8_lossy(&body);
    // The error should mention activation/sandbox, not auth
    assert!(
        err.contains("Bot")
            || err.contains("sandbox")
            || err.contains("secrets")
            || err.contains("inject")
            || err.contains("activate"),
        "Error should be from activation layer, got: {err}"
    );
}

#[tokio::test]
async fn test_wipe_secrets_requires_existing_secrets() {
    let _dir = init_test_env();
    let bot = seed_bot("wipe-nosec-1", "dex", false);

    let response = app()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/bots/{}/secrets", bot.id))
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
        err.contains("no secrets")
            || err.contains("has no")
            || err.contains("Bot")
            || err.contains("Sandbox")
            || err.contains("not found"),
        "Error should be from sandbox/secrets layer, got: {err}"
    );
}

#[tokio::test]
async fn test_configure_secrets_bot_not_found() {
    let _dir = init_test_env();

    let body = serde_json::json!({
        "env_json": { "ANTHROPIC_API_KEY": "sk-test" },
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bots/nonexistent-bot-xyz/secrets")
                .header("content-type", "application/json")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn test_configure_secrets_missing_sandbox_returns_stale_state_error() {
    let _dir = init_test_env();

    let bot = seed_bot("secrets-stale-1", "dex", false);
    let _ = sandbox_runtime::runtime::sandboxes()
        .expect("sandbox store")
        .remove(&bot.sandbox_id);

    let body = serde_json::json!({
        "env_json": { "ANTHROPIC_API_KEY": "sk-test-key-123" },
    });

    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/bots/{}/secrets", bot.id))
                .header("content-type", "application/json")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], "stale_state");
    assert_eq!(json["bot_id"], bot.id);
    assert_eq!(json["sandbox_id"], bot.sandbox_id);
    assert!(
        json["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Operator state is stale")
    );
}
