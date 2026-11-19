//! Integration tests for the wallet-approved trading-desk connection
//! (`/api/trading-desk/*`).
//!
//! Covers the OAuth2 + PKCE authorization flow, the narrow desk credential
//! surface (account / submit / get / revoke), grant-to-bot binding drift,
//! revocation, and the consumer-contract order wire shapes against the
//! paper executor on anvil (31337).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Once};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use sandbox_runtime::session_auth::create_test_token;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use trading_http_api::trading_desk::DeskBotRecord;
use trading_http_api::{BotContext, MultiBotTradingState, build_multi_bot_router};
use trading_runtime::envelope::{
    EnvelopeEnforcement, SignedEnvelope, TradingPolicy, UniswapV3SwapEnforcement, VaultPolicy,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const CHAIN_ID: u64 = 31337;
const OWNER_ADDRESS: &str = "0x2f6e0183e7803e655910a84093032d6da5639ea7";
const OTHER_ADDRESS: &str = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const REDIRECT_URI: &str = "http://localhost:3999/callback";
const VAULT: &str = "0x0000000000000000000000000000000000000001";
const OTHER_VAULT: &str = "0x0000000000000000000000000000000000000002";
const WETH: &str = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const TEST_ENVELOPE_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ENVELOPE_CONTRACT: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TEST_ENVELOPE_SIGNER: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/// Process-wide test environment: shared state dir (leaked tempdir), anvil
/// chain mapping for both desk networks, a test redirect URI, and a fixed
/// session-auth secret. Idempotent; every test calls it (via the harness)
/// before its first request, so the once-initialization always precedes
/// store and token use.
fn ensure_desk_env() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let state_dir = tempfile::TempDir::new().expect("state tempdir");
        // Enroll the anvil chain in the vault-family gate (runbook §7a): the
        // desk refuses grants on chains without a v3.json envelope-stack
        // manifest, and 998/999 (hyperliquid-vault.json only) must refuse.
        let chain_dir = state_dir
            .path()
            .join("deployments")
            .join(CHAIN_ID.to_string());
        std::fs::create_dir_all(&chain_dir).expect("deployments dir");
        std::fs::write(
            chain_dir.join("v3.json"),
            json!({"chainId": CHAIN_ID, "sampleVault": VAULT}).to_string(),
        )
        .expect("v3 manifest");
        // SAFETY: single-threaded Once; the env vars outlive all tests.
        unsafe {
            std::env::set_var("BLUEPRINT_STATE_DIR", state_dir.path());
            std::env::set_var(
                "TRADING_DESK_DEPLOYMENTS_DIR",
                state_dir.path().join("deployments"),
            );
            std::env::set_var("TRADING_DESK_TEST_CHAIN_ID", CHAIN_ID.to_string());
            std::env::set_var("TRADING_DESK_LIVE_CHAIN_ID", CHAIN_ID.to_string());
            std::env::set_var("TRADING_DESK_REDIRECT_URIS", REDIRECT_URI);
            std::env::set_var(
                "SESSION_AUTH_SECRET",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            );
        }
        std::mem::forget(state_dir);
    });
}

/// Serializes tests that (indirectly) read or write the process-wide desk
/// env vars; the vault-family gate test flips TRADING_DESK_DEPLOYMENTS_DIR,
/// so every test takes this lock for its full body. A tokio mutex because
/// the guard is held across await points.
async fn desk_env_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LOCK.lock().await
}

fn desk_bot(bot_id: &str, owner: &str, paper: bool) -> DeskBotRecord {
    DeskBotRecord {
        bot_id: bot_id.to_string(),
        name: format!("Desk test bot {bot_id}"),
        owner_address: owner.to_string(),
        vault_address: VAULT.to_string(),
        chain_id: CHAIN_ID,
        rpc_url: "http://localhost:8545".to_string(),
        paper_trade: paper,
        trading_active: true,
        service_id: 7,
        strategy_config: json!({}),
        risk_params: json!({}),
        validation_trust: trading_runtime::ValidationTrust::Envelope,
    }
}

struct DeskHarness {
    app: Router,
    bots: Arc<Mutex<HashMap<String, DeskBotRecord>>>,
    session: String,
    #[allow(dead_code)] // keeps the wiremock market server alive for the test
    market: MockServer,
}

