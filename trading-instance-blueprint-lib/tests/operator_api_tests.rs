//! Instance operator API E2E tests.
//!
//! Tests exercise `build_instance_router()` with seeded singleton bot records
//! and real PASETO auth tokens via `tower::ServiceExt::oneshot`.
//!
//! **Serialised**: all tests acquire `HARNESS_LOCK` because they share the
//! process-global instance singleton store.

mod common;

use axum::body::Body;
use axum::extract::Path;
use axum::http::header::CONTENT_TYPE;
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use hyper::{Request, StatusCode};
use serde_json::json;
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

fn mark_sandbox_secrets_configured(sandbox_id: &str) {
    let mut record =
        sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id).expect("sandbox exists");
    record.user_env_json = r#"{"ANTHROPIC_API_KEY":"sk-test"}"#.to_string();
    sandbox_runtime::runtime::sandboxes()
        .unwrap()
        .insert(sandbox_id.to_string(), record)
        .unwrap();
}

fn set_sandbox_sidecar_url(sandbox_id: &str, sidecar_url: &str) {
    let mut record =
        sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id).expect("sandbox exists");
    record.sidecar_url = sidecar_url.to_string();
    sandbox_runtime::runtime::sandboxes()
        .unwrap()
        .insert(sandbox_id.to_string(), record)
        .unwrap();
}