async fn harness_for_bots(bots: Vec<DeskBotRecord>) -> DeskHarness {
    ensure_desk_env();
    let market = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/simple/price"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ethereum": {"usd": 2500.0},
            "usd-coin": {"usd": 1.0}
        })))
        .mount(&market)
        .await;

    let mut map = HashMap::new();
    for bot in &bots {
        map.insert(bot.bot_id.clone(), bot.clone());
    }
    let bots = Arc::new(Mutex::new(map));
    let desk_bots = Arc::clone(&bots);
    let envelope_bots = Arc::clone(&bots);

    let state = Arc::new(MultiBotTradingState {
        desk_resolve_bot: Some(Box::new(move |bot_id: &str| {
            desk_bots.lock().unwrap().get(bot_id).cloned()
        })),
        operator_private_key: TEST_ENVELOPE_KEY.to_string(),
        market_data_base_url: format!("{}/api/v3", market.uri()),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            let bot_id = token.strip_prefix("token-")?;
            envelope_bots
                .lock()
                .unwrap()
                .get(bot_id)
                .map(|record| BotContext {
                    bot_id: record.bot_id.clone(),
                    vault_address: record.vault_address.clone(),
                    paper_trade: record.paper_trade,
                    chain_id: record.chain_id,
                    rpc_url: record.rpc_url.clone(),
                    strategy_config: record.strategy_config.clone(),
                    risk_params: record.risk_params.clone(),
                    validator_endpoints: vec![],
                    validation_trust: record.validation_trust,
                })
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: None,
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: Arc::new(trading_http_api::rate_limit::PerBotRateLimiter::default()),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    });

    DeskHarness {
        app: build_multi_bot_router(state),
        bots,
        session: create_test_token(OWNER_ADDRESS),
        market,
    }
}

/// One paper bot with a signed uniswap_v3 envelope installed.
async fn paper_harness() -> (DeskHarness, String) {
    let bot_id = uuid::Uuid::new_v4().to_string();
    let harness = harness_for_bots(vec![desk_bot(&bot_id, OWNER_ADDRESS, true)]).await;
    install_envelope(&harness, &bot_id).await;
    (harness, bot_id)
}

async fn install_envelope(harness: &DeskHarness, bot_id: &str) {
    install_envelope_nonce(harness, bot_id, 1).await
}

async fn install_envelope_nonce(harness: &DeskHarness, bot_id: &str, nonce: u64) {
    let (vault, chain_id) = {
        let bots = harness.bots.lock().unwrap();
        let bot = bots.get(bot_id).expect("bot for envelope");
        (bot.vault_address.clone(), bot.chain_id)
    };
    let mut signed = SignedEnvelope {
        version: 2,
        bot_id: bot_id.to_string(),
        vault_address: vault,
        chain_id,
        protocol: "uniswap_v3".to_string(),
        policy: TradingPolicy {
            max_trade_size_usd: rust_decimal::Decimal::from(10_000),
            max_total_exposure_usd: rust_decimal::Decimal::from(100_000),
            max_drawdown_pct: rust_decimal::Decimal::from(50),
            can_open_positions: true,
            perps: None,
            vault: Some(VaultPolicy {
                allowed_protocols: vec!["uniswap_v3".to_string()],
                allowed_tokens_in: vec![],
                allowed_tokens_out: vec![],
                max_slippage_bps: 1_000,
            }),
            clob: None,
        },
        approval_signers: vec![TEST_ENVELOPE_SIGNER.to_string()],
        min_signatures: 1,
        issued_at: chrono::Utc::now().timestamp() as u64,
        expires_at: chrono::Utc::now().timestamp() as u64 + 3_600,
        nonce,
        verifying_contract: TEST_ENVELOPE_CONTRACT.to_string(),
        enforcement: Some(EnvelopeEnforcement::UniswapV3Swap(
            UniswapV3SwapEnforcement {
                router: "0xE592427A0AEce92De3Edee1F18E0157C05861564"
                    .parse()
                    .unwrap(),
                token_in: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                    .parse()
                    .unwrap(),
                token_out: WETH.parse().unwrap(),
                fee_tier: 3000,
                max_single_amount_in: 10_000_000u64.into(),
                max_total_amount_in: 50_000_000u64.into(),
                max_value: Default::default(),
                min_output_per_input: 1u64.into(),
                sqrt_price_limit_x96: Default::default(),
            },
        )),
        signatures: vec![],
    };
    signed
        .sign_with_private_key(TEST_ENVELOPE_KEY, TEST_ENVELOPE_CONTRACT)
        .unwrap();

    let request = Request::builder()
        .method(Method::PUT)
        .uri("/envelope")
        .header(header::AUTHORIZATION, format!("Bearer token-{bot_id}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&signed).unwrap()))
        .unwrap();
    let (status, body) = send(harness.app.clone(), request).await;
    assert!(
        status.is_success(),
        "envelope install failed: {status} {body}"
    );
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.expect("router call");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("JSON response body")
    };
    (status, body)
}

async fn get(app: &Router, uri: &str, credential: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(header::AUTHORIZATION, credential)
        .body(Body::empty())
        .unwrap();
    send(app.clone(), request).await
}

async fn delete(app: &Router, uri: &str, credential: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::DELETE)
        .uri(uri)
        .header(header::AUTHORIZATION, credential)
        .body(Body::empty())
        .unwrap();
    send(app.clone(), request).await
}