fn app() -> axum::Router {
    build_instance_router()
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
                    "event: data.stdout\ndata: {\"type\":\"data.stdout\",\"properties\":{\"text\":\"hello from instance shell\\r\\n\"}}\n\n",
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
    let app = Router::new()
        .route(
            "/agents/sessions",
            get(move || {
                let workflow_session = workflow_session.clone();
                let tick_session = tick_session.clone();
                async move {
                    Json(json!([
                        {"id": "manual-1", "title": "New Chat"},
                        {"id": workflow_session},
                        {"id": tick_session}
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
    let app = Router::new()
        .route(
            "/agents/sessions",
            get(move || {
                let workflow_session = workflow_session.clone();
                let tick_session = tick_session.clone();
                async move {
                    Json(json!([
                        {"id": "manual-1", "title": "New Chat"},
                        {"id": workflow_session},
                        {"id": tick_session}
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
// GET /api/bot (singleton resolution)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_get_bot_when_provisioned() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, _sandbox_id) = seed_singleton("dex");
    mark_sandbox_secrets_configured(&_sandbox_id);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot")
                .header("authorization", test_auth_header(SUBMITTER))
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
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 404);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_operator_meta_reports_instance_contract() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

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
    assert_eq!(json["deployment_kind"], "instance");
    assert!(json["features"]["chat"].is_boolean());
    assert!(json["features"]["terminal"].is_boolean());

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
        // Write endpoints
        ("POST", "/api/bot/secrets"),
        ("DELETE", "/api/bot/secrets"),
        ("POST", "/api/bot/start"),
        ("POST", "/api/bot/stop"),
        ("POST", "/api/bot/run-now"),
        ("POST", "/api/bot/live/terminal/sessions"),
        ("PATCH", "/api/bot/live/terminal/sessions/term-1"),
        ("DELETE", "/api/bot/live/terminal/sessions/term-1"),
        ("POST", "/api/bot/live/terminal/sessions/term-1/input"),
        // Read endpoints
        ("GET", "/api/bot"),
        ("GET", "/api/bot/metrics"),
        ("GET", "/api/bot/metrics/history"),
        ("GET", "/api/bot/trades"),
        ("GET", "/api/bot/portfolio/state"),
        ("GET", "/api/bot/activation-progress"),
        ("GET", "/api/bot/live/terminal/sessions"),
        ("GET", "/api/bot/live/terminal/sessions/term-1/stream"),
        ("GET", "/api/provisions"),
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
// Start / Stop singleton
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_start_stop_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, _sandbox_id) = seed_singleton("dex");

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

#[tokio::test]
async fn test_terminal_routes_proxy_live_session_lifecycle() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, sandbox_id) = seed_singleton("dex");
    let sidecar_url = spawn_mock_terminal_sidecar().await;
    set_sandbox_sidecar_url(&sandbox_id, &sidecar_url);
    let auth = test_auth_header(SUBMITTER);

    let list_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/live/terminal/sessions")
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
                .uri("/api/bot/live/terminal/sessions")
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
                .uri("/api/bot/live/terminal/sessions/term-1")
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
                .uri("/api/bot/live/terminal/sessions/term-1/input")
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
                .uri("/api/bot/live/terminal/sessions/term-1/stream")
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
    assert!(stream_text.contains("hello from instance shell"));

    let delete_response = app()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/bot/live/terminal/sessions/term-1")
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

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_chat_routes_only_expose_manual_sessions() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("dex");
    let sidecar_url = spawn_mock_chat_sidecar(&bot_id).await;
    set_sandbox_sidecar_url(&sandbox_id, &sidecar_url);
    let auth = test_auth_header(SUBMITTER);

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/session/sessions")
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
                .uri(format!("/api/bot/session/sessions/trading-{bot_id}"))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(auto_response.status(), StatusCode::OK);

    let all_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/session/sessions?includeAutonomous=1")
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
            { "id": format!("trading-{bot_id}"), "session_type": "autonomous" },
            { "id": format!("trading-{bot_id}-1775823900"), "session_type": "autonomous" }
        ])
    );

    let auto_messages_response = app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/bot/session/sessions/trading-{bot_id}/messages"
                ))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(auto_messages_response.status(), StatusCode::OK);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_runs_routes_expose_autonomous_history_without_transcript() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, _sandbox_id) = seed_singleton("dex");
    let workflow_id = 9_200_001_u64;
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.workflow_id = Some(workflow_id);
        })
        .unwrap();
    let auth = test_auth_header(SUBMITTER);

    trading_blueprint_lib::workflow_compat::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "instance-run-success".to_string(),
            trading_blueprint_lib::workflow_compat::WorkflowRunRecord {
                run_id: "instance-run-success".to_string(),
                workflow_id: workflow_id + 2,
                status: trading_blueprint_lib::workflow_compat::WorkflowRunStatus::Completed,
                started_at: 1_775_823_500,
                completed_at: Some(1_775_823_560),
                session_id: Some("convo-instance-1775823500".to_string()),
                trace_id: Some("trace-instance-success".to_string()),
                duration_ms: 60_000,
                input_tokens: 80,
                output_tokens: 40,
                result: Some("Conversation loop completed".to_string()),
                error: None,
            },
        )
        .expect("insert successful run");
    trading_blueprint_lib::workflow_compat::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "instance-run-failed".to_string(),
            trading_blueprint_lib::workflow_compat::WorkflowRunRecord {
                run_id: "instance-run-failed".to_string(),
                workflow_id,
                status: trading_blueprint_lib::workflow_compat::WorkflowRunStatus::Failed,
                started_at: 1_775_823_800,
                completed_at: Some(1_775_823_801),
                session_id: None,
                trace_id: None,
                duration_ms: 0,
                input_tokens: 0,
                output_tokens: 0,
                result: None,
                error: Some("Provider credits exhausted".to_string()),
            },
        )
        .expect("insert failed run");
    trading_blueprint_lib::workflow_compat::insert_workflow_run_transcript_for_testing(
        trading_blueprint_lib::workflow_compat::WorkflowRunTranscriptRecord {
            run_id: "instance-run-success".to_string(),
            session_id: "convo-instance-1775823500".to_string(),
            captured_at: 1_775_823_560,
            messages: json!([
                {
                    "info": {
                        "id": "msg-user",
                        "role": "user",
                        "timestamp": "2026-04-24T07:00:00.000Z"
                    },
                    "parts": [{ "type": "text", "text": "Conversation tick" }]
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
                .uri("/api/bot/runs")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["runs"][0]["run_id"], "instance-run-failed");
    assert_eq!(json["runs"][0]["workflow_kind"], "trading");
    assert_eq!(json["runs"][0]["transcript_available"], false);
    assert_eq!(json["runs"][0]["error"], "Provider credits exhausted");
    assert_eq!(json["runs"][1]["run_id"], "instance-run-success");
    assert_eq!(json["runs"][1]["workflow_kind"], "conversation");
    assert_eq!(json["runs"][1]["transcript_available"], true);

    let transcript_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/session/sessions/convo-instance-1775823500/messages?limit=200")
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
                .uri("/api/bot/runs/instance-run-failed")
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
    assert_eq!(detail_json["run_id"], "instance-run-failed");
    assert_eq!(detail_json["transcript_available"], false);
    assert_eq!(detail_json["error"], "Provider credits exhausted");

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_running_autonomous_sessions_preserve_live_message_errors() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("dex");
    let workflow_id = 9_200_101_u64;
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.workflow_id = Some(workflow_id);
        })
        .unwrap();
    let sidecar_url =
        spawn_mock_chat_sidecar_with_message_status(&bot_id, StatusCode::INTERNAL_SERVER_ERROR)
            .await;
    set_sandbox_sidecar_url(&sandbox_id, &sidecar_url);
    let auth = test_auth_header(SUBMITTER);

    trading_blueprint_lib::workflow_compat::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "instance-run-live-error".to_string(),
            trading_blueprint_lib::workflow_compat::WorkflowRunRecord {
                run_id: "instance-run-live-error".to_string(),
                workflow_id,
                status: trading_blueprint_lib::workflow_compat::WorkflowRunStatus::Running,
                started_at: 1_775_823_950,
                completed_at: None,
                session_id: Some("convo-instance-live-error".to_string()),
                trace_id: Some("trace-instance-live-error".to_string()),
                duration_ms: 15_000,
                input_tokens: 42,
                output_tokens: 21,
                result: None,
                error: None,
            },
        )
        .expect("insert running run");
    trading_blueprint_lib::workflow_compat::insert_workflow_run_transcript_for_testing(
        trading_blueprint_lib::workflow_compat::WorkflowRunTranscriptRecord {
            run_id: "instance-run-live-error".to_string(),
            session_id: "convo-instance-live-error".to_string(),
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
                .uri("/api/bot/session/sessions/convo-instance-live-error/messages?limit=200")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_archived_transcript_replay_honors_limit_and_cursor() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("dex");
    let workflow_id = 9_200_201_u64;
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.workflow_id = Some(workflow_id);
        })
        .unwrap();
    let sidecar_url =
        spawn_mock_chat_sidecar_with_message_status(&bot_id, StatusCode::NOT_FOUND).await;
    set_sandbox_sidecar_url(&sandbox_id, &sidecar_url);
    let auth = test_auth_header(SUBMITTER);

    trading_blueprint_lib::workflow_compat::workflow_runs()
        .expect("workflow runs store")
        .insert(
            "instance-run-paged".to_string(),
            trading_blueprint_lib::workflow_compat::WorkflowRunRecord {
                run_id: "instance-run-paged".to_string(),
                workflow_id,
                status: trading_blueprint_lib::workflow_compat::WorkflowRunStatus::Completed,
                started_at: 1_775_824_000,
                completed_at: Some(1_775_824_060),
                session_id: Some("convo-instance-paged".to_string()),
                trace_id: Some("trace-instance-paged".to_string()),
                duration_ms: 60_000,
                input_tokens: 30,
                output_tokens: 18,
                result: Some("Replay finished".to_string()),
                error: None,
            },
        )
        .expect("insert completed run");
    trading_blueprint_lib::workflow_compat::insert_workflow_run_transcript_for_testing(
        trading_blueprint_lib::workflow_compat::WorkflowRunTranscriptRecord {
            run_id: "instance-run-paged".to_string(),
            session_id: "convo-instance-paged".to_string(),
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
                .uri("/api/bot/session/sessions/convo-instance-paged/messages?limit=2")
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
                .uri("/api/bot/session/sessions/convo-instance-paged/messages?limit=1&cursor=1")
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

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_runs_routes_page_durable_latest_execution_history() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, _sandbox_id) = seed_singleton("dex");
    let workflow_id = 9_200_301_u64;
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.workflow_id = Some(workflow_id);
        })
        .unwrap();
    let auth = test_auth_header(SUBMITTER);

    trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
        workflow_id,
        ai_agent_sandbox_blueprint_lib::workflows::WorkflowLatestExecution {
            executed_at: 1_775_824_300,
            success: true,
            result: "Instance durable run".to_string(),
            error: String::new(),
            trace_id: "trace-instance-durable-1".to_string(),
            duration_ms: 10_000,
            input_tokens: 13,
            output_tokens: 5,
            session_id: "fast-instance-1775824300".to_string(),
        },
    )
    .expect("persist first run");
    trading_blueprint_lib::workflow_compat::persist_latest_execution_run(
        workflow_id,
        ai_agent_sandbox_blueprint_lib::workflows::WorkflowLatestExecution {
            executed_at: 1_775_824_400,
            success: false,
            result: String::new(),
            error: "Instance provider failed".to_string(),
            trace_id: String::new(),
            duration_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            session_id: String::new(),
        },
    )
    .expect("persist second run");

    let first_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/runs?limit=1")
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_body = first_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let first_json: serde_json::Value = serde_json::from_slice(&first_body).unwrap();
    assert_eq!(
        first_json["runs"][0]["run_id"],
        format!("latest-{workflow_id}-1775824400")
    );
    assert_eq!(first_json["runs"][0]["status"], "failed");
    assert_eq!(
        first_json["next_cursor"],
        format!("1775824400:latest-{workflow_id}-1775824400")
    );

    let cursor = first_json["next_cursor"].as_str().expect("cursor");
    let second_response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bot/runs?limit=1&cursor={cursor}"))
                .header("authorization", &auth)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second_response.status(), StatusCode::OK);
    let second_body = second_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let second_json: serde_json::Value = serde_json::from_slice(&second_body).unwrap();
    assert_eq!(
        second_json["runs"][0]["run_id"],
        format!("latest-{workflow_id}-1775824300")
    );
    assert_eq!(second_json["runs"][0]["result"], "Instance durable run");
    assert!(second_json["next_cursor"].is_null());

    let detail_response = app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bot/runs/latest-{workflow_id}-1775824300"))
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
    assert_eq!(
        detail_json["run_id"],
        format!("latest-{workflow_id}-1775824300")
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

    // GET /api/bot/trades
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/trades")
                .header("authorization", test_auth_header(SUBMITTER))
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
    assert!(json["positions"].is_array());

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_metrics_and_trades_prefer_remote_trading_api_payload() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("prediction");
    mark_sandbox_secrets_configured(&sandbox_id);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.trading_api_url = trading_api_url.clone();
            b.trading_api_token = "remote-token".to_string();
        })
        .unwrap();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/trades")
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
        json[0]["validation"]["responses"][0]["reasoning"],
        "trade looks safe"
    );

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/metrics/history")
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

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/metrics")
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

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_portfolio_prefers_remote_trading_api_payload() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("dex");
    mark_sandbox_secrets_configured(&sandbox_id);
    let trading_api_url = spawn_mock_trading_api().await;
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.trading_api_url = trading_api_url.clone();
            b.trading_api_token = "remote-token".to_string();
        })
        .unwrap();

    let response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/portfolio/state")
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

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_fallback_portfolio_and_metrics_ignore_swap_trade_store_records() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (bot_id, sandbox_id) = seed_singleton("dex");
    mark_sandbox_secrets_configured(&sandbox_id);
    state::bots()
        .unwrap()
        .update(&state::bot_key(&bot_id), |b| {
            b.trading_api_url.clear();
            b.trading_api_token.clear();
        })
        .unwrap();

    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: "instance-swap-only-trade".to_string(),
        bot_id: bot_id.clone(),
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
        execution_reason: None,
        prediction_metadata: None,
        valuation_status: trading_http_api::trade_store::TradeValuationStatus::Unpriced,
        validation: trading_http_api::trade_store::StoredValidation {
            approved: true,
            aggregate_score: 100,
            intent_hash: "0xinstance-intent-fallback".to_string(),
            responses: Vec::new(),
            simulation: None,
        },
        signal_price: None,
        fill_price: None,
        slippage_bps: None,
        signal_to_fill_ms: None,
        decision_source: None,
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
        candidate_hash: None,
        revision_id: None,
        paper_pnl_pct: None,
        paper_equity_after: None,
    })
    .await
    .expect("record trade");

    let portfolio_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/portfolio/state")
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
    assert_eq!(portfolio_json["positions"], json!([]));
    assert!(portfolio_json["cash_balance"].is_null());

    let metrics_response = app()
        .oneshot(
            Request::builder()
                .uri("/api/bot/metrics/history")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(metrics_response.status(), 200);
    let metrics_body = metrics_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let metrics_json: serde_json::Value = serde_json::from_slice(&metrics_body).unwrap();
    let latest = metrics_json
        .as_array()
        .and_then(|snapshots| snapshots.last())
        .expect("latest snapshot");
    assert_eq!(latest["positions_count"], 0);
    assert_eq!(latest["unrealized_pnl"], 0.0);

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

    // GET /api/debug/workflows
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
                .header("authorization", test_auth_header(SUBMITTER))
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

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_get_secrets_returns_owner_env() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, sandbox_id) = seed_singleton("dex");
    mark_sandbox_secrets_configured(&sandbox_id);

    let response = app()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/bot/secrets")
                .header("authorization", test_auth_header(SUBMITTER))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["sandbox_id"], sandbox_id);
    assert_eq!(json["env_json"]["ANTHROPIC_API_KEY"], "sk-test");

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
        err.contains("no secrets")
            || err.contains("has no")
            || err.contains("Bot")
            || err.contains("Sandbox")
            || err.contains("not found"),
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

#[tokio::test]
async fn test_configure_secrets_missing_sandbox_returns_stale_state_error() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let (_bot_id, sandbox_id) = seed_singleton("dex");
    let _ = sandbox_runtime::runtime::sandboxes()
        .expect("sandbox store")
        .remove(&sandbox_id);

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

    assert_eq!(response.status(), 409);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], "stale_state");
    assert_eq!(json["sandbox_id"], sandbox_id);
    assert!(
        json["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Operator state is stale")
    );

    let _ = clear_instance_bot_id();
}