async fn post_json(
    app: &Router,
    uri: &str,
    credential: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::AUTHORIZATION, credential)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();
    send(app.clone(), request).await
}

async fn post_form(app: &Router, uri: &str, pairs: &[(&str, &str)]) -> (StatusCode, Value) {
    let form = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", urlencode(key), urlencode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(form))
        .unwrap();
    send(app.clone(), request).await
}

// ── OAuth helpers ────────────────────────────────────────────────────────────

/// A (verifier, challenge) pair: 43-char unreserved verifier, S256 challenge.
fn pkce_pair() -> (String, String) {
    let verifier = format!("{}-{}", uuid::Uuid::new_v4().simple(), "0".repeat(10));
    (verifier.clone(), pkce_s256(&verifier))
}

fn pkce_s256(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

fn b64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bytes = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

fn urlencode(value: &str) -> String {
    fn safe(byte: u8) -> bool {
        matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'
        )
    }
    let mut out = String::new();
    for byte in value.bytes() {
        if safe(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn authorize(
    app: &Router,
    credential: &str,
    bot_id: &str,
    network: &str,
    challenge: &str,
) -> (StatusCode, Value) {
    let (_, preview) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={bot_id}&network={network}"),
        credential,
    )
    .await;
    post_json(
        app,
        "/api/trading-desk/authorize",
        credential,
        json!({
            "envelope_digest": preview["envelope"]["digest"],
            "network": network,
            "bot_id": bot_id,
            "state": "desk-test-state",
            "code_challenge": challenge,
            "redirect_uri": REDIRECT_URI,
        }),
    )
    .await
}

async fn exchange(app: &Router, code: &str, verifier: &str) -> (StatusCode, Value) {
    post_form(
        app,
        "/api/trading-desk/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", "tangle-trading"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", verifier),
        ],
    )
    .await
}

/// Full consent flow: authorize + PKCE exchange. Returns the desk credential.
async fn connect_desk(
    app: &Router,
    credential: &str,
    bot_id: &str,
    network: &str,
) -> (String, String) {
    let (verifier, challenge) = pkce_pair();
    let (status, body) = authorize(app, credential, bot_id, network, &challenge).await;
    assert_eq!(status, StatusCode::OK, "authorize failed: {body}");
    let code = body["code"].as_str().expect("code").to_string();
    let grant_id = body["grantId"].as_str().expect("grantId").to_string();
    let (status, body) = exchange(app, &code, &verifier).await;
    assert_eq!(status, StatusCode::OK, "token exchange failed: {body}");
    (
        body["access_token"]
            .as_str()
            .expect("access_token")
            .to_string(),
        grant_id,
    )
}

fn order_body(client_order_id: &str, side: &str, quantity: &str, limit_price: &str) -> Value {
    json!({
        "clientOrderId": client_order_id,
        "instrument": "WETH-USDC",
        "side": side,
        "quantity": quantity,
        "limitPrice": limit_price,
    })
}

fn owner_session(harness: &DeskHarness) -> String {
    format!("Bearer {}", harness.session)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn desk_paper_flow_from_consent_to_order_replay() {
    let _env = desk_env_lock().await;
    let (harness, bot_id) = paper_harness().await;
    let app = &harness.app;
    let session = owner_session(&harness);

    // Preview shows what the wallet is approving.
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={bot_id}&network=test"),
        &session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["eligible"],
        json!(true),
        "problems: {}",
        body["problems"]
    );
    assert_eq!(body["chainId"], json!(CHAIN_ID));
    assert_eq!(body["quoteCurrency"], json!("USDC"));
    assert_eq!(body["instruments"][0]["instrument"], json!("WETH-USDC"));
    assert_eq!(body["instruments"][0]["baseAddress"], json!(WETH));
    assert_eq!(
        body["scopes"],
        json!([
            "account:read",
            "orders:submit",
            "orders:read",
            "connection:revoke"
        ])
    );
    assert!(body["envelope"]["maxTradeSizeUsd"].is_string());
    assert_eq!(body["envelope"]["vaultAddress"], json!(VAULT));

    // Authorize + PKCE exchange.
    let (verifier, challenge) = pkce_pair();
    let (status, body) = authorize(app, &session, &bot_id, "test", &challenge).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["redirectUri"], json!(REDIRECT_URI));
    let code = body["code"].as_str().unwrap().to_string();
    let (status, body) = exchange(app, &code, &verifier).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["token_type"], json!("Bearer"));
    let credential = format!("Bearer {}", body["access_token"].as_str().unwrap());
    assert!(credential.starts_with("Bearer tdsk_"));

    // Account follows the consumer contract.
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accountId"], json!(VAULT));
    assert_eq!(body["chainId"], json!(CHAIN_ID));
    assert_eq!(body["paper"], json!(true));
    assert_eq!(body["instruments"], json!(["WETH-USDC"]));
    assert_eq!(body["execution"], json!("atomic-spot-swap"));
    assert!(body["expiresAt"].as_str().unwrap().contains('T'));

    // Submit a buy: "1.50" must come back canonically as "1.5", and a paper
    // result is never reported as filled.
    let order_id = uuid::Uuid::new_v4().to_string();
    let (status, body) = post_json(
        app,
        "/api/trading-desk/orders",
        &credential,
        order_body(&order_id, "buy", "1.50", "2500.25"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("unknown"));
    assert_eq!(body["quantity"], json!("1.5"));
    assert_eq!(body["venueOrderId"], Value::Null);
    assert_eq!(body["filledQuantity"], Value::Null);
    assert_eq!(body["quoteAmount"], Value::Null);
    assert_eq!(body["paper"], json!(true));
    assert!(body["reason"].as_str().unwrap().contains("paper"));

    let first_intent = body["intentHash"]
        .as_str()
        .expect("staged intent")
        .to_owned();
    let second_id = uuid::Uuid::new_v4().to_string();
    let (status, second) = post_json(
        app,
        "/api/trading-desk/orders",
        &credential,
        order_body(&second_id, "buy", "1.50", "2500.25"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_ne!(
        second["intentHash"].as_str().expect("distinct intent"),
        first_intent
    );

    // Get it back.
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/orders/{order_id}"),
        &credential,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["clientOrderId"], json!(order_id));
    assert_eq!(body["status"], json!("unknown"));

    // Idempotent replay of the normalized-equal request.
    let (status, body) = post_json(
        app,
        "/api/trading-desk/orders",
        &credential,
        order_body(&order_id, "buy", "1.5", "2500.25"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("unknown"));

    assert_eq!(body["intentHash"], json!(first_intent));

    // Same clientOrderId with a different payload is a conflict.
    let (status, body) = post_json(
        app,
        "/api/trading-desk/orders",
        &credential,
        order_body(&order_id, "buy", "1.5", "2600"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // A second order (sell) on the same connection.
    let sell_id = uuid::Uuid::new_v4().to_string();
    let (status, body) = post_json(
        app,
        "/api/trading-desk/orders",
        &credential,
        order_body(&sell_id, "sell", "0.2", "2600"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("unknown"));
    assert_eq!(body["quantity"], json!("0.2"));
}

#[tokio::test]
async fn desk_token_exchange_enforces_pkce_and_client_authentication() {
    let _env = desk_env_lock().await;
    let (harness, bot_id) = paper_harness().await;
    let app = &harness.app;
    let session = owner_session(&harness);

    // PKCE inputs are validated at authorize time.
    let (verifier, _) = pkce_pair();
    let (_, challenge) = pkce_pair();
    let (status, body) = authorize(app, &session, &bot_id, "test", "not-a-challenge").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = post_json(
        app,
        "/api/trading-desk/authorize",
        &session,
        json!({
            "network": "test",
            "bot_id": bot_id,
            "state": "desk-test-state",
            "code_challenge": challenge,
            "code_challenge_method": "plain",
            "redirect_uri": REDIRECT_URI,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = post_json(
        app,
        "/api/trading-desk/authorize",
        &session,
        json!({
            "network": "test",
            "bot_id": bot_id,
            "state": "desk-test-state",
            "code_challenge": challenge,
            "redirect_uri": "http://evil.example/callback",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let _ = verifier;

    // A valid code for the negative exchange tests.
    let (verifier, challenge) = pkce_pair();
    let (status, body) = authorize(app, &session, &bot_id, "test", &challenge).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let code = body["code"].as_str().unwrap().to_string();

    // Wrong verifier.
    let (status, body) = exchange(app, &code, &format!("0{verifier}")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("invalid_grant"));
    assert!(body["error_description"].as_str().unwrap().contains("PKCE"));

    // Wrong client_id.
    let (status, body) = post_form(
        app,
        "/api/trading-desk/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", "tangle-trading-x"),
            ("code", &code),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", &verifier),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("invalid_client"));

    // Wrong grant type.
    let (status, body) = post_form(
        app,
        "/api/trading-desk/token",
        &[
            ("grant_type", "refresh_token"),
            ("client_id", "tangle-trading"),
            ("code", &code),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", &verifier),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("unsupported_grant_type"));

    // Redirect mismatch.
    let (status, body) = post_form(
        app,
        "/api/trading-desk/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", "tangle-trading"),
            ("code", &code),
            ("redirect_uri", "http://localhost:3999/other"),
            ("code_verifier", &verifier),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("invalid_grant"));
    assert!(
        body["error_description"]
            .as_str()
            .unwrap()
            .contains("redirect")
    );

    // Malformed verifier.
    let (status, body) = exchange(app, &code, "short").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("invalid_request"));

    // JSON instead of form.
    let (status, body) = post_json(app, "/api/trading-desk/token", "", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("invalid_request"));

    // None of the failures consumed the code: the correct exchange works.
    let (status, body) = exchange(app, &code, &verifier).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A code is single-use: replay fails.
    let (status, body) = exchange(app, &code, &verifier).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("invalid_grant"));
}

#[tokio::test]
async fn desk_authorization_gates() {
    let _env = desk_env_lock().await;
    let (harness, bot_id) = paper_harness().await;
    let no_envelope_bot = uuid::Uuid::new_v4().to_string();
    harness.bots.lock().unwrap().insert(
        no_envelope_bot.clone(),
        desk_bot(&no_envelope_bot, OWNER_ADDRESS, true),
    );
    let app = &harness.app;
    let session = owner_session(&harness);
    let other = format!("Bearer {}", create_test_token(OTHER_ADDRESS));

    // Wallet session required.
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={bot_id}&network=test"),
        "Bearer garbage",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");

    // Unknown network.
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={bot_id}&network=staging"),
        &session,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // A different wallet is not eligible and cannot authorize.
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={bot_id}&network=test"),
        &other,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["eligible"], json!(false));
    assert!(
        body["problems"]
            .as_array()
            .unwrap()
            .iter()
            .any(|problem| problem.as_str().unwrap().contains("does not own"))
    );
    let (_, challenge) = pkce_pair();
    let (status, body) = authorize(app, &other, &bot_id, "test", &challenge).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // A bot without a signed envelope is not eligible.
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={no_envelope_bot}&network=test"),
        &session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["eligible"], json!(false));
    assert!(body["problems"].as_array().unwrap().iter().any(|problem| {
        problem
            .as_str()
            .unwrap()
            .contains("no signed trading envelope")
    }));
    let (status, body) = authorize(app, &session, &no_envelope_bot, "test", &challenge).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Desk tokens never work on wallet-session routes.
    let (token, _) = connect_desk(app, &session, &bot_id, "test").await;
    let credential = format!("Bearer {token}");
    let (status, body) = get(
        app,
        &format!("/api/trading-desk/authorize/preview?bot_id={bot_id}&network=test"),
        &credential,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(body["message"].as_str().unwrap().contains("desk tokens"));

    // Malformed desk credentials.
    for bad in ["garbage", "tdsk_zzz", &format!("tdsk_{}", "z".repeat(64))] {
        let (status, body) = get(app, "/api/trading-desk/account", &format!("Bearer {bad}")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{bad}: {body}");
    }
}

#[tokio::test]
async fn desk_revocation_ends_connection_and_lists_history() {
    let _env = desk_env_lock().await;
    let (harness, bot_id) = paper_harness().await;
    let app = &harness.app;
    let session = owner_session(&harness);
    let other = format!("Bearer {}", create_test_token(OTHER_ADDRESS));

    let (token, grant_id) = connect_desk(app, &session, &bot_id, "test").await;
    let credential = format!("Bearer {token}");

    // The wallet sees the active connection.
    let (status, body) = get(app, "/api/trading-desk/connections", &session).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let entry = body["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["connectionId"] == json!(grant_id))
        .expect("connection listed")
        .clone();
    assert_eq!(entry["botId"], json!(bot_id));
    assert_eq!(entry["chainId"], json!(CHAIN_ID));
    assert_eq!(entry["network"], json!("test"));
    assert_eq!(entry["active"], json!(true));
    assert_eq!(entry["revokedAt"], Value::Null);
    assert!(entry["botName"].as_str().unwrap().contains("Desk test bot"));

    // Another wallet cannot revoke it.
    let (status, body) = delete(
        app,
        &format!("/api/trading-desk/connections/{grant_id}"),
        &other,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // The desk revokes its own connection.
    let (status, body) = delete(app, "/api/trading-desk/connection", &credential).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    // The credential is dead.
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["message"], json!("connection revoked"));

    // Revocation is visible in the wallet's list.
    let (status, body) = get(app, "/api/trading-desk/connections", &session).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let entry = body["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["connectionId"] == json!(grant_id))
        .expect("revoked connection listed")
        .clone();
    assert_eq!(entry["active"], json!(false));
    assert!(entry["revokedAt"].is_u64());

    // The wallet can also revoke directly: a fresh connection, then DELETE.
    let (token, grant_id) = connect_desk(app, &session, &bot_id, "test").await;
    let credential = format!("Bearer {token}");
    let (status, body) = delete(
        app,
        &format!("/api/trading-desk/connections/{grant_id}"),
        &session,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
}

#[tokio::test]
async fn desk_grant_binding_blocks_reassigned_or_drifted_bots() {
    let _env = desk_env_lock().await;
    let paper_bot = uuid::Uuid::new_v4().to_string();
    let live_bot = uuid::Uuid::new_v4().to_string();
    let harness = harness_for_bots(vec![
        desk_bot(&paper_bot, OWNER_ADDRESS, true),
        desk_bot(&live_bot, OWNER_ADDRESS, false),
    ])
    .await;
    install_envelope(&harness, &paper_bot).await;
    install_envelope(&harness, &live_bot).await;
    let app = &harness.app;
    let session = owner_session(&harness);

    let (token, _) = connect_desk(app, &session, &paper_bot, "test").await;
    let credential = format!("Bearer {token}");
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Vault reassignment kills the credential.
    harness
        .bots
        .lock()
        .unwrap()
        .get_mut(&paper_bot)
        .unwrap()
        .vault_address = OTHER_VAULT.to_string();
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(body["message"].as_str().unwrap().contains("vault"));
    harness
        .bots
        .lock()
        .unwrap()
        .get_mut(&paper_bot)
        .unwrap()
        .vault_address = VAULT.to_string();
    let (status, _) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::OK);

    // Chain drift kills it too.
    harness
        .bots
        .lock()
        .unwrap()
        .get_mut(&paper_bot)
        .unwrap()
        .chain_id = CHAIN_ID + 1;
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["message"].as_str().unwrap().contains("chain"));
    harness
        .bots
        .lock()
        .unwrap()
        .get_mut(&paper_bot)
        .unwrap()
        .chain_id = CHAIN_ID;

    // A paper bot can never be authorized as a live venue.
    let (_, challenge) = pkce_pair();
    let (status, body) = authorize(app, &session, &paper_bot, "live", &challenge).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body["message"].as_str().unwrap().contains("paper"));

    // A live bot connects on the live network and drifts to paper.
    let (token, _) = connect_desk(app, &session, &live_bot, "live").await;
    let credential = format!("Bearer {token}");
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["paper"], json!(false));
    install_envelope_nonce(&harness, &live_bot, 2).await;
    let (status, detail) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::CONFLICT, "{detail}");
    assert!(detail["message"].as_str().unwrap().contains("terms"));
    let (token, _) = connect_desk(app, &session, &live_bot, "live").await;
    let credential = format!("Bearer {token}");
    harness
        .bots
        .lock()
        .unwrap()
        .get_mut(&live_bot)
        .unwrap()
        .paper_trade = true;
    let (status, body) = get(app, "/api/trading-desk/account", &credential).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["message"].as_str().unwrap().contains("paper"));

    let (paper_token, _) = connect_desk(app, &session, &paper_bot, "test").await;
    harness
        .bots
        .lock()
        .unwrap()
        .get_mut(&paper_bot)
        .unwrap()
        .paper_trade = false;
    let (status, detail) = get(
        app,
        "/api/trading-desk/account",
        &format!("Bearer {paper_token}"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{detail}");
}

#[tokio::test]
async fn desk_order_validation_rejects_malformed_requests() {
    let _env = desk_env_lock().await;
    let (harness, bot_id) = paper_harness().await;
    let app = &harness.app;
    let session = owner_session(&harness);
    let (token, _) = connect_desk(app, &session, &bot_id, "test").await;
    let credential = format!("Bearer {token}");

    let cases: Vec<(&str, &str, &str, &str)> = vec![
        ("not-a-uuid", "WETH-USDC", "buy", "1.5"),
        ("unknown-instrument", "WETH-USDT", "buy", "1.5"),
        ("bad-side", "WETH-USDC", "short", "1.5"),
        ("zero-quantity", "WETH-USDC", "buy", "0"),
        (
            "excess-precision",
            "WETH-USDC",
            "buy",
            "0.0000000000000000001",
        ),
    ];
    for (label, instrument, side, quantity) in cases {
        let client_order_id = match label {
            "not-a-uuid" => "not-a-uuid".to_string(),
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let (status, body) = post_json(
            app,
            "/api/trading-desk/orders",
            &credential,
            json!({
                "clientOrderId": client_order_id,
                "instrument": instrument,
                "side": side,
                "quantity": quantity,
                "limitPrice": "2500",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
        assert!(body["message"].is_string(), "{label}: {body}");
    }

    // Missing desk credential.
    let (status, body) = post_json(
        app,
        "/api/trading-desk/orders",
        "Bearer garbage",
        order_body(&uuid::Uuid::new_v4().to_string(), "buy", "1.5", "2500"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
}

#[tokio::test]
async fn desk_refuses_chains_without_enrolled_trading_vault() {
    let _env = desk_env_lock().await;
    let harness = harness_for_bots(vec![desk_bot("desk-vaultless", OWNER_ADDRESS, true)]).await;
    let app = &harness.app;
    let session = owner_session(&harness);

    // Point the vault-family gate at an empty deployments dir: the chain has
    // no v3.json envelope-stack manifest (runbook §7a), so the desk must
    // refuse the grant even though the bot itself is otherwise eligible.
    let empty = tempfile::tempdir().expect("deployments tempdir");
    let original = std::env::var_os("TRADING_DESK_DEPLOYMENTS_DIR")
        .expect("ensure_desk_env sets the deployments dir");
    // SAFETY: desk_env_lock serializes env mutation across tests.
    unsafe { std::env::set_var("TRADING_DESK_DEPLOYMENTS_DIR", empty.path()) };

    let (status, body) = get(
        app,
        "/api/trading-desk/authorize/preview?bot_id=desk-vaultless&network=test",
        &session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["eligible"], json!(false), "{body}");
    assert!(
        body["problems"]
            .as_array()
            .expect("problems array")
            .iter()
            .any(|problem| problem
                .as_str()
                .is_some_and(|p| p.contains("no enrolled EVM trading vault"))),
        "problems: {}",
        body["problems"]
    );

    let (_verifier, challenge) = pkce_pair();
    let (status, body) = authorize(app, &session, "desk-vaultless", "test", &challenge).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|m| m.contains("no enrolled EVM trading vault")),
        "{body}"
    );

    // Restore enrollment so subsequent tests grant on chain 31337.
    // SAFETY: desk_env_lock serializes env mutation across tests.
    unsafe { std::env::set_var("TRADING_DESK_DEPLOYMENTS_DIR", original) };
}
