//! Integration tests for the Trading HTTP API.
//!
//! Tests route handlers with a real axum router, using wiremock for market
//! data and in-memory state for portfolio/executor.

use std::sync::Arc;
use tokio::sync::RwLock;

use axum::http::StatusCode;
use axum::{Router, body::Body};
use http_body_util::BodyExt;
use hyper::Request;
use tower::ServiceExt;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use alloy::primitives::{Address, U256};
use alloy::sol_types::{SolCall, SolValue};
use trading_http_api::{BotContext, MultiBotTradingState, build_multi_bot_router};
use trading_http_api::{TradingApiState, build_router};
use trading_runtime::PortfolioState;
use trading_runtime::adapters::ActionParams;
use trading_runtime::contracts::{ITradeValidator, ITradingVault};
use trading_runtime::envelope::{PerpsPolicy, SignedEnvelope, TradingPolicy};
use trading_runtime::execution_hash::{
    ACTION_KIND_CLOB_ORDER, ACTION_KIND_HYPERLIQUID_ORDER, ACTION_KIND_VAULT_EXECUTE, format_b256,
    hash_clob_order, hash_execution_payload, hash_hyperliquid_order,
};
use trading_runtime::executor::get_adapter;
use trading_runtime::hyperliquid::{AssetId, HlOrderType, PlaceOrderRequest};

/// Valid 65-byte hex signature (0x + 130 hex chars) for test mocks.
const TEST_SIG: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
use trading_runtime::executor::TradeExecutor;
use trading_runtime::intent::hash_intent;
use trading_runtime::market_data::MarketDataClient;
use trading_runtime::validator_client::ValidatorClient;

const TEST_TOKEN: &str = "test-api-token-12345";
const TEST_VALIDATOR_PRIVATE_KEY: &str =
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_VERIFYING_CONTRACT: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEFAULT_TEST_VAULT_ADDRESS: &str = "0x0000000000000000000000000000000000000001";

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
    let bot_id = format!("test-bot-{}", uuid::Uuid::new_v4());

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
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
        bot_id,
        paper_trade: true,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: None,
        chain_id: None,
        clob_client: None,
        strategy_config: serde_json::Value::Null,
    })
}

async fn test_state_with_bot_id(mock_uri: &str, bot_id: &str) -> Arc<TradingApiState> {
    ensure_state_dir();

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            "http://localhost:8545",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            31337,
        )
        .expect("test executor"),
        portfolio: RwLock::new(PortfolioState::default()),
        api_token: bot_id.to_string(),
        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
        validator_endpoints: vec![],
        validation_deadline_secs: 3600,
        bot_id: bot_id.to_string(),
        paper_trade: true,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: None,
        chain_id: None,
        clob_client: None,
        strategy_config: serde_json::Value::Null,
    })
}

async fn test_state_with_bot_id_and_clob(
    mock_uri: &str,
    bot_id: &str,
    clob_mock_uri: &str,
) -> Arc<TradingApiState> {
    use trading_runtime::polymarket_clob::ClobClient;

    ensure_state_dir();

    let clob_client = ClobClient::with_config(
        "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        clob_mock_uri.to_string(),
        Some(ClobClient::test_credentials()),
    )
    .expect("clob client");

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            "http://localhost:8545",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            31337,
        )
        .expect("test executor"),
        portfolio: RwLock::new(PortfolioState::default()),
        api_token: bot_id.to_string(),
        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
        validator_endpoints: vec![],
        validation_deadline_secs: 3600,
        bot_id: bot_id.to_string(),
        paper_trade: true,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: None,
        chain_id: None,
        clob_client: Some(Arc::new(clob_client)),
        strategy_config: serde_json::Value::Null,
    })
}

async fn test_state_with_chain_id(mock_uri: &str, chain_id: u64) -> Arc<TradingApiState> {
    ensure_state_dir();

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            "http://localhost:8545",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            chain_id,
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
        rpc_url: None,
        chain_id: Some(chain_id),
        clob_client: None,
        strategy_config: serde_json::Value::Null,
    })
}

async fn live_test_state(market_uri: &str, rpc_uri: &str) -> Arc<TradingApiState> {
    ensure_state_dir();
    let bot_id = format!("live-test-bot-{}", uuid::Uuid::new_v4());

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(market_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            rpc_uri,
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            42161,
        )
        .expect("test executor"),
        portfolio: RwLock::new(PortfolioState::default()),
        api_token: TEST_TOKEN.to_string(),
        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
        validator_endpoints: vec![],
        validation_deadline_secs: 3600,
        bot_id,
        paper_trade: false,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: Some(rpc_uri.to_string()),
        chain_id: None,
        clob_client: None,
        strategy_config: serde_json::Value::Null,
    })
}

fn auth_header() -> String {
    format!("Bearer {TEST_TOKEN}")
}

fn parse_test_action(action: &str) -> trading_runtime::Action {
    match action {
        "swap" => trading_runtime::Action::Swap,
        "supply" => trading_runtime::Action::Supply,
        "borrow" => trading_runtime::Action::Borrow,
        "withdraw" => trading_runtime::Action::Withdraw,
        "repay" => trading_runtime::Action::Repay,
        "open_long" => trading_runtime::Action::OpenLong,
        "open_short" => trading_runtime::Action::OpenShort,
        "close_long" => trading_runtime::Action::CloseLong,
        "close_short" => trading_runtime::Action::CloseShort,
        "buy" => trading_runtime::Action::Buy,
        "sell" => trading_runtime::Action::Sell,
        "redeem" => trading_runtime::Action::Redeem,
        "collateral_release" => trading_runtime::Action::CollateralRelease,
        other => panic!("unsupported test action: {other}"),
    }
}

fn test_zero_hash() -> String {
    format!("0x{}", "00".repeat(32))
}

fn attach_validation_hashes(body: &mut serde_json::Value, execution_chain_id: Option<u64>) {
    let mut intent_json = body["intent"].clone();
    let protocol = intent_json["target_protocol"]
        .as_str()
        .expect("protocol")
        .to_string();
    if protocol == "hyperliquid" {
        let metadata = intent_json
            .as_object_mut()
            .expect("intent object")
            .entry("metadata")
            .or_insert_with(|| serde_json::json!({}));
        let metadata = metadata.as_object_mut().expect("metadata object");
        metadata
            .entry("hyperliquid_account_address")
            .or_insert_with(|| serde_json::json!(DEFAULT_TEST_VAULT_ADDRESS));
        body["intent"] = intent_json.clone();
    }
    let validation = body
        .get_mut("validation")
        .and_then(|value| value.as_object_mut())
        .expect("validation object");
    let deadline = validation
        .get("deadline")
        .and_then(|value| value.as_u64())
        .unwrap_or(1_999_999_999);
    validation.insert("deadline".into(), serde_json::json!(deadline));

    let adapter_chain_id = execution_chain_id.map(trading_http_api::protocol_chain_id_from_env);
    let intent_chain_id = adapter_chain_id.unwrap_or(42161);
    let mut intent = trading_runtime::TradeIntentBuilder::new()
        .strategy_id(intent_json["strategy_id"].as_str().expect("strategy_id"))
        .action(parse_test_action(
            intent_json["action"].as_str().expect("action"),
        ))
        .token_in(intent_json["token_in"].as_str().expect("token_in"))
        .token_out(intent_json["token_out"].as_str().expect("token_out"))
        .amount_in(
            intent_json["amount_in"]
                .as_str()
                .expect("amount_in")
                .parse()
                .expect("amount_in decimal"),
        )
        .min_amount_out(
            intent_json["min_amount_out"]
                .as_str()
                .expect("min_amount_out")
                .parse()
                .expect("min_amount_out decimal"),
        )
        .target_protocol(&protocol)
        .chain_id(intent_chain_id)
        .metadata(
            intent_json
                .get("metadata")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        )
        .build()
        .expect("test intent");
    intent.deadline =
        chrono::DateTime::<chrono::Utc>::from_timestamp(deadline as i64, 0).expect("deadline");

    let intent_hash = hash_intent(&intent);
    let execution_hash = if protocol == "polymarket_clob" && execution_chain_id.is_some() {
        match trading_runtime::polymarket_clob::extract_clob_params(
            intent_json["action"].as_str().expect("action"),
            intent_json["amount_in"].as_str().expect("amount_in"),
            intent_json
                .get("metadata")
                .unwrap_or(&serde_json::Value::Null),
        ) {
            Ok(params) => {
                let intent_hash_bytes = hex::decode(intent_hash.trim_start_matches("0x")).unwrap();
                let intent_hash_b256 = alloy::primitives::B256::from_slice(&intent_hash_bytes);
                format_b256(hash_clob_order(
                    &params,
                    intent_hash_b256,
                    alloy::primitives::U256::from(deadline),
                    execution_chain_id.unwrap_or(intent_chain_id),
                ))
            }
            Err(_) => test_zero_hash(),
        }
    } else if protocol == "hyperliquid" && execution_chain_id.is_some() {
        let intent_hash_bytes = hex::decode(intent_hash.trim_start_matches("0x")).unwrap();
        let intent_hash_b256 = alloy::primitives::B256::from_slice(&intent_hash_bytes);
        let metadata = intent_json
            .get("metadata")
            .unwrap_or(&serde_json::Value::Null);
        let asset = metadata
            .get("asset")
            .and_then(|value| value.as_str())
            .unwrap_or(intent_json["token_out"].as_str().expect("token_out"));
        let action = intent_json["action"].as_str().expect("action");
        let order = PlaceOrderRequest {
            asset: AssetId::Symbol(asset.to_string()),
            is_buy: matches!(action, "open_long" | "buy" | "close_short"),
            size: intent_json["amount_in"]
                .as_str()
                .expect("amount_in")
                .to_string(),
            order_type: HlOrderType::Market,
            reduce_only: matches!(action, "close_long" | "close_short"),
            cloid: None,
        };
        format_b256(hash_hyperliquid_order(
            &order,
            metadata
                .get("hyperliquid_account_address")
                .and_then(|value| value.as_str())
                .unwrap_or(DEFAULT_TEST_VAULT_ADDRESS),
            intent_hash_b256,
            alloy::primitives::U256::from(deadline),
            execution_chain_id.unwrap_or(intent_chain_id),
        ))
    } else {
        test_zero_hash()
    };
    validation.insert("intent_hash".into(), serde_json::json!(intent_hash));
    validation.insert("execution_hash".into(), serde_json::json!(execution_hash));
}

fn attach_signed_validation(
    body: &mut serde_json::Value,
    execution_chain_id: u64,
    vault_address: &str,
    action_kind: u64,
) {
    attach_validation_hashes(body, Some(execution_chain_id));
    attach_validator_signature(body, execution_chain_id, vault_address, action_kind);
}

fn attach_validator_signature(
    body: &mut serde_json::Value,
    execution_chain_id: u64,
    vault_address: &str,
    action_kind: u64,
) {
    let validation = body
        .get_mut("validation")
        .and_then(|value| value.as_object_mut())
        .expect("validation object");
    let score = validation
        .get("aggregate_score")
        .and_then(|value| value.as_u64())
        .unwrap_or(75);
    let deadline = validation
        .get("deadline")
        .and_then(|value| value.as_u64())
        .expect("deadline");
    let intent_hash: alloy::primitives::B256 = validation["intent_hash"]
        .as_str()
        .expect("intent_hash")
        .parse()
        .expect("intent hash b256");
    let execution_hash: alloy::primitives::B256 = validation["execution_hash"]
        .as_str()
        .expect("execution_hash")
        .parse()
        .expect("execution hash b256");
    let verifying_contract: alloy::primitives::Address =
        TEST_VERIFYING_CONTRACT.parse().expect("verifying contract");
    let vault: alloy::primitives::Address = vault_address.parse().expect("vault address");
    let signer = trading_validator_lib::signer::ValidatorSigner::new(
        TEST_VALIDATOR_PRIVATE_KEY,
        execution_chain_id,
        verifying_contract,
    )
    .expect("validator signer");
    let (signature, validator) = signer
        .sign_validation(
            intent_hash,
            execution_hash,
            vault,
            score,
            deadline,
            action_kind,
        )
        .expect("sign validation");

    validation.insert(
        "validator_responses".into(),
        serde_json::json!([
            {
                "validator": format!("{validator:#x}"),
                "score": score,
                "reasoning": "signed test validation",
                "signature": format!("0x{}", hex::encode(signature)),
                "chain_id": execution_chain_id,
                "verifying_contract": TEST_VERIFYING_CONTRACT,
            }
        ]),
    );
}

fn attach_vault_execution_hash(body: &mut serde_json::Value, execution_chain_id: u64) {
    attach_validation_hashes(body, None);

    let intent_json = body["intent"].clone();
    let validation = body
        .get_mut("validation")
        .and_then(|value| value.as_object_mut())
        .expect("validation object");
    let intent_hash: alloy::primitives::B256 = validation["intent_hash"]
        .as_str()
        .expect("intent_hash")
        .parse()
        .expect("intent hash b256");
    let deadline = validation
        .get("deadline")
        .and_then(|value| value.as_u64())
        .expect("deadline");
    let token_in = intent_json["token_in"]
        .as_str()
        .expect("token_in")
        .parse()
        .expect("token_in address");
    let token_out = intent_json["token_out"]
        .as_str()
        .expect("token_out")
        .parse()
        .expect("token_out address");
    let amount_in: rust_decimal::Decimal = intent_json["amount_in"]
        .as_str()
        .expect("amount_in")
        .parse()
        .expect("amount_in decimal");
    let min_amount_out: rust_decimal::Decimal = intent_json["min_amount_out"]
        .as_str()
        .expect("min_amount_out")
        .parse()
        .expect("min_amount_out decimal");
    let mut extra = intent_json
        .get("metadata")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    match extra {
        serde_json::Value::Object(ref mut map) => {
            map.entry("execution_deadline".to_string())
                .or_insert_with(|| serde_json::json!(deadline));
        }
        _ => extra = serde_json::json!({ "execution_deadline": deadline }),
    }

    let amount = U256::from_str_radix(&amount_in.trunc().to_string(), 10).expect("amount u256");
    let min_output =
        U256::from_str_radix(&min_amount_out.trunc().to_string(), 10).expect("min output u256");
    let vault_address: Address = "0x0000000000000000000000000000000000000001"
        .parse()
        .expect("vault address");
    let adapter = get_adapter(
        intent_json["target_protocol"].as_str().expect("protocol"),
        None,
    )
    .expect("adapter");
    let encoded = adapter
        .encode_action(&ActionParams {
            action: parse_test_action(intent_json["action"].as_str().expect("action")),
            token_in,
            token_out,
            amount,
            min_output,
            extra,
            vault_address,
        })
        .expect("encoded action");
    let execution_hash = hash_execution_payload(
        &encoded,
        intent_hash,
        U256::from(deadline),
        execution_chain_id,
    );
    validation.insert(
        "execution_hash".into(),
        serde_json::json!(format_b256(execution_hash)),
    );
}

fn rpc_result_hex(encoded: Vec<u8>) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": format!("0x{}", hex::encode(encoded)),
    })
}

fn rpc_error(message: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "error": {
            "code": -32000,
            "message": message,
        },
    })
}

fn selector_hex(selector: [u8; 4]) -> String {
    format!("0x{}", hex::encode(selector))
}

async fn mock_rpc_selector(rpc_mock: &MockServer, selector: &str, response: ResponseTemplate) {
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains(selector.to_string()))
        .respond_with(response)
        .mount(rpc_mock)
        .await;
}

async fn mock_live_vault_reconciliation_base(
    rpc_mock: &MockServer,
    outstanding_response: ResponseTemplate,
) {
    let asset: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        .parse()
        .expect("asset address");

    mock_rpc_selector(
        rpc_mock,
        &selector_hex(ITradingVault::assetCall::SELECTOR),
        ResponseTemplate::new(200).set_body_json(rpc_result_hex(asset.abi_encode())),
    )
    .await;
    mock_rpc_selector(
        rpc_mock,
        &selector_hex(ITradingVault::totalAssetsCall::SELECTOR),
        ResponseTemplate::new(200).set_body_json(rpc_result_hex(U256::ZERO.abi_encode())),
    )
    .await;
    mock_rpc_selector(
        rpc_mock,
        &selector_hex(ITradingVault::isNavSafeCall::SELECTOR),
        ResponseTemplate::new(200).set_body_json(rpc_result_hex(true.abi_encode())),
    )
    .await;
    mock_rpc_selector(
        rpc_mock,
        &selector_hex(ITradingVault::totalOutstandingCollateralCall::SELECTOR),
        outstanding_response,
    )
    .await;
    mock_rpc_selector(
        rpc_mock,
        &selector_hex(ITradingVault::getHeldTokensCall::SELECTOR),
        ResponseTemplate::new(200)
            .set_body_json(rpc_result_hex(Vec::<Address>::new().abi_encode())),
    )
    .await;
    mock_rpc_selector(
        rpc_mock,
        &selector_hex(ITradingVault::getBalanceCall::SELECTOR),
        ResponseTemplate::new(200).set_body_json(rpc_result_hex(U256::ZERO.abi_encode())),
    )
    .await;
}

async fn mock_live_aave_debt_balance(
    rpc_mock: &MockServer,
    debt_token: &str,
    response: ResponseTemplate,
) {
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("0x70a08231"))
        .and(body_string_contains(debt_token.to_ascii_lowercase()))
        .respond_with(response)
        .mount(rpc_mock)
        .await;
}

async fn mock_direct_validator_approval(rpc_mock: &MockServer, approved: bool) {
    let validator: Address = TEST_VERIFYING_CONTRACT.parse().expect("validator address");
    let trade_validator_selector = format!(
        "0x{}",
        hex::encode(ITradingVault::tradeValidatorCall::SELECTOR)
    );
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains(trade_validator_selector))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(rpc_result_hex(validator.abi_encode())),
        )
        .mount(rpc_mock)
        .await;

    let validate_selector = format!(
        "0x{}",
        hex::encode(ITradeValidator::validateWithSignaturesCall::SELECTOR)
    );
    let valid_count = if approved { 1 } else { 0 };
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains(validate_selector))
        .respond_with(ResponseTemplate::new(200).set_body_json(rpc_result_hex(
            (approved, U256::from(valid_count)).abi_encode(),
        )))
        .mount(rpc_mock)
        .await;
}

async fn mock_hyperliquid_normal_mode(rpc_mock: &MockServer, bot: &BotContext) {
    trading_http_api::hyperliquid_nav::record_snapshot(hyperliquid_nav_snapshot(
        bot,
        chrono::Utc::now(),
    ))
    .expect("record hyperliquid nav snapshot");

    mock_hyperliquid_mode_queue(rpc_mock).await;
}

async fn mock_hyperliquid_mode_queue(rpc_mock: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("0x9bf2ae82"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(rpc_result_hex(U256::ZERO.abi_encode())),
        )
        .mount(rpc_mock)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("0x635b6ac5"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(rpc_result_hex(U256::from(1_000u64).abi_encode())),
        )
        .mount(rpc_mock)
        .await;
}

fn hyperliquid_nav_snapshot(
    bot: &BotContext,
    as_of: chrono::DateTime<chrono::Utc>,
) -> trading_http_api::hyperliquid_nav::HyperliquidNavSnapshot {
    trading_http_api::hyperliquid_nav::HyperliquidNavSnapshot {
        bot_id: bot.bot_id.clone(),
        account_address: bot.vault_address.clone(),
        vault_address: bot.vault_address.clone(),
        share_token: "0x0000000000000000000000000000000000000002".to_string(),
        asset_token: "0x0000000000000000000000000000000000000003".to_string(),
        as_of,
        status: "fresh".to_string(),
        stale_after_secs: 60,
        idle_usdc: "500".to_string(),
        hyperliquid_equity: "500".to_string(),
        total_nav: "1000".to_string(),
        withdrawable_usdc: "500".to_string(),
        total_margin_used: "0".to_string(),
        total_notional_position: "0".to_string(),
        unrealized_pnl: "0".to_string(),
        total_shares: "1000".to_string(),
        share_price: Some("1".to_string()),
        margin_usage_bps: Some(0),
        open_order_count: 0,
        position_count: 0,
        positions: vec![],
        warnings: vec![],
        onchain_accounting_tx_hash: None,
    }
}

struct FakeHyperliquidNavReconciler {
    result: Result<trading_http_api::hyperliquid_nav::HyperliquidNavSnapshot, (StatusCode, String)>,
    calls: std::sync::atomic::AtomicUsize,
}

impl FakeHyperliquidNavReconciler {
    fn fresh(bot: &BotContext) -> Arc<Self> {
        Arc::new(Self {
            result: Ok(hyperliquid_nav_snapshot(bot, chrono::Utc::now())),
            calls: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn stale(bot: &BotContext) -> Arc<Self> {
        Arc::new(Self {
            result: Ok(hyperliquid_nav_snapshot(
                bot,
                chrono::Utc::now() - chrono::Duration::seconds(120),
            )),
            calls: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn unavailable(message: &str) -> Arc<Self> {
        Arc::new(Self {
            result: Err((StatusCode::BAD_GATEWAY, message.to_string())),
            calls: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl trading_http_api::hyperliquid_nav::HyperliquidNavReconciler for FakeHyperliquidNavReconciler {
    async fn reconcile(
        &self,
        _state: &MultiBotTradingState,
        _bot: &BotContext,
    ) -> Result<trading_http_api::hyperliquid_nav::HyperliquidNavSnapshot, (StatusCode, String)>
    {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(snapshot) = &self.result {
            trading_http_api::hyperliquid_nav::record_snapshot(snapshot.clone())
                .expect("record fake hyperliquid nav snapshot");
        }
        self.result.clone()
    }
}

fn execute_body_for_chain(execution_chain_id: Option<u64>) -> String {
    let mut body = serde_json::json!({
        "intent": {
            "strategy_id": "test-strat",
            "action": "swap",
            "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "amount_in": "1.5",
            "min_amount_out": "3000",
            "target_protocol": "uniswap_v3",
            "metadata": {
                "test_nonce": uuid::Uuid::new_v4().to_string()
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 85,
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 90,
                    "reasoning": "Good trade with favorable market conditions",
                    "signature": TEST_SIG
                },
                {
                    "validator": "0xValidator2",
                    "score": 80,
                    "reasoning": "Acceptable risk level within parameters",
                    "signature": TEST_SIG
                }
            ]
        }
    });
    attach_validation_hashes(&mut body, execution_chain_id);
    serde_json::to_string(&body).unwrap()
}

fn execute_body() -> String {
    execute_body_for_chain(None)
}

fn execute_body_with_metadata(metadata: serde_json::Value) -> String {
    let mut body: serde_json::Value = serde_json::from_str(&execute_body_for_chain(None)).unwrap();
    body["intent"]["metadata"] = metadata;
    attach_validation_hashes(&mut body, None);
    serde_json::to_string(&body).unwrap()
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
    assert_eq!(json["mode"], "paper");
    assert_eq!(json["validator_count"], 0);
    assert_eq!(json["validator_quorum_ready"], true);
    assert_eq!(json["simulation_ready"], true);
    assert_eq!(json["vault_ready"], true);

    let ready_response = build_router(test_state(&mock.uri()).await)
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ready_response.status(), 200);
}

#[tokio::test]
async fn test_health_reports_degraded_live_dependencies() {
    ensure_state_dir();
    let mock = MockServer::start().await;
    let state = Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock.uri()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
        executor: TradeExecutor::new(
            "0x0000000000000000000000000000000000000001",
            "http://localhost:8545",
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            31337,
        )
        .expect("test executor"),
        portfolio: RwLock::new(PortfolioState::default()),
        api_token: TEST_TOKEN.to_string(),
        vault_address: "factory:placeholder".to_string(),
        validator_endpoints: vec![],
        validation_deadline_secs: 3600,
        bot_id: "live-health-bot".to_string(),
        paper_trade: false,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: None,
        chain_id: Some(31337),
        clob_client: None,
        strategy_config: serde_json::Value::Null,
    });
    let app = build_router(state);

    let ready_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ready_response.status(), StatusCode::SERVICE_UNAVAILABLE);

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
    assert_eq!(json["status"], "degraded");
    assert_eq!(json["mode"], "live");
    assert_eq!(json["validator_quorum_ready"], false);
    assert_eq!(json["simulation_ready"], false);
    assert_eq!(json["vault_ready"], false);
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

#[tokio::test]
async fn test_live_reconciliation_portfolio_state_fails_on_outstanding_collateral_rpc_error() {
    let market_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_live_vault_reconciliation_base(
        &rpc_mock,
        ResponseTemplate::new(200).set_body_json(rpc_error("collateral read reverted")),
    )
    .await;

    let state = live_test_state(&market_mock.uri(), &rpc_mock.uri()).await;
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

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body);
    assert_eq!(status, StatusCode::BAD_GATEWAY, "unexpected body: {body}");
    assert!(
        body.contains("totalOutstandingCollateral read failed"),
        "unexpected body: {body}"
    );
}

#[tokio::test]
async fn test_live_reconciliation_portfolio_state_fails_on_outstanding_collateral_decode_error() {
    let market_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_live_vault_reconciliation_base(
        &rpc_mock,
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": "0x1234",
        })),
    )
    .await;

    let state = live_test_state(&market_mock.uri(), &rpc_mock.uri()).await;
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

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body);
    assert_eq!(status, StatusCode::BAD_GATEWAY, "unexpected body: {body}");
    assert!(
        body.contains("totalOutstandingCollateral read failed")
            && body.contains("Failed to decode live u256 response"),
        "unexpected body: {body}"
    );
}

#[tokio::test]
async fn test_live_reconciliation_portfolio_state_fails_on_aave_debt_rpc_error() {
    let market_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_live_vault_reconciliation_base(
        &rpc_mock,
        ResponseTemplate::new(200).set_body_json(rpc_result_hex(U256::ZERO.abi_encode())),
    )
    .await;
    let weth_debt = trading_runtime::aave_v3_registry::reserve_by_symbol(1, "WETH")
        .expect("WETH reserve")
        .variable_debt_token;
    let usdc_debt = trading_runtime::aave_v3_registry::reserve_by_symbol(1, "USDC")
        .expect("USDC reserve")
        .variable_debt_token;
    mock_live_aave_debt_balance(
        &rpc_mock,
        weth_debt,
        ResponseTemplate::new(200).set_body_json(rpc_result_hex(U256::ZERO.abi_encode())),
    )
    .await;
    mock_live_aave_debt_balance(
        &rpc_mock,
        usdc_debt,
        ResponseTemplate::new(200).set_body_json(rpc_error("debt token read failed")),
    )
    .await;

    let state = live_test_state(&market_mock.uri(), &rpc_mock.uri()).await;
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

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body);
    assert_eq!(status, StatusCode::BAD_GATEWAY, "unexpected body: {body}");
    assert!(
        body.contains("Aave variable debt balanceOf failed for USDC"),
        "unexpected body: {body}"
    );
}

#[tokio::test]
async fn test_live_reconciliation_circuit_breaker_fails_on_outstanding_collateral_rpc_error() {
    let market_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_live_vault_reconciliation_base(
        &rpc_mock,
        ResponseTemplate::new(200).set_body_json(rpc_error("collateral read reverted")),
    )
    .await;

    let state = live_test_state(&market_mock.uri(), &rpc_mock.uri()).await;
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

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body);
    assert_eq!(status, StatusCode::BAD_GATEWAY, "unexpected body: {body}");
    assert!(
        body.contains("totalOutstandingCollateral read failed"),
        "unexpected body: {body}"
    );
}

#[tokio::test]
async fn test_live_reconciliation_execute_fails_before_submission_on_outstanding_collateral_rpc_error()
 {
    let market_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_live_vault_reconciliation_base(
        &rpc_mock,
        ResponseTemplate::new(200).set_body_json(rpc_error("collateral read reverted")),
    )
    .await;

    let state = live_test_state(&market_mock.uri(), &rpc_mock.uri()).await;
    let app = build_router(state);
    let mut execute_body: serde_json::Value =
        serde_json::from_str(&execute_body_for_chain(None)).expect("execute body");
    attach_vault_execution_hash(&mut execute_body, 42161);
    attach_validator_signature(
        &mut execute_body,
        42161,
        "0x0000000000000000000000000000000000000001",
        ACTION_KIND_VAULT_EXECUTE,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&execute_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body);
    assert_eq!(status, StatusCode::BAD_GATEWAY, "unexpected body: {body}");
    assert!(
        body.contains("totalOutstandingCollateral read failed"),
        "unexpected body: {body}"
    );
}

#[tokio::test]
async fn test_partial_portfolio_drawdown_triggers_circuit_breaker_and_preserves_flags() {
    use chrono::Utc;
    use rust_decimal::Decimal;
    use trading_runtime::{Position, PositionType, PriceData, ValuationStatus};

    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;

    {
        let mut portfolio = state.portfolio.write().await;
        portfolio.add_position(Position {
            token: "WETH".to_string(),
            amount: Decimal::new(10, 0),
            entry_price: Some(Decimal::new(2500, 0)),
            current_price: Some(Decimal::new(2500, 0)),
            unrealized_pnl: Some(Decimal::ZERO),
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
            valuation_status: ValuationStatus::Priced,
        });
        portfolio.add_position(Position {
            token: "UNKNOWN".to_string(),
            amount: Decimal::new(1, 0),
            entry_price: None,
            current_price: None,
            unrealized_pnl: None,
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
            valuation_status: ValuationStatus::Unpriced,
        });
        portfolio.update_prices(&[PriceData {
            token: "WETH".to_string(),
            price_usd: Decimal::new(1600, 0),
            source: "test".to_string(),
            timestamp: Utc::now(),
        }]);
    }

    let app = build_router(state);

    let circuit_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/circuit-breaker/check")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "max_drawdown_pct": "20.0"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(circuit_response.status(), 200);
    let circuit_body = circuit_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let circuit_json: serde_json::Value = serde_json::from_slice(&circuit_body).unwrap();
    assert_eq!(circuit_json["should_break"], true);
    assert_eq!(
        circuit_json["current_drawdown_pct"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap(),
        Decimal::new(36, 0)
    );

    let portfolio_response = app
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

    assert_eq!(portfolio_response.status(), 200);
    let portfolio_body = portfolio_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let portfolio_json: serde_json::Value = serde_json::from_slice(&portfolio_body).unwrap();
    assert_eq!(portfolio_json["total_value_usd"], "16000");
    assert_eq!(portfolio_json["has_unpriced_positions"], true);
    assert_eq!(portfolio_json["has_value_only_positions"], false);
    assert_eq!(
        portfolio_json["warnings"][0],
        "Some positions still have no current market price, so total portfolio value is hidden."
    );
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
                .header(
                    "access-control-request-headers",
                    "authorization,content-type",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    assert!(
        response
            .headers()
            .contains_key("access-control-allow-origin")
    );
    assert!(
        response
            .headers()
            .contains_key("access-control-allow-methods")
    );
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
    assert!(
        response
            .headers()
            .contains_key("access-control-allow-origin")
    );
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
    let exec_body = exec_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
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
    let list_body = list_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let trades = list_json["trades"].as_array().unwrap();
    assert!(!trades.is_empty(), "Expected at least one trade");

    // Find our trade by tx_hash
    let our_trade = trades
        .iter()
        .find(|t| t["tx_hash"].as_str() == Some(tx_hash));
    assert!(
        our_trade.is_some(),
        "Should find our paper trade in the list"
    );

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
    let list_body = list_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
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
    let detail_body = detail_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let detail: serde_json::Value = serde_json::from_slice(&detail_body).unwrap();

    assert_eq!(detail["id"], trade_id);
    let responses = detail["validation"]["responses"].as_array().unwrap();
    assert_eq!(responses.len(), 2);
    assert!(
        responses[0]["reasoning"]
            .as_str()
            .unwrap()
            .contains("market conditions")
    );
    assert!(
        responses[1]["reasoning"]
            .as_str()
            .unwrap()
            .contains("risk level")
    );
}

#[tokio::test]
async fn test_single_bot_portfolio_normalizes_raw_base_units() {
    let mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v3/simple/price"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "ethereum": { "usd": 2320.69 }
        })))
        .mount(&mock)
        .await;

    let state = test_state_with_chain_id(&format!("{}/api/v3", mock.uri()), 84532).await;
    let app = build_router(state);

    let mut body_json = serde_json::json!({
        "intent": {
            "strategy_id": "test-strat",
            "action": "swap",
            "token_in": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "token_out": "0x4200000000000000000000000000000000000006",
            "amount_in": "1000000000",
            "min_amount_out": "429000000000000000",
            "amount_format": "base_units",
            "target_protocol": "uniswap_v3"
        },
        "validation": {
            "approved": true,
            "aggregate_score": 100,
            "validator_responses": [
                {
                    "validator": "paper-mode",
                    "score": 100,
                    "reasoning": "Paper trade mode — validation bypassed",
                    "signature": format!("0x{}", "00".repeat(65))
                }
            ]
        }
    });
    attach_validation_hashes(&mut body_json, Some(84532));
    let body = serde_json::to_string(&body_json).unwrap();

    let exec_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exec_response.status(), 200);

    let portfolio_response = app
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
    assert_eq!(portfolio_response.status(), 200);

    let portfolio_body = portfolio_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let portfolio_json: serde_json::Value = serde_json::from_slice(&portfolio_body).unwrap();
    assert_eq!(portfolio_json["total_value_usd"], "995.57601");
    assert_eq!(portfolio_json["positions"][0]["amount"], "0.429");
    assert_eq!(portfolio_json["positions"][0]["value_usd"], "995.57601");
}

#[tokio::test]
async fn test_single_bot_swap_estimates_output_amount_instead_of_using_placeholder_floor() {
    let mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v3/simple/price"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "ethereum": { "usd": 2500.0 },
            "usd-coin": { "usd": 1.0 }
        })))
        .mount(&mock)
        .await;

    let state = test_state_with_chain_id(&format!("{}/api/v3", mock.uri()), 84532).await;
    let app = build_router(state);

    let mut body_json = serde_json::json!({
        "intent": {
            "strategy_id": "qa-stochastic-test",
            "action": "swap",
            "token_in": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "token_out": "0x4200000000000000000000000000000000000006",
            "amount_in": "1000000000",
            "min_amount_out": "1",
            "amount_format": "base_units",
            "target_protocol": "uniswap_v3"
        },
        "validation": {
            "approved": true,
            "aggregate_score": 100,
            "validator_responses": [
                {
                    "validator": "paper-mode",
                    "score": 100,
                    "reasoning": "Paper trade mode — validation bypassed",
                    "signature": format!("0x{}", "00".repeat(65))
                }
            ]
        }
    });
    attach_validation_hashes(&mut body_json, Some(84532));
    let body = serde_json::to_string(&body_json).unwrap();

    let exec_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exec_response.status(), 200);

    let portfolio_response = app
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
    assert_eq!(portfolio_response.status(), 200);

    let portfolio_body = portfolio_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let portfolio_json: serde_json::Value = serde_json::from_slice(&portfolio_body).unwrap();

    let amount = portfolio_json["positions"][0]["amount"]
        .as_str()
        .expect("position amount");
    let value_usd = portfolio_json["positions"][0]["value_usd"]
        .as_str()
        .expect("position value");
    assert_eq!(amount.parse::<f64>().unwrap(), 0.4);
    assert_eq!(value_usd.parse::<f64>().unwrap(), 1000.0);
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
    let snap_body = snap_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
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
    let hist_body = hist_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
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
    let bot_id = state.bot_id.clone();
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
    assert_eq!(json["bot_id"], bot_id);
    assert_eq!(json["paper_trade"], true);
    assert_eq!(json["trading_active"], true);
}

// ── Multi-bot trading API tests ─────────────────────────────────────────────

fn multi_bot_state() -> Arc<MultiBotTradingState> {
    let bot_id = format!("bot-{}", uuid::Uuid::new_v4());
    multi_bot_state_with_market_and_bot("http://localhost:1234", "bot-token-abc", &bot_id, 31337)
}

fn multi_bot_state_with_market(market_data_base_url: &str) -> Arc<MultiBotTradingState> {
    let bot_id = format!("bot-{}", uuid::Uuid::new_v4());
    multi_bot_state_with_market_and_bot(market_data_base_url, "bot-token-abc", &bot_id, 31337)
}

fn multi_bot_state_with_strategy_config(
    market_data_base_url: &str,
    strategy_config: serde_json::Value,
) -> Arc<MultiBotTradingState> {
    let bot_id = format!("bot-{}", uuid::Uuid::new_v4());
    multi_bot_state_with_strategy_config_and_bot(
        market_data_base_url,
        "bot-token-abc",
        &bot_id,
        31337,
        strategy_config,
    )
}

fn multi_bot_state_with_market_and_bot(
    market_data_base_url: &str,
    auth_token: &str,
    bot_id: &str,
    chain_id: u64,
) -> Arc<MultiBotTradingState> {
    multi_bot_state_with_strategy_config_and_bot(
        market_data_base_url,
        auth_token,
        bot_id,
        chain_id,
        serde_json::json!({}),
    )
}

fn multi_bot_state_with_strategy_config_and_bot(
    market_data_base_url: &str,
    auth_token: &str,
    bot_id: &str,
    chain_id: u64,
    strategy_config: serde_json::Value,
) -> Arc<MultiBotTradingState> {
    ensure_state_dir();
    let auth_token = auth_token.to_string();
    let bot_id = bot_id.to_string();
    let strategy_config = strategy_config.clone();
    Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: market_data_base_url.to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            if token == auth_token {
                Some(BotContext {
                    bot_id: bot_id.clone(),
                    vault_address: "0x0000000000000000000000000000000000000000".to_string(),
                    paper_trade: true,
                    chain_id,
                    rpc_url: "http://localhost:8545".to_string(),
                    strategy_config: strategy_config.clone(),
                    risk_params: serde_json::json!({}),
                    validator_endpoints: vec![],
                    validation_trust: trading_runtime::ValidationTrust::PerTrade,
                })
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: None,
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    })
}

fn multi_bot_state_for_bot(auth_token: &str, bot: BotContext) -> Arc<MultiBotTradingState> {
    multi_bot_state_for_bot_with_nav_reconciler(
        auth_token,
        bot,
        Arc::new(trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler),
    )
}

fn multi_bot_state_for_bot_with_nav_reconciler(
    auth_token: &str,
    bot: BotContext,
    hyperliquid_nav_reconciler: Arc<
        dyn trading_http_api::hyperliquid_nav::HyperliquidNavReconciler,
    >,
) -> Arc<MultiBotTradingState> {
    ensure_state_dir();
    let auth_token = auth_token.to_string();
    Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            if token == auth_token {
                Some(bot.clone())
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: None,
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler,
    })
}

fn live_bot_with_trust(
    bot_id: &str,
    validation_trust: trading_runtime::ValidationTrust,
) -> BotContext {
    BotContext {
        bot_id: bot_id.to_string(),
        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
        paper_trade: false,
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({}),
        validator_endpoints: vec![],
        validation_trust,
    }
}

const TEST_ENVELOPE_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ENVELOPE_CONTRACT: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TEST_ENVELOPE_SIGNER: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

fn signed_envelope_for_bot(bot: &BotContext) -> SignedEnvelope {
    use rust_decimal::Decimal;
    let mut signed = SignedEnvelope {
        version: 2,
        bot_id: bot.bot_id.clone(),
        vault_address: bot.vault_address.clone(),
        chain_id: bot.chain_id,
        protocol: "hyperliquid".to_string(),
        policy: TradingPolicy {
            max_trade_size_usd: Decimal::from(1000),
            max_total_exposure_usd: Decimal::from(3000),
            max_drawdown_pct: Decimal::from(10),
            can_open_positions: true,
            perps: Some(PerpsPolicy {
                allowed_assets: vec!["ETH".to_string()],
                max_leverage: 5,
                max_stop_loss_distance: Decimal::new(5, 2),
                min_stop_loss_distance: Decimal::new(1, 2),
                require_stop_loss: false,
            }),
            vault: None,
            clob: None,
        },
        approval_signers: vec![TEST_ENVELOPE_SIGNER.to_string()],
        min_signatures: 1,
        issued_at: chrono::Utc::now().timestamp() as u64,
        expires_at: chrono::Utc::now().timestamp() as u64 + 3600,
        nonce: 1,
        verifying_contract: TEST_ENVELOPE_CONTRACT.to_string(),
        enforcement: None,
        signatures: vec![],
    };
    signed
        .sign_with_private_key(TEST_ENVELOPE_KEY, TEST_ENVELOPE_CONTRACT)
        .unwrap();
    signed
}

fn resign_envelope(signed: &mut SignedEnvelope) {
    signed.signatures.clear();
    signed
        .sign_with_private_key(TEST_ENVELOPE_KEY, TEST_ENVELOPE_CONTRACT)
        .unwrap();
}

fn hyperliquid_execute_body(strategy_id: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "intent": {
            "strategy_id": strategy_id,
            "action": "open_long",
            "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "amount_in": "1.5",
            "min_amount_out": "0",
            "target_protocol": "hyperliquid",
            "metadata": {
                "asset": "ETH",
                "stop_loss_pct": 3.0
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 100,
            "validator_responses": []
        }
    });
    attach_validation_hashes(&mut body, Some(31337));
    body
}

#[tokio::test]
async fn test_universal_envelope_route_accepts_signed_envelope() {
    ensure_state_dir();
    let bot_id = format!("bot-universal-env-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("bot-universal-token", bot.clone());
    let app = build_multi_bot_router(state);
    let signed = signed_envelope_for_bot(&bot);

    let put = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/envelope")
                .header("authorization", "Bearer bot-universal-token")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&signed).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put.status(), 200);

    let get = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/envelope")
                .header("authorization", "Bearer bot-universal-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get.status(), 200);
    let body = get.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["bot_id"].as_str().unwrap(), bot.bot_id);
}

#[tokio::test]
async fn test_envelope_status_null_when_no_envelope_stored() {
    ensure_state_dir();
    let bot_id = format!("bot-status-empty-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("status-empty-token", bot);
    let app = build_multi_bot_router(state);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/envelope/status")
                .header("authorization", "Bearer status-empty-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v.is_null());
}

#[tokio::test]
async fn test_envelope_status_reports_basics_when_stored() {
    ensure_state_dir();
    let bot_id = format!("bot-status-stored-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("status-stored-token", bot.clone());
    let signed = signed_envelope_for_bot(&bot);

    put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "status-stored-token",
        &signed,
    )
    .await;

    let res = build_multi_bot_router(Arc::clone(&state))
        .oneshot(
            Request::builder()
                .uri("/envelope/status")
                .header("authorization", "Bearer status-stored-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v.is_object());
    assert_eq!(v["min_signatures"].as_u64().unwrap(), 1);
    assert_eq!(v["signature_count"].as_u64().unwrap(), 1);
    assert!(v["expires_in_seconds"].as_i64().unwrap() > 0);
    assert_eq!(v["protocol"].as_str().unwrap(), "hyperliquid");
}

#[tokio::test]
async fn test_universal_envelope_delete_clears_storage() {
    ensure_state_dir();
    let bot_id = format!("bot-env-delete-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("bot-delete-token", bot.clone());
    let signed = signed_envelope_for_bot(&bot);

    put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "bot-delete-token",
        &signed,
    )
    .await;

    let del = build_multi_bot_router(Arc::clone(&state))
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/envelope")
                .header("authorization", "Bearer bot-delete-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    let get = build_multi_bot_router(Arc::clone(&state))
        .oneshot(
            Request::builder()
                .uri("/envelope")
                .header("authorization", "Bearer bot-delete-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = get.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(value.is_null());
}

#[tokio::test]
async fn test_signed_envelope_endpoint_accepts_operator_signed_per_bot_envelope() {
    ensure_state_dir();
    let bot_id = format!("bot-envelope-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("bot-token-envelope", bot.clone());
    let app = build_multi_bot_router(state);
    let signed = signed_envelope_for_bot(&bot);

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/envelope")
                .header("authorization", "Bearer bot-token-envelope")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&signed).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn test_live_envelope_execute_requires_signed_envelope() {
    ensure_state_dir();
    let bot_id = format!("bot-envelope-missing-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("bot-token-envelope-missing", bot);
    let app = build_multi_bot_router(state);
    let body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-envelope-missing")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn test_live_direct_hyperliquid_order_route_rejects() {
    ensure_state_dir();
    let bot_id = format!("bot-direct-hl-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("bot-token-direct-hl", bot);
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/hyperliquid/order")
                .header("authorization", "Bearer bot-token-direct-hl")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "asset": "ETH",
                        "is_buy": true,
                        "size": "0.1",
                        "order_type": {"type": "market"}
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn test_live_hyperliquid_per_trade_rejects_onchain_validator_denial() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, false).await;

    let bot_id = format!("bot-hl-denied-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    mock_hyperliquid_normal_mode(&rpc_mock, &bot).await;
    let state = multi_bot_state_for_bot("bot-token-hl-denied", bot);
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        "0x0000000000000000000000000000000000000001",
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-denied")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 401, "{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn test_live_hyperliquid_execute_first_trade_refreshes_missing_nav_before_mode_gate() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, false).await;
    mock_hyperliquid_mode_queue(&rpc_mock).await;

    let bot_id = format!("bot-hl-first-nav-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    let nav_reconciler = FakeHyperliquidNavReconciler::fresh(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-first-nav",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        DEFAULT_TEST_VAULT_ADDRESS,
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-first-nav")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 401, "{}", String::from_utf8_lossy(&body));
    assert_eq!(nav_reconciler.calls(), 1);
    let latest_mode = trading_http_api::hyperliquid_mode::latest_mode_for_bot(&bot_id)
        .expect("latest mode")
        .expect("mode snapshot");
    assert_eq!(
        latest_mode.mode,
        trading_http_api::hyperliquid_mode::HyperliquidBotMode::Normal
    );
}

#[tokio::test]
async fn test_live_hyperliquid_execute_refreshes_stale_nav_before_mode_gate() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, false).await;
    mock_hyperliquid_mode_queue(&rpc_mock).await;

    let bot_id = format!("bot-hl-stale-nav-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    trading_http_api::hyperliquid_nav::record_snapshot(hyperliquid_nav_snapshot(
        &bot,
        chrono::Utc::now() - chrono::Duration::seconds(120),
    ))
    .expect("record stale hyperliquid nav snapshot");
    let nav_reconciler = FakeHyperliquidNavReconciler::fresh(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-stale-nav",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        DEFAULT_TEST_VAULT_ADDRESS,
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-stale-nav")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 401, "{}", String::from_utf8_lossy(&body));
    assert_eq!(nav_reconciler.calls(), 1);
    let latest_nav = trading_http_api::hyperliquid_nav::latest_snapshot_for_bot(&bot_id)
        .expect("latest nav")
        .expect("nav snapshot");
    assert!(!latest_nav.is_stale_at(chrono::Utc::now()));
}

#[tokio::test]
async fn test_live_hyperliquid_execute_rejects_when_nav_refresh_stays_stale() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, false).await;

    let bot_id = format!("bot-hl-stale-refresh-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    let nav_reconciler = FakeHyperliquidNavReconciler::stale(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-stale-refresh",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        DEFAULT_TEST_VAULT_ADDRESS,
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-stale-refresh")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 503, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("NAV refresh"));
    assert_eq!(nav_reconciler.calls(), 1);
}

#[tokio::test]
async fn test_live_hyperliquid_execute_rejects_when_nav_refresh_unavailable() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, false).await;

    let bot_id = format!("bot-hl-nav-unavailable-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    let nav_reconciler = FakeHyperliquidNavReconciler::unavailable("Hyperliquid NAV unavailable");
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-nav-unavailable",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        DEFAULT_TEST_VAULT_ADDRESS,
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-nav-unavailable")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 502, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("NAV unavailable"));
    assert_eq!(nav_reconciler.calls(), 1);
}

#[tokio::test]
async fn test_live_hyperliquid_validate_first_trade_refreshes_missing_nav_before_mode_gate() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_hyperliquid_mode_queue(&rpc_mock).await;
    let validator = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 85,
            "signature": TEST_SIG,
            "reasoning": "Mode gate passed after NAV refresh",
            "validator": "0xValidator1"
        })))
        .mount(&validator)
        .await;

    let bot_id = format!("bot-hl-validate-first-nav-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    bot.validator_endpoints = vec![validator.uri()];
    let nav_reconciler = FakeHyperliquidNavReconciler::fresh(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-validate-first-nav",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-hl-validate-first-nav")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    assert_eq!(nav_reconciler.calls(), 1);
    let latest_mode = trading_http_api::hyperliquid_mode::latest_mode_for_bot(&bot_id)
        .expect("latest mode")
        .expect("mode snapshot");
    assert_eq!(
        latest_mode.mode,
        trading_http_api::hyperliquid_mode::HyperliquidBotMode::Normal
    );
}

#[tokio::test]
async fn test_live_hyperliquid_validate_refreshes_stale_nav_before_mode_gate() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_hyperliquid_mode_queue(&rpc_mock).await;
    let validator = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 85,
            "signature": TEST_SIG,
            "reasoning": "Mode gate passed after stale NAV refresh",
            "validator": "0xValidator1"
        })))
        .mount(&validator)
        .await;

    let bot_id = format!("bot-hl-validate-stale-nav-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    bot.validator_endpoints = vec![validator.uri()];
    trading_http_api::hyperliquid_nav::record_snapshot(hyperliquid_nav_snapshot(
        &bot,
        chrono::Utc::now() - chrono::Duration::seconds(120),
    ))
    .expect("record stale hyperliquid nav snapshot");
    let nav_reconciler = FakeHyperliquidNavReconciler::fresh(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-validate-stale-nav",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-hl-validate-stale-nav")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    assert_eq!(nav_reconciler.calls(), 1);
    let latest_nav = trading_http_api::hyperliquid_nav::latest_snapshot_for_bot(&bot_id)
        .expect("latest nav")
        .expect("nav snapshot");
    assert!(!latest_nav.is_stale_at(chrono::Utc::now()));
}

#[tokio::test]
async fn test_live_hyperliquid_validate_rejects_when_nav_refresh_stays_stale() {
    ensure_state_dir();

    let bot_id = format!("bot-hl-validate-stale-refresh-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    let nav_reconciler = FakeHyperliquidNavReconciler::stale(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-validate-stale-refresh",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header(
                    "authorization",
                    "Bearer bot-token-hl-validate-stale-refresh",
                )
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 503, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("NAV refresh"));
    assert_eq!(nav_reconciler.calls(), 1);
}

#[tokio::test]
async fn test_live_hyperliquid_validate_rejects_when_nav_refresh_unavailable() {
    ensure_state_dir();

    let bot_id = format!("bot-hl-validate-nav-unavailable-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    let nav_reconciler = FakeHyperliquidNavReconciler::unavailable("Hyperliquid NAV unavailable");
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hl-validate-nav-unavailable",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header(
                    "authorization",
                    "Bearer bot-token-hl-validate-nav-unavailable",
                )
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 502, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("NAV unavailable"));
    assert_eq!(nav_reconciler.calls(), 1);
}

#[tokio::test]
async fn test_hyperliquid_execute_rejects_account_metadata_mismatch() {
    ensure_state_dir();
    let bot_id = format!("bot-hl-account-mismatch-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    let state = multi_bot_state_for_bot("bot-token-hl-account-mismatch", bot);
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["intent"]["metadata"]["hyperliquid_account_address"] =
        serde_json::json!("0x2222222222222222222222222222222222222222");

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-account-mismatch")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("does not match the provisioned bot account"));
}

#[tokio::test]
async fn test_live_hyperliquid_per_trade_rejects_config_account_drift() {
    ensure_state_dir();
    let bot_id = format!("bot-hl-config-drift-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.strategy_config = serde_json::json!({
        "hyperliquid_account_source": "hyperevm_vault_contract",
        "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
    });
    let state = multi_bot_state_for_bot("bot-token-hl-config-drift", bot);
    let app = build_multi_bot_router(state);
    let body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-config-drift")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("configured account"));
}

#[tokio::test]
async fn test_live_hyperliquid_envelope_rejects_config_account_drift() {
    ensure_state_dir();
    let bot_id = format!("bot-hl-envelope-config-drift-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    bot.strategy_config = serde_json::json!({
        "hyperliquid_account_source": "hyperevm_vault_contract",
        "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
    });
    let state = multi_bot_state_for_bot("bot-token-hl-envelope-config-drift", bot);
    let app = build_multi_bot_router(state);
    let body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-envelope-config-drift")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("configured account"));
}

#[tokio::test]
async fn test_live_hyperliquid_validate_rejects_config_account_drift() {
    ensure_state_dir();
    let bot_id = format!("bot-hl-validate-config-drift-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.strategy_config = serde_json::json!({
        "hyperliquid_account_source": "hyperevm_vault_contract",
        "hyperliquid_account_address": "0x2222222222222222222222222222222222222222"
    });
    let state = multi_bot_state_for_bot("bot-token-hl-validate-config-drift", bot);
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/validate")
                .header("authorization", "Bearer bot-token-hl-validate-config-drift")
                .header("content-type", "application/json")
                .body(Body::from(validate_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("configured account"));
}

#[tokio::test]
async fn test_live_hyperliquid_execute_rejects_leverage_metadata_before_submission() {
    ensure_state_dir();
    let bot_id = format!("bot-hl-leverage-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    let state = multi_bot_state_for_bot("bot-token-hl-leverage", bot);
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["intent"]["metadata"]["leverage"] = serde_json::json!(2);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-leverage")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("does not accept leverage metadata"));
    assert!(body.contains("account-scoped leverage"));
}

#[tokio::test]
async fn test_live_hyperliquid_execute_rejects_pending_api_wallet_approval_before_submission() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, true).await;

    let bot_id = format!("bot-hl-pending-approval-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    bot.strategy_config = serde_json::json!({
        "hyperliquid_account_source": "hyperevm_vault_contract",
        "hyperliquid_api_wallet_approval_status": "pending_corewriter_approval"
    });
    mock_hyperliquid_normal_mode(&rpc_mock, &bot).await;
    let state = multi_bot_state_for_bot("bot-token-hl-pending-approval", bot);
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        DEFAULT_TEST_VAULT_ADDRESS,
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-pending-approval")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("API wallet approval is not submitted"));
}

#[tokio::test]
async fn test_live_hyperliquid_execute_rejects_kill_switch_before_submission() {
    ensure_state_dir();
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, true).await;

    let bot_id = format!("bot-hl-kill-switch-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    bot.strategy_config = serde_json::json!({
        "hyperliquid_kill_switch": true,
        "hyperliquid_api_wallet_approval_status": "submitted_corewriter_approval"
    });
    mock_hyperliquid_normal_mode(&rpc_mock, &bot).await;
    let state = multi_bot_state_for_bot("bot-token-hl-kill-switch", bot);
    let app = build_multi_bot_router(state);
    let mut body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["validation"]["aggregate_score"] = serde_json::json!(75);
    attach_signed_validation(
        &mut body,
        31337,
        DEFAULT_TEST_VAULT_ADDRESS,
        ACTION_KIND_HYPERLIQUID_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-hl-kill-switch")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("execution is disabled"));
}

#[tokio::test]
async fn test_live_self_operated_execute_rejects_by_default() {
    ensure_state_dir();
    let bot_id = format!("bot-self-operated-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::SelfOperated);
    let state = multi_bot_state_for_bot("bot-token-self-operated", bot);
    let app = build_multi_bot_router(state);
    let body = hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-self-operated")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 403);
}

// ── Paper-mode envelope constraint tests ─────────────────────────────────────

fn paper_bot_with_envelope_trust(bot_id: &str) -> BotContext {
    let mut bot = live_bot_with_trust(bot_id, trading_runtime::ValidationTrust::Envelope);
    bot.paper_trade = true;
    bot
}

/// Like `hyperliquid_execute_body` but with the paper-mode bypass in
/// `validator_responses` so that `ensure_paper_validation_consistency` passes,
/// and with a zero execution_hash because paper trades skip payload binding.
fn paper_hyperliquid_execute_body(strategy_id: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "intent": {
            "strategy_id": strategy_id,
            "action": "open_long",
            "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "amount_in": "1.5",
            "min_amount_out": "0",
            "target_protocol": "hyperliquid",
            "metadata": {
                "asset": "ETH",
                "leverage": 2,
                "stop_loss_pct": 3.0
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 100,
            "validator_responses": [
                {
                    "validator": "paper-mode",
                    "score": 100,
                    "reasoning": "Paper trade mode — validation bypassed",
                    "signature": format!("0x{}", "00".repeat(65))
                }
            ]
        }
    });
    // Compute the real intent_hash (needed for hash binding), but zero out
    // execution_hash because paper trades use bind_execution_payload=false
    // and the server therefore expects 0x000...000 for execution_hash.
    attach_validation_hashes(&mut body, Some(31337));
    body["validation"]["execution_hash"] = serde_json::json!(format!("0x{}", "00".repeat(32)));
    body
}

/// Recompute validation hashes for a body after its metadata has been modified.
/// Required when `paper_hyperliquid_execute_body` is used and then fields mutated.
fn reattach_paper_validation_hashes(body: &mut serde_json::Value) {
    attach_validation_hashes(body, Some(31337));
    body["validation"]["execution_hash"] = serde_json::json!(format!("0x{}", "00".repeat(32)));
}

async fn put_signed_envelope(
    app: axum::Router,
    auth_token: &str,
    signed: &SignedEnvelope,
) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .method("PUT")
            .uri("/envelope")
            .header("authorization", format!("Bearer {auth_token}"))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(signed).unwrap()))
            .unwrap(),
    )
    .await
    .unwrap()
}

async fn execute_with_body(
    app: axum::Router,
    auth_token: &str,
    body: serde_json::Value,
) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/execute")
            .header("authorization", format!("Bearer {auth_token}"))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn test_paper_envelope_execute_rejects_when_no_envelope_stored() {
    ensure_state_dir();
    let bot_id = format!("bot-paper-env-missing-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("paper-env-missing-token", bot);
    let app = build_multi_bot_router(state);
    let body = paper_hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));

    let response = execute_with_body(app, "paper-env-missing-token", body).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&bytes));
}

#[tokio::test]
async fn test_paper_envelope_execute_rejects_disallowed_asset() {
    ensure_state_dir();
    let bot_id = format!("bot-paper-env-asset-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("paper-env-asset-token", bot.clone());

    // Build envelope that only allows BTC (not ETH)
    let mut signed = signed_envelope_for_bot(&bot);
    signed.policy.perps.as_mut().unwrap().allowed_assets = vec!["BTC".to_string()];
    resign_envelope(&mut signed);

    // Store the envelope
    let put_response = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-env-asset-token",
        &signed,
    )
    .await;
    assert_eq!(put_response.status(), 200, "PUT envelope should succeed");

    // Execute with ETH (not in whitelist)
    let body = paper_hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    let response = execute_with_body(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-env-asset-token",
        body,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&bytes));
    assert!(
        String::from_utf8_lossy(&bytes).contains("whitelist")
            || String::from_utf8_lossy(&bytes).contains("envelope"),
        "{}",
        String::from_utf8_lossy(&bytes)
    );
}

#[tokio::test]
async fn test_paper_envelope_execute_rejects_excessive_leverage() {
    ensure_state_dir();
    let bot_id = format!("bot-paper-lev-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("paper-lev-token", bot.clone());

    // Build envelope with max_leverage = 2
    let mut signed = signed_envelope_for_bot(&bot);
    signed.policy.perps.as_mut().unwrap().max_leverage = 2;
    resign_envelope(&mut signed);

    let put_response = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-lev-token",
        &signed,
    )
    .await;
    assert_eq!(put_response.status(), 200);

    // Execute with leverage=5 (exceeds max_leverage=2)
    let mut body = paper_hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["intent"]["metadata"]["leverage"] = serde_json::json!(5);
    reattach_paper_validation_hashes(&mut body);
    let response = execute_with_body(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-lev-token",
        body,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&bytes));
}

#[tokio::test]
async fn test_paper_envelope_execute_rejects_missing_stop_loss() {
    ensure_state_dir();
    let bot_id = format!("bot-paper-sl-missing-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("paper-sl-missing-token", bot.clone());

    let mut signed = signed_envelope_for_bot(&bot);
    signed.policy.perps.as_mut().unwrap().require_stop_loss = true;
    resign_envelope(&mut signed);

    put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-sl-missing-token",
        &signed,
    )
    .await;

    // Request with no stop_loss metadata
    let mut body = paper_hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["intent"]["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("stop_loss_pct");
    reattach_paper_validation_hashes(&mut body);
    let response = execute_with_body(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-sl-missing-token",
        body,
    )
    .await;
    // require_stop_loss=true rejects missing SL with 403 (FORBIDDEN, StopLossRequired)
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn test_paper_envelope_execute_rejects_stop_loss_out_of_bounds() {
    ensure_state_dir();
    let bot_id = format!("bot-paper-sl-oob-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("paper-sl-oob-token", bot.clone());

    // Default envelope has max_stop_loss_distance: 0.05 (5%)
    let signed = signed_envelope_for_bot(&bot);

    put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-sl-oob-token",
        &signed,
    )
    .await;

    // stop_loss_pct: 20% → distance 0.20 exceeds max 0.05
    let mut body = paper_hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    body["intent"]["metadata"]["stop_loss_pct"] = serde_json::json!(20.0);
    reattach_paper_validation_hashes(&mut body);
    let response = execute_with_body(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-sl-oob-token",
        body,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 403, "{}", String::from_utf8_lossy(&bytes));
}

// ── Nonce monotonicity tests ──────────────────────────────────────────────────

#[tokio::test]
async fn test_envelope_nonce_upgrade_accepted() {
    ensure_state_dir();
    let bot_id = format!("bot-nonce-up-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("nonce-up-token", bot.clone());

    let mut signed1 = signed_envelope_for_bot(&bot);
    signed1.nonce = 1;
    resign_envelope(&mut signed1);

    let r1 = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "nonce-up-token",
        &signed1,
    )
    .await;
    assert_eq!(r1.status(), 200, "first PUT should succeed");

    let mut signed2 = signed_envelope_for_bot(&bot);
    signed2.nonce = 2;
    resign_envelope(&mut signed2);

    let r2 = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "nonce-up-token",
        &signed2,
    )
    .await;
    assert_eq!(r2.status(), 200, "nonce upgrade should succeed");
}

#[tokio::test]
async fn test_envelope_nonce_downgrade_rejected() {
    ensure_state_dir();
    let bot_id = format!("bot-nonce-down-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("nonce-down-token", bot.clone());

    let mut signed5 = signed_envelope_for_bot(&bot);
    signed5.nonce = 5;
    resign_envelope(&mut signed5);

    put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "nonce-down-token",
        &signed5,
    )
    .await;

    let mut signed3 = signed_envelope_for_bot(&bot);
    signed3.nonce = 3;
    resign_envelope(&mut signed3);

    let r_down = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "nonce-down-token",
        &signed3,
    )
    .await;
    let status = r_down.status();
    let bytes = r_down.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        status,
        409,
        "nonce downgrade should be rejected: {}",
        String::from_utf8_lossy(&bytes)
    );
}

#[tokio::test]
async fn test_paper_envelope_execute_rejects_open_in_close_only_mode() {
    ensure_state_dir();
    let bot_id = format!("bot-paper-co-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("paper-co-token", bot.clone());

    let mut signed = signed_envelope_for_bot(&bot);
    signed.policy.can_open_positions = false; // close-only
    resign_envelope(&mut signed);

    let put = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-co-token",
        &signed,
    )
    .await;
    assert_eq!(put.status(), 200);

    // open_long is an opening action; close-only mode must reject it.
    let body = paper_hyperliquid_execute_body(&format!("strategy-{}", uuid::Uuid::new_v4()));
    let response = execute_with_body(
        build_multi_bot_router(Arc::clone(&state)),
        "paper-co-token",
        body,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&bytes);
    assert_eq!(status, 403, "{msg}");
    assert!(msg.contains("close-only") || msg.contains("close"), "{msg}");
}

#[tokio::test]
async fn test_signed_envelope_endpoint_rejects_corrupt_signature_with_400() {
    ensure_state_dir();
    let bot_id = format!("bot-corrupt-sig-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("corrupt-sig-token", bot.clone());

    let mut signed = signed_envelope_for_bot(&bot);
    // truncate signature to invalid length — should map to BAD_REQUEST (400)
    signed.signatures[0].signature = format!("0x{}", "aa".repeat(32));

    let response = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "corrupt-sig-token",
        &signed,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&bytes);
    assert_eq!(status, 400, "{msg}");
}

#[tokio::test]
async fn test_signed_envelope_endpoint_rejects_non_hex_signature_with_400() {
    ensure_state_dir();
    let bot_id = format!("bot-hex-sig-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("hex-sig-token", bot.clone());

    let mut signed = signed_envelope_for_bot(&bot);
    signed.signatures[0].signature = "totally-not-hex".into();

    let response = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "hex-sig-token",
        &signed,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&bytes);
    assert_eq!(status, 400, "{msg}");
}

#[tokio::test]
async fn test_signed_envelope_endpoint_rejects_expired_envelope_with_403() {
    ensure_state_dir();
    let bot_id = format!("bot-expired-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("expired-token", bot.clone());

    let mut signed = signed_envelope_for_bot(&bot);
    signed.expires_at = 1_000; // long past
    resign_envelope(&mut signed);

    let response = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "expired-token",
        &signed,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&bytes);
    assert_eq!(status, 403, "{msg}");
    assert!(
        msg.contains("expired") || msg.contains("expires_at"),
        "{msg}"
    );
}

#[tokio::test]
async fn test_signed_envelope_endpoint_rejects_wrong_version_with_403() {
    ensure_state_dir();
    let bot_id = format!("bot-version-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("version-token", bot.clone());

    let mut signed = signed_envelope_for_bot(&bot);
    signed.version = 1; // v1 is not supported
    resign_envelope(&mut signed);

    let response = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "version-token",
        &signed,
    )
    .await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let msg = String::from_utf8_lossy(&bytes);
    assert_eq!(status, 403, "{msg}");
    assert!(msg.contains("version"), "{msg}");
}

#[tokio::test]
async fn test_envelope_same_nonce_rejected() {
    ensure_state_dir();
    let bot_id = format!("bot-nonce-same-{}", uuid::Uuid::new_v4());
    let bot = paper_bot_with_envelope_trust(&bot_id);
    let state = multi_bot_state_for_bot("nonce-same-token", bot.clone());

    let make_envelope = |nonce: u64| {
        let mut s = signed_envelope_for_bot(&bot);
        s.nonce = nonce;
        resign_envelope(&mut s);
        s
    };

    put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "nonce-same-token",
        &make_envelope(4),
    )
    .await;

    let r_same = put_signed_envelope(
        build_multi_bot_router(Arc::clone(&state)),
        "nonce-same-token",
        &make_envelope(4),
    )
    .await;
    assert_eq!(r_same.status(), 409, "same nonce should be rejected");
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
    assert_eq!(json["status"], "degraded");
    assert_eq!(json["mode"], "multi");
    assert_eq!(json["rpc_ready"], false);
    assert_eq!(json["simulation_ready"], false);
    assert!(json["validator_count"].is_null());

    let ready_response = build_multi_bot_router(multi_bot_state())
        .oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ready_response.status(), StatusCode::SERVICE_UNAVAILABLE);
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
async fn test_multi_bot_market_data_prices() {
    let mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/price/WETH"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "price": 2500.50,
            "symbol": "WETH"
        })))
        .mount(&mock)
        .await;

    Mock::given(method("GET"))
        .and(path("/price/USDC"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "price": 1.0,
            "symbol": "USDC"
        })))
        .mount(&mock)
        .await;

    let state = multi_bot_state_with_market(&mock.uri());
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/prices")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "tokens": ["WETH", "USDC"]
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
async fn test_multi_bot_market_data_prices_uses_configured_asset_address_fallback() {
    let mock = MockServer::start().await;
    let uni_address = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";

    Mock::given(method("GET"))
        .and(path(format!("/price/{uni_address}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "price": 3.45,
            "symbol": "UNI"
        })))
        .mount(&mock)
        .await;

    let state = multi_bot_state_with_strategy_config(
        &mock.uri(),
        serde_json::json!({
            "strategy_type": "dex",
            "protocol_chain_id": 1,
            "asset_universe": {
                "allowed_assets": [
                    {
                        "symbol": "UNI",
                        "address": uni_address,
                        "chain_id": 1,
                        "decimals": 18,
                        "protocol": "uniswap_v3",
                        "roles": ["input", "output"],
                        "valuation_adapter": "chainlink_or_uniswap_v3_twap"
                    }
                ]
            }
        }),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/prices")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "tokens": ["UNI"]
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
    assert_eq!(prices.len(), 1);
    assert_eq!(prices[0]["token"], "UNI");
    assert_eq!(prices[0]["price_usd"], "3.45");
}

#[tokio::test]
async fn test_multi_bot_circuit_breaker_accepts_numeric_payload() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/circuit-breaker/check")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "max_drawdown_pct": 10.0
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

#[tokio::test]
async fn test_multi_bot_portfolio_state_exists() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["positions"].is_array());
    assert!(json["total_value_usd"].is_string());
}

#[tokio::test]
async fn test_multi_bot_adapters_list() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/adapters")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(
        json["adapters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|adapter| adapter == "uniswap_v3")
    );
}

#[tokio::test]
async fn test_multi_bot_metrics_snapshot_and_history() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let snap_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/metrics/snapshot")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "account_value_usd": "10500.50",
                        "unrealized_pnl": "500.50",
                        "realized_pnl": "200.00",
                        "high_water_mark": "10500.50",
                        "drawdown_pct": "0.0",
                        "positions_count": 0,
                        "trade_count": 0
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(snap_response.status(), 200);

    let hist_response = app
        .oneshot(
            Request::builder()
                .uri("/metrics/history?limit=10")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(hist_response.status(), 200);
    let hist_body = hist_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let hist_json: serde_json::Value = serde_json::from_slice(&hist_body).unwrap();
    assert!(!hist_json["snapshots"].as_array().unwrap().is_empty());
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
                .body(Body::from(execute_body_for_chain(Some(31337))))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["paper_trade"], true);
    let tx_hash = json["tx_hash"].as_str().unwrap();
    assert!(
        tx_hash.starts_with("0xpaper_"),
        "tx_hash should start with 0xpaper_, got: {tx_hash}"
    );
}

#[tokio::test]
async fn test_single_bot_paper_clob_trade_persists_prediction_metadata() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/book"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "market": "0x0000000000000000000000000000000000000000000000000000000000000abc",
            "asset_id": "48328953829",
            "bids": [
                {"price": "0.57", "size": "100.0"}
            ],
            "asks": [
                {"price": "0.58", "size": "150.0"}
            ],
            "timestamp": "1740000000000",
            "min_order_size": "1.0",
            "neg_risk": false,
            "tick_size": "0.01"
        })))
        .mount(&clob_mock)
        .await;

    let bot_id = format!("paper-prediction-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id_and_clob(&mock.uri(), &bot_id, &clob_mock.uri()).await;
    let app = build_router(state);

    let mut execute_body_json = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "48328953829",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.585,
                "condition_id": "0xcondition-paper",
                "market_question": "Will ETH be above $4,000 on June 30?",
                "outcome_label": "YES",
                "outcome_index": 0,
                "market_slug": "eth-above-4000-june-30"
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 88,
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 88,
                    "reasoning": "Good paper prediction trade",
                    "signature": TEST_SIG
                }
            ]
        }
    });
    attach_validation_hashes(&mut execute_body_json, None);
    let execute_body = serde_json::to_string(&execute_body_json).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(execute_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let trades = trading_http_api::trade_store::trades_for_bot(&bot_id, 10, 0)
        .expect("paper clob trades")
        .trades;
    let trade = trades
        .into_iter()
        .find(|trade| trade.target_protocol == "polymarket_clob")
        .expect("paper clob trade");

    assert_eq!(
        trade.execution_status,
        Some(trading_http_api::trade_store::TradeExecutionStatus::Filled)
    );
    assert_eq!(trade.requested_price_usd.as_deref(), Some("0.585"));
    assert_eq!(trade.filled_price_usd.as_deref(), Some("0.58"));
    assert_eq!(trade.filled_amount.as_deref(), Some("100.0"));
    assert_eq!(
        trade
            .prediction_metadata
            .as_ref()
            .and_then(|metadata| metadata.condition_id.as_deref()),
        Some("0xcondition-paper")
    );
    assert_eq!(
        trade
            .prediction_metadata
            .as_ref()
            .and_then(|metadata| metadata.market_question.as_deref()),
        Some("Will ETH be above $4,000 on June 30?")
    );
    assert_eq!(
        trade
            .prediction_metadata
            .as_ref()
            .and_then(|metadata| metadata.outcome_label.as_deref()),
        Some("YES")
    );
}

#[tokio::test]
async fn test_single_bot_paper_clob_sell_without_inventory_is_rejected() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;
    let bot_id = format!("paper-prediction-no-inventory-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id_and_clob(&mock.uri(), &bot_id, &clob_mock.uri()).await;
    let app = build_router(state);

    let mut execute_body_json = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "sell",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "48328953829",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.585,
                "condition_id": "0xcondition-paper",
                "outcome_label": "YES",
                "outcome_index": 0
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 88,
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 88,
                    "reasoning": "Good paper prediction trade",
                    "signature": TEST_SIG
                }
            ]
        }
    });
    attach_validation_hashes(&mut execute_body_json, None);
    let execute_body = serde_json::to_string(&execute_body_json).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(execute_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&body);
    assert!(
        text.contains("Cannot sell 100.0 shares"),
        "unexpected rejection body: {text}"
    );

    let trades = trading_http_api::trade_store::trades_for_bot(&bot_id, 10, 0)
        .expect("paper clob trades")
        .trades;
    assert!(trades.is_empty());
}

#[tokio::test]
async fn test_single_bot_paper_clob_trade_records_partial_fill() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/book"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "market": "0x0000000000000000000000000000000000000000000000000000000000000abc",
            "asset_id": "48328953829",
            "bids": [
                {"price": "0.53", "size": "100.0"}
            ],
            "asks": [
                {"price": "0.54", "size": "40.0"},
                {"price": "0.60", "size": "100.0"}
            ],
            "timestamp": "1740000000000",
            "min_order_size": "1.0",
            "neg_risk": false,
            "tick_size": "0.01"
        })))
        .mount(&clob_mock)
        .await;

    let bot_id = format!("paper-prediction-partial-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id_and_clob(&mock.uri(), &bot_id, &clob_mock.uri()).await;
    let app = build_router(state);

    let mut execute_body_json = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "48328953829",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.55,
                "condition_id": "0xcondition-partial",
                "outcome_label": "YES"
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 88,
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 88,
                    "reasoning": "Good paper prediction trade",
                    "signature": TEST_SIG
                }
            ]
        }
    });
    attach_validation_hashes(&mut execute_body_json, None);
    let execute_body = serde_json::to_string(&execute_body_json).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(execute_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let trades = trading_http_api::trade_store::trades_for_bot(&bot_id, 10, 0)
        .expect("paper clob trades")
        .trades;
    let trade = trades
        .into_iter()
        .find(|trade| trade.target_protocol == "polymarket_clob")
        .expect("paper clob trade");

    assert_eq!(
        trade.execution_status,
        Some(trading_http_api::trade_store::TradeExecutionStatus::Partial)
    );
    assert_eq!(trade.requested_price_usd.as_deref(), Some("0.55"));
    assert_eq!(trade.filled_price_usd.as_deref(), Some("0.54"));
    assert_eq!(trade.filled_amount.as_deref(), Some("40.0"));
}

#[tokio::test]
async fn test_single_bot_paper_clob_trade_records_no_fill() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/book"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "market": "0x0000000000000000000000000000000000000000000000000000000000000abc",
            "asset_id": "48328953829",
            "bids": [
                {"price": "0.53", "size": "100.0"}
            ],
            "asks": [
                {"price": "0.60", "size": "100.0"}
            ],
            "timestamp": "1740000000000",
            "min_order_size": "1.0",
            "neg_risk": false,
            "tick_size": "0.01"
        })))
        .mount(&clob_mock)
        .await;

    let bot_id = format!("paper-prediction-no-fill-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id_and_clob(&mock.uri(), &bot_id, &clob_mock.uri()).await;
    let app = build_router(state);

    let mut execute_body_json = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "48328953829",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.55,
                "condition_id": "0xcondition-no-fill",
                "outcome_label": "YES"
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 88,
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 88,
                    "reasoning": "Good paper prediction trade",
                    "signature": TEST_SIG
                }
            ]
        }
    });
    attach_validation_hashes(&mut execute_body_json, None);
    let execute_body = serde_json::to_string(&execute_body_json).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(execute_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let trades = trading_http_api::trade_store::trades_for_bot(&bot_id, 10, 0)
        .expect("paper clob trades")
        .trades;
    let trade = trades
        .into_iter()
        .find(|trade| trade.target_protocol == "polymarket_clob")
        .expect("paper clob trade");

    assert_eq!(
        trade.execution_status,
        Some(trading_http_api::trade_store::TradeExecutionStatus::NoFill)
    );
    assert_eq!(trade.requested_price_usd.as_deref(), Some("0.55"));
    assert!(trade.filled_price_usd.is_none());
    assert!(trade.filled_amount.is_none());
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_synthesizes_paper_swap_positions() {
    let mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v3/simple/price"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "usd-coin": { "usd": 1.0 }
        })))
        .mount(&mock)
        .await;

    let auth_token = "bot-token-synth";
    let bot_id = format!("bot-synth-{}", uuid::Uuid::new_v4());
    let state = multi_bot_state_with_market_and_bot(
        &format!("{}/api/v3", mock.uri()),
        auth_token,
        &bot_id,
        31337,
    );
    let app = build_multi_bot_router(state);

    let exec_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", format!("Bearer {auth_token}"))
                .header("content-type", "application/json")
                .body(Body::from(execute_body_for_chain(Some(31337))))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exec_response.status(), 200);

    let portfolio_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", format!("Bearer {auth_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(portfolio_response.status(), 200);
    let body = portfolio_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();
    assert_eq!(json["total_value_usd"], "3000");
    assert_eq!(positions.len(), 1);
    assert_eq!(
        positions[0]["token"],
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );
    assert_eq!(positions[0]["amount"], "3000");
    assert_eq!(positions[0]["value_usd"], "3000");
    assert_eq!(json["warnings"], serde_json::json!([]));
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_preserves_snapshot_total_when_vault_lookup_fails() {
    ensure_state_dir();

    let auth_token = "bot-token-snapshot-fallback";
    let bot_id = format!("bot-snapshot-fallback-{}", uuid::Uuid::new_v4());
    trading_http_api::metrics_store::record_snapshot(
        trading_http_api::metrics_store::MetricSnapshot {
            timestamp: chrono::Utc::now(),
            bot_id: bot_id.clone(),
            account_value_usd: "1200".to_string(),
            unrealized_pnl: "0".to_string(),
            realized_pnl: "0".to_string(),
            high_water_mark: "1200".to_string(),
            drawdown_pct: "0".to_string(),
            positions_count: 1,
            trade_count: 1,
        },
    )
    .expect("record snapshot");
    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: format!("trade-snapshot-fallback-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.clone(),
        timestamp: chrono::Utc::now(),
        action: "swap".to_string(),
        token_in: "WETH".to_string(),
        token_out: "USDC".to_string(),
        amount_in: "0.25".to_string(),
        min_amount_out: "500".to_string(),
        target_protocol: "uniswap_v3".to_string(),
        tx_hash: "0xsnapshotfallback".to_string(),
        block_number: None,
        gas_used: None,
        paper_trade: false,
        execution_status: Some(trading_http_api::trade_store::TradeExecutionStatus::Submitted),
        clob_order_id: None,
        amount_out: Some("500".to_string()),
        entry_price_usd: Some("1".to_string()),
        notional_usd: Some("500".to_string()),
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
            intent_hash: "0xintent-snapshot-fallback".to_string(),
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
        candidate_hash: None,
        revision_id: None,
        paper_pnl_pct: None,
        paper_equity_after: None,
    })
    .await
    .expect("record trade");

    let state = Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new({
            let auth_token = auth_token.to_string();
            let bot_id = bot_id.clone();
            move |token: &str| {
                if token == auth_token {
                    Some(BotContext {
                        bot_id: bot_id.clone(),
                        vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                        paper_trade: true,
                        chain_id: 31337,
                        rpc_url: "http://127.0.0.1:1".to_string(),
                        strategy_config: serde_json::json!({}),
                        risk_params: serde_json::json!({}),
                        validator_endpoints: vec![],
                        validation_trust: trading_runtime::ValidationTrust::PerTrade,
                    })
                } else {
                    None
                }
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: None,
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    });
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", format!("Bearer {auth_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["total_value_usd"], "1200");
    assert_eq!(json["positions"][0]["token"], "USDC");
    assert!(json["warnings"].as_array().unwrap().iter().any(|warning| {
        warning
            .as_str()
            .unwrap_or_default()
            .contains("using latest snapshot fallback")
    }));
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_keeps_polymarket_buy_as_conditional_position() {
    let bot_id = format!("bot-polymarket-{}", uuid::Uuid::new_v4());
    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: format!("trade-polymarket-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.clone(),
        timestamp: chrono::Utc::now(),
        action: "buy".to_string(),
        token_in: "USDC".to_string(),
        token_out: "pm_yes_token".to_string(),
        amount_in: "55".to_string(),
        min_amount_out: "100".to_string(),
        target_protocol: "polymarket_clob".to_string(),
        tx_hash: "0xpolymarket".to_string(),
        block_number: None,
        gas_used: None,
        paper_trade: false,
        execution_status: Some(trading_http_api::trade_store::TradeExecutionStatus::Submitted),
        clob_order_id: None,
        amount_out: Some("100".to_string()),
        entry_price_usd: Some("0.55".to_string()),
        notional_usd: Some("55".to_string()),
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
            intent_hash: "0xintent-polymarket".to_string(),
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
        candidate_hash: None,
        revision_id: None,
        paper_pnl_pct: None,
        paper_equity_after: None,
    })
    .await
    .expect("record trade");

    let state = multi_bot_state_with_market_and_bot(
        "http://localhost:1234",
        "bot-token-polymarket",
        &bot_id,
        31337,
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-polymarket")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["token"], "pm_yes_token");
    assert_eq!(positions[0]["protocol"], "polymarket_clob");
    assert_eq!(positions[0]["position_type"], "conditional_token");
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_keeps_hyperliquid_buy_as_perp_position() {
    let bot_id = format!("bot-hyperliquid-{}", uuid::Uuid::new_v4());
    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: format!("trade-hyperliquid-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.clone(),
        timestamp: chrono::Utc::now(),
        action: "buy".to_string(),
        token_in: "USDC".to_string(),
        token_out: "ETH".to_string(),
        amount_in: "100".to_string(),
        min_amount_out: "0.05".to_string(),
        target_protocol: "hyperliquid".to_string(),
        tx_hash: "0xhyperliquid".to_string(),
        block_number: None,
        gas_used: None,
        paper_trade: false,
        execution_status: Some(trading_http_api::trade_store::TradeExecutionStatus::Submitted),
        clob_order_id: None,
        amount_out: Some("0.05".to_string()),
        entry_price_usd: Some("2000".to_string()),
        notional_usd: Some("100".to_string()),
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
            intent_hash: "0xintent-hyperliquid".to_string(),
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
        candidate_hash: None,
        revision_id: None,
        paper_pnl_pct: None,
        paper_equity_after: None,
    })
    .await
    .expect("record trade");

    let state = multi_bot_state_with_market_and_bot(
        "http://localhost:1234",
        "bot-token-hyperliquid",
        &bot_id,
        31337,
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-hyperliquid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["token"], "ETH");
    assert_eq!(positions[0]["protocol"], "hyperliquid");
    assert_eq!(positions[0]["position_type"], "long_perp");
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_uses_hyperliquid_nav_for_live_perp_bot() {
    let bot_id = format!("bot-hyperliquid-nav-{}", uuid::Uuid::new_v4());
    let mut bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::PerTrade);
    bot.chain_id = 998;
    bot.strategy_config = serde_json::json!({
        "strategy_type": "hyperliquid_perp",
        "hyperliquid_execution_model": "hyperevm_vault_agent"
    });

    let nav_reconciler = FakeHyperliquidNavReconciler::fresh(&bot);
    let state = multi_bot_state_for_bot_with_nav_reconciler(
        "bot-token-hyperliquid-nav",
        bot,
        nav_reconciler.clone(),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-hyperliquid-nav")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();

    assert_eq!(json["source"], "hyperliquid_nav");
    assert_eq!(json["total_value_usd"], "1000");
    assert_eq!(json["cash_balance"], "500");
    assert_eq!(json["has_unpriced_positions"], false);
    assert_eq!(json["has_value_only_positions"], true);
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["token"], "USDC");
    assert_eq!(positions[0]["amount"], "500");
    assert_eq!(positions[0]["value_usd"], "500");
    assert_eq!(positions[0]["current_price"], "1");
    assert_eq!(positions[0]["protocol"], "hyperevm_vault");
    assert_eq!(positions[0]["position_type"], "spot");
    assert_eq!(positions[0]["valuation_status"], "value_only");
    assert_eq!(nav_reconciler.calls(), 1);
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_seeds_initial_paper_capital() {
    let state = multi_bot_state_with_strategy_config(
        "http://localhost:1234",
        serde_json::json!({
            "asset_token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "initial_capital_usd": "10000"
        }),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();

    assert_eq!(json["total_value_usd"], "10000");
    assert_eq!(json["cash_balance"], "10000");
    assert_eq!(json["warnings"], serde_json::json!([]));
    assert_eq!(json["has_unpriced_positions"], false);
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["token"], "USDC");
    assert_eq!(positions[0]["amount"], "10000");
    assert_eq!(positions[0]["value_usd"], "10000");
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_ignores_zero_address_paper_asset_token() {
    let state = multi_bot_state_with_strategy_config(
        "http://localhost:1234",
        serde_json::json!({
            "asset_token": "0x0000000000000000000000000000000000000000",
            "initial_capital_usd": "10000"
        }),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();

    assert_eq!(json["total_value_usd"], "10000");
    assert_eq!(json["cash_balance"], "10000");
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0]["token"], "USDC");
    assert_eq!(positions[0]["value_usd"], "10000");
}

#[tokio::test]
async fn test_multi_bot_portfolio_state_derives_cash_balance_from_synthetic_positions() {
    let bot_id = format!("bot-dex-cash-{}", uuid::Uuid::new_v4());
    trading_http_api::trade_store::record_trade(trading_http_api::trade_store::TradeRecord {
        id: format!("trade-dex-cash-{}", uuid::Uuid::new_v4()),
        bot_id: bot_id.clone(),
        timestamp: chrono::Utc::now(),
        action: "swap".to_string(),
        token_in: "USDC".to_string(),
        token_out: "WETH".to_string(),
        amount_in: "1000".to_string(),
        min_amount_out: "0.5".to_string(),
        target_protocol: "uniswap_v3".to_string(),
        tx_hash: "0xsynthetic-cash".to_string(),
        block_number: None,
        gas_used: None,
        paper_trade: true,
        execution_status: Some(trading_http_api::trade_store::TradeExecutionStatus::Paper),
        clob_order_id: None,
        amount_out: Some("0.5".to_string()),
        entry_price_usd: Some("2000".to_string()),
        notional_usd: Some("1000".to_string()),
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
            intent_hash: "0xintent-dex-cash".to_string(),
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
        candidate_hash: None,
        revision_id: None,
        paper_pnl_pct: None,
        paper_equity_after: None,
    })
    .await
    .expect("record trade");

    let state = multi_bot_state_with_strategy_config_and_bot(
        "http://localhost:1234",
        "bot-token-dex-cash",
        &bot_id,
        31337,
        serde_json::json!({
            "asset_token": "USDC",
            "initial_capital_usd": "10000"
        }),
    );
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/portfolio/state")
                .header("authorization", "Bearer bot-token-dex-cash")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let positions = json["positions"].as_array().unwrap();
    assert_eq!(json["cash_balance"], "9000");
    assert_eq!(json["has_value_only_positions"], true);
    assert_eq!(positions.len(), 2);
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
            "intent_hash": format!("0x{}", uuid::Uuid::new_v4().to_string().replace('-', "")),
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
    assert!(
        body_str.contains("Validation not approved"),
        "Expected 'Validation not approved', got: {body_str}"
    );
}

#[tokio::test]
async fn test_multi_bot_execute_rejects_paper_trade_with_no_usable_signatures() {
    let state = multi_bot_state_for_bot(
        "paper-execute-token",
        BotContext {
            bot_id: "bot-paper-execute".to_string(),
            vault_address: "factory:0x1111111111111111111111111111111111111111".to_string(),
            paper_trade: true,
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            validator_endpoints: vec!["http://validator-1".to_string()],
            validation_trust: trading_runtime::ValidationTrust::PerTrade,
        },
    );
    let app = build_multi_bot_router(state);

    let contradictory_body = serde_json::to_string(&serde_json::json!({
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
            "intent_hash": format!("0x{}", uuid::Uuid::new_v4().to_string().replace('-', "")),
            "validator_responses": [
                {
                    "validator": "0xValidator1",
                    "score": 90,
                    "reasoning": "Score passed; signature error: invalid vault_address",
                    "signature": format!("0x{}", "00".repeat(65))
                },
                {
                    "validator": "0xValidator2",
                    "score": 80,
                    "reasoning": "Score passed; signature error: invalid vault_address",
                    "signature": format!("0x{}", "00".repeat(65))
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
                .header("authorization", "Bearer paper-execute-token")
                .header("content-type", "application/json")
                .body(Body::from(contradictory_body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(
        body_str.contains("requires at least one usable validator signature"),
        "Expected paper-signature consistency error, got: {body_str}"
    );
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
            "intent_hash": format!("0x{}", uuid::Uuid::new_v4().to_string().replace('-', "")),
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
    assert!(
        body_str.contains("Unknown action"),
        "Expected 'Unknown action' error, got: {body_str}"
    );
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
                    vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                    paper_trade: false,
                    chain_id: 31337,
                    rpc_url: "http://localhost:8545".to_string(),
                    strategy_config: serde_json::json!({}),
                    risk_params: serde_json::json!({}),
                    validator_endpoints: validator_uris.clone(),
                    validation_trust: trading_runtime::ValidationTrust::PerTrade,
                })
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: None,
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    })
}

fn validate_body() -> String {
    serde_json::to_string(&serde_json::json!({
        "strategy_id": "test-strat",
        "action": "open_long",
        "token_in": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "token_out": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "amount_in": "1.5",
        "min_amount_out": "3000",
        "target_protocol": "hyperliquid"
    }))
    .unwrap()
}

async fn multi_bot_hyperliquid_validator_state(
    validator_uris: Vec<String>,
) -> (Arc<MultiBotTradingState>, MockServer) {
    let rpc_mock = MockServer::start().await;
    let mut bot = live_bot_with_trust("bot-validators", trading_runtime::ValidationTrust::PerTrade);
    bot.rpc_url = rpc_mock.uri();
    bot.validator_endpoints = validator_uris;
    mock_hyperliquid_normal_mode(&rpc_mock, &bot).await;
    (multi_bot_state_for_bot("bot-token-abc", bot), rpc_mock)
}

#[tokio::test]
async fn test_multi_bot_validate_live_vault_trade_requires_simulation() {
    let state = multi_bot_state_with_validators(vec![]);
    let app = build_multi_bot_router(state);
    let body = serde_json::to_string(&serde_json::json!({
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
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 502);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(
        body_str.contains("Vault asset lookup failed for valuation check"),
        "Expected vault valuation guard error, got: {body_str}"
    );
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
            "signature": TEST_SIG,
            "reasoning": "Reasonable risk-reward ratio",
            "validator": "0xValidator1"
        })))
        .mount(&v1)
        .await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 90,
            "signature": TEST_SIG,
            "reasoning": "Strong market signal with low volatility",
            "validator": "0xValidator2"
        })))
        .mount(&v2)
        .await;

    let (state, _rpc_mock) = multi_bot_hyperliquid_validator_state(vec![v1.uri(), v2.uri()]).await;
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
    assert_eq!(
        responses.len(),
        2,
        "Expected 2 validator responses, got {}",
        responses.len()
    );

    // Both validators should be present (order may vary)
    let validators: Vec<&str> = responses
        .iter()
        .map(|r| r["validator"].as_str().unwrap())
        .collect();
    assert!(
        validators.contains(&"0xValidator1"),
        "Missing 0xValidator1 in {validators:?}"
    );
    assert!(
        validators.contains(&"0xValidator2"),
        "Missing 0xValidator2 in {validators:?}"
    );

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
            "signature": TEST_SIG,
            "reasoning": "Extreme volatility detected",
            "validator": "0xValidator1"
        })))
        .mount(&v1)
        .await;

    Mock::given(method("POST"))
        .and(path("/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "score": 30,
            "signature": TEST_SIG,
            "reasoning": "Insufficient liquidity for this trade size",
            "validator": "0xValidator2"
        })))
        .mount(&v2)
        .await;

    let (state, _rpc_mock) = multi_bot_hyperliquid_validator_state(vec![v1.uri(), v2.uri()]).await;
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
            "signature": TEST_SIG,
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

    let (state, _rpc_mock) =
        multi_bot_hyperliquid_validator_state(vec![v_ok.uri(), v_fail.uri()]).await;
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

    let (state, _rpc_mock) = multi_bot_hyperliquid_validator_state(vec![v1.uri(), v2.uri()]).await;
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
    use trading_runtime::{Position, PositionType, ValuationStatus};

    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;

    // Pre-populate the portfolio with two positions before building the router.
    {
        let mut portfolio = state.portfolio.write().await;
        portfolio.positions.push(Position {
            token: "WETH".to_string(),
            amount: Decimal::new(15, 1),                // 1.5
            entry_price: Some(Decimal::new(2400, 0)),   // 2400
            current_price: Some(Decimal::new(2500, 0)), // 2500
            unrealized_pnl: Some(Decimal::new(150, 0)), // +150
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
            valuation_status: ValuationStatus::Priced,
        });
        portfolio.positions.push(Position {
            token: "USDC".to_string(),
            amount: Decimal::new(5000, 0),            // 5000
            entry_price: Some(Decimal::new(1, 0)),    // 1.0
            current_price: Some(Decimal::new(1, 0)),  // 1.0
            unrealized_pnl: Some(Decimal::new(0, 0)), // 0
            protocol: "aave_v3".to_string(),
            position_type: PositionType::Lending,
            valuation_status: ValuationStatus::Priced,
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
    assert_eq!(
        positions.len(),
        2,
        "Expected 2 positions, got {}",
        positions.len()
    );

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
    use trading_runtime::{Position, PositionType, ValuationStatus};

    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;

    // Portfolio with a losing position
    {
        let mut portfolio = state.portfolio.write().await;
        portfolio.positions.push(Position {
            token: "WETH".to_string(),
            amount: Decimal::new(2, 0),                   // 2.0 ETH
            entry_price: Some(Decimal::new(3000, 0)),     // bought at 3000
            current_price: Some(Decimal::new(2200, 0)),   // now at 2200
            unrealized_pnl: Some(Decimal::new(-1600, 0)), // -1600 loss
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
            valuation_status: ValuationStatus::Priced,
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

#[tokio::test]
async fn test_portfolio_state_recovers_unpriced_position_as_value_only() {
    use rust_decimal::Decimal;
    use trading_runtime::{Position, PositionType, ValuationStatus};

    let mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/price/WETH"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "price": 2500.0,
            "symbol": "WETH"
        })))
        .mount(&mock)
        .await;

    let state = test_state(&mock.uri()).await;
    {
        let mut portfolio = state.portfolio.write().await;
        portfolio.positions.push(Position {
            token: "WETH".to_string(),
            amount: Decimal::new(15, 1),
            entry_price: None,
            current_price: None,
            unrealized_pnl: None,
            protocol: "uniswap_v3".to_string(),
            position_type: PositionType::Spot,
            valuation_status: ValuationStatus::Unpriced,
        });
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

    assert_eq!(json["total_value_usd"], "3750.0");
    assert_eq!(json["has_unpriced_positions"], false);
    assert_eq!(json["has_value_only_positions"], true);
    assert_eq!(
        json["warnings"][0],
        "Some positions have current market value, but entry price or PnL are unavailable."
    );

    let positions = json["positions"].as_array().unwrap();
    assert_eq!(positions.len(), 1);
    let weth = &positions[0];
    assert_eq!(weth["valuation_status"], "value_only");
    assert_eq!(weth["value_usd"], "3750.0");
    assert_eq!(weth["current_price"], "2500");
    assert!(weth.get("entry_price").is_none());
    assert!(weth.get("unrealized_pnl").is_none());
}

// ── Polymarket CLOB integration tests ────────────────────────────────────────

/// Single-bot live CLOB execution must enforce the configured validator score
/// threshold before submitting any direct exchange order.
#[tokio::test]
async fn test_single_bot_live_clob_rejects_below_threshold_validation() {
    ensure_state_dir();

    let market_mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/order"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "orderID": "clob-order-should-not-submit",
            "status": "LIVE",
            "success": true,
            "errorMsg": null,
            "makingAmount": "100",
            "takingAmount": "65",
            "transactionHashes": [],
            "tradeIds": []
        })))
        .mount(&clob_mock)
        .await;

    let mut state = test_state_with_clob(&market_mock.uri(), &clob_mock.uri()).await;
    Arc::get_mut(&mut state)
        .expect("test state should have a single owner")
        .chain_id = Some(137);
    let app = build_router(state);

    let mut execute_body = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "0x0000000000000000000000000000000000000000",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.65,
                "order_type": "GTC"
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 49,
            "validator_responses": []
        }
    });
    attach_signed_validation(
        &mut execute_body,
        137,
        "0x0000000000000000000000000000000000000001",
        ACTION_KIND_CLOB_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&execute_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains("below required"), "unexpected body: {body}");

    let order_requests = clob_mock
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.method.as_str() == "POST" && request.url.path() == "/order")
        .count();
    assert_eq!(order_requests, 0, "CLOB order should not be submitted");
}

/// Multi-bot execute with target_protocol="polymarket_clob" routes through the
/// ClobClient instead of vault.execute(). Uses a mock CLOB server.
#[tokio::test]
async fn test_multi_bot_clob_execute() {
    ensure_state_dir();

    // Mock CLOB server: order endpoint only (credentials pre-supplied, caches pre-populated)
    let clob_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, true).await;
    let rpc_mock_uri = rpc_mock.uri();

    Mock::given(method("POST"))
        .and(path("/order"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "orderID": "clob-order-12345",
            "status": "LIVE",
            "success": true,
            "errorMsg": null,
            "makingAmount": "100",
            "takingAmount": "65",
            "transactionHashes": [],
            "tradeIds": []
        })))
        .mount(&clob_mock)
        .await;

    Mock::given(method("GET"))
        .and(path("/data/orders"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [],
            "next_cursor": "LTE=",
            "limit": 50,
            "count": 0
        })))
        .mount(&clob_mock)
        .await;

    // Create ClobClient with pre-supplied credentials (skips L1 auth)
    use trading_runtime::polymarket_clob::ClobClient;
    let clob_client = ClobClient::with_config(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        clob_mock.uri(),
        Some(ClobClient::test_credentials()),
    )
    .expect("clob client");

    // Pre-populate SDK caches to avoid HTTP lookups during order building
    clob_client
        .configure_token_cache("48328953829", "0.01", false, 0)
        .await
        .unwrap();

    let state = Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            if token == "bot-token-abc" {
                Some(BotContext {
                    bot_id: "bot-clob".to_string(),
                    vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                    paper_trade: false,
                    chain_id: 137,
                    rpc_url: rpc_mock_uri.clone(),
                    strategy_config: serde_json::json!({}),
                    risk_params: serde_json::json!({}),
                    validator_endpoints: vec![],
                    validation_trust: trading_runtime::ValidationTrust::PerTrade,
                })
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: Some(Arc::new(clob_client)),
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    });

    let app = build_multi_bot_router(state);

    let mut execute_body = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "0x0000000000000000000000000000000000000000",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.65,
                "order_type": "GTC"
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 75,
            "validator_responses": []
        }
    });
    attach_signed_validation(
        &mut execute_body,
        137,
        "0x0000000000000000000000000000000000000001",
        ACTION_KIND_CLOB_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&execute_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200, "CLOB execute should succeed");

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // tx_hash has clob: prefix
    let tx_hash = json["tx_hash"].as_str().unwrap();
    assert!(
        tx_hash.starts_with("clob:"),
        "Expected clob: prefix, got {tx_hash}"
    );

    // clob_order_id is populated
    assert_eq!(json["clob_order_id"], "clob-order-12345");

    // Not a paper trade, no block number
    assert_eq!(json["paper_trade"], false);
    assert!(json["block_number"].is_null());
}

#[tokio::test]
async fn test_multi_bot_clob_execute_rejects_onchain_validator_denial() {
    ensure_state_dir();

    let clob_mock = MockServer::start().await;
    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, false).await;
    let rpc_mock_uri = rpc_mock.uri();

    Mock::given(method("POST"))
        .and(path("/order"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "orderID": "should-not-submit",
            "status": "LIVE",
            "success": true
        })))
        .expect(0)
        .mount(&clob_mock)
        .await;

    let clob_client = trading_runtime::polymarket_clob::ClobClient::with_config(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        clob_mock.uri(),
        Some(trading_runtime::polymarket_clob::ClobClient::test_credentials()),
    )
    .expect("clob client");
    clob_client
        .configure_token_cache("48328953829", "0.01", false, 0)
        .await
        .unwrap();

    let state = Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            if token == "bot-token-denied" {
                Some(BotContext {
                    bot_id: "bot-clob-denied".to_string(),
                    vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                    paper_trade: false,
                    chain_id: 137,
                    rpc_url: rpc_mock_uri.clone(),
                    strategy_config: serde_json::json!({}),
                    risk_params: serde_json::json!({}),
                    validator_endpoints: vec![],
                    validation_trust: trading_runtime::ValidationTrust::PerTrade,
                })
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: Some(Arc::new(clob_client)),
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    });
    let app = build_multi_bot_router(state);

    let mut execute_body = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat-denied",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "0x0000000000000000000000000000000000000000",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.65,
                "order_type": "GTC"
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 75,
            "validator_responses": []
        }
    });
    attach_signed_validation(
        &mut execute_body,
        137,
        "0x0000000000000000000000000000000000000001",
        ACTION_KIND_CLOB_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-denied")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&execute_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 401, "{}", String::from_utf8_lossy(&body));
}

/// Execute with polymarket_clob but no ClobClient configured → 503.
#[tokio::test]
async fn test_multi_bot_clob_execute_not_configured() {
    ensure_state_dir();

    let rpc_mock = MockServer::start().await;
    mock_direct_validator_approval(&rpc_mock, true).await;
    let rpc_mock_uri = rpc_mock.uri();

    let state = Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(move |token: &str| {
            if token == "bot-token-abc" {
                Some(BotContext {
                    bot_id: "bot-no-clob".to_string(),
                    vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                    paper_trade: false,
                    chain_id: 137,
                    rpc_url: rpc_mock_uri.clone(),
                    strategy_config: serde_json::json!({}),
                    risk_params: serde_json::json!({}),
                    validator_endpoints: vec![],
                    validation_trust: trading_runtime::ValidationTrust::PerTrade,
                })
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: None, // not configured
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    });

    let app = build_multi_bot_router(state);

    let mut execute_body = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "0x0000000000000000000000000000000000000000",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "token_id": "48328953829",
                "price": 0.65
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 75,
            "validator_responses": []
        }
    });
    attach_signed_validation(
        &mut execute_body,
        137,
        "0x0000000000000000000000000000000000000001",
        ACTION_KIND_CLOB_ORDER,
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&execute_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        503,
        "Should be SERVICE_UNAVAILABLE when CLOB client not configured"
    );
}

/// CLOB execute with missing metadata.token_id → 400.
#[tokio::test]
async fn test_multi_bot_clob_execute_missing_metadata() {
    ensure_state_dir();

    let clob_mock = MockServer::start().await;
    let clob_client = trading_runtime::polymarket_clob::ClobClient::with_config(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        clob_mock.uri(),
        None,
    )
    .expect("clob client");

    let state = Arc::new(MultiBotTradingState {
        operator_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
            .to_string(),
        market_data_base_url: "http://localhost:1234".to_string(),
        validation_deadline_secs: 300,
        min_validator_score: 50,
        resolve_bot: Box::new(|token: &str| {
            if token == "bot-token-abc" {
                Some(BotContext {
                    bot_id: "bot-bad-meta".to_string(),
                    vault_address: "0x0000000000000000000000000000000000000001".to_string(),
                    paper_trade: false,
                    chain_id: 137,
                    rpc_url: "http://localhost:8545".to_string(),
                    strategy_config: serde_json::json!({}),
                    risk_params: serde_json::json!({}),
                    validator_endpoints: vec![],
                    validation_trust: trading_runtime::ValidationTrust::PerTrade,
                })
            } else {
                None
            }
        }),
        list_envelope_bots: None,
        alert_sink: trading_http_api::alerts::AlertSink::new(None, None),
        clob_client: Some(Arc::new(clob_client)),
        chain_client: None,
        chain_client_rpc_url: None,
        chain_client_chain_id: None,
        rate_limiter: std::sync::Arc::new(
            trading_http_api::rate_limit::PerBotRateLimiter::default(),
        ),
        key_provider: trading_runtime::cex::default_provider(),
        nav_stream_config: None,
        hyperliquid_nav_reconciler: std::sync::Arc::new(
            trading_http_api::hyperliquid_nav::DefaultHyperliquidNavReconciler,
        ),
    });

    let app = build_multi_bot_router(state);

    // Missing metadata.token_id
    let mut execute_body = serde_json::json!({
        "intent": {
            "strategy_id": "prediction-strat",
            "action": "buy",
            "token_in": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "token_out": "0x0000000000000000000000000000000000000000",
            "amount_in": "100.0",
            "min_amount_out": "0",
            "target_protocol": "polymarket_clob",
            "metadata": {
                "price": 0.65
            }
        },
        "validation": {
            "approved": true,
            "aggregate_score": 75,
            "validator_responses": []
        }
    });
    attach_validation_hashes(&mut execute_body, Some(137));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&execute_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        400,
        "Should be BAD_REQUEST when token_id missing"
    );
}

// ── CLOB route tests ─────────────────────────────────────────────────────────

/// Create a test state with CLOB client configured against a wiremock server.
async fn test_state_with_clob(mock_uri: &str, clob_mock_uri: &str) -> Arc<TradingApiState> {
    use trading_runtime::polymarket_clob::ClobClient;

    ensure_state_dir();

    let clob_client = ClobClient::with_config(
        "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        clob_mock_uri.to_string(),
        Some(ClobClient::test_credentials()),
    )
    .expect("clob client");

    Arc::new(TradingApiState {
        market_client: MarketDataClient::new(mock_uri.to_string()),
        validator_client: ValidatorClient::new(vec![], 50),
        min_validator_score: 50,
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
        bot_id: format!("test-bot-{}", uuid::Uuid::new_v4()),
        paper_trade: false,
        operator_address: String::new(),
        submitter_address: String::new(),
        sidecar_url: String::new(),
        sidecar_token: String::new(),
        rpc_url: None,
        chain_id: None,
        clob_client: Some(Arc::new(clob_client)),
        strategy_config: serde_json::Value::Null,
    })
}

#[tokio::test]
async fn test_clob_config_endpoint() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;

    // Mock the auth derive endpoint (CLOB client needs this for initial auth).
    Mock::given(method("GET"))
        .and(path("/auth/derive-api-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "apiKey": "00000000-0000-0000-0000-000000000000",
            "secret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "passphrase": "test-passphrase"
        })))
        .mount(&clob_mock)
        .await;

    let state = test_state_with_clob(&mock.uri(), &clob_mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/clob/config")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // Verify Polygon mainnet contract addresses.
    assert_eq!(
        json["exchange"],
        "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
    );
    assert_eq!(
        json["collateral"],
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
    );
    assert!(json["neg_risk_exchange"].is_string());
    assert!(json["neg_risk_adapter"].is_string());
}

#[tokio::test]
async fn test_clob_not_configured_returns_503() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // All CLOB routes should return 503 when clob_client is None.
    for path in &[
        "/clob/config",
        "/clob/orders",
        "/clob/midpoint?token_id=123",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(*path)
                    .header("authorization", auth_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            503,
            "{path} should return 503 when CLOB not configured"
        );
    }
}

#[tokio::test]
async fn test_clob_get_order() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;

    // Mock /data/order/{id}
    // SDK uses ts_seconds for created_at (integer) and TimestampSeconds<String>
    // for expiration (string).
    Mock::given(method("GET"))
        .and(path("/data/order/order-abc-123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "order-abc-123",
            "status": "LIVE",
            "owner": "00000000-0000-0000-0000-000000000000",
            "maker_address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            "market": "0x0000000000000000000000000000000000000000000000000000000000000abc",
            "asset_id": "12345",
            "side": "BUY",
            "original_size": "100.0",
            "size_matched": "25.0",
            "price": "0.65",
            "associate_trades": [],
            "outcome": "Yes",
            "created_at": 1740000000,
            "expiration": "1750000000",
            "order_type": "GTC"
        })))
        .mount(&clob_mock)
        .await;

    let state = test_state_with_clob(&mock.uri(), &clob_mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/clob/order?order_id=order-abc-123")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["id"], "order-abc-123");
    assert_eq!(json["status"], "LIVE");
    assert_eq!(json["price"], "0.65");
    assert_eq!(json["size_matched"], "25.0");
}

#[tokio::test]
async fn test_clob_get_open_orders() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/data/orders"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [
                {
                    "id": "order-1",
                    "status": "LIVE",
                    "owner": "00000000-0000-0000-0000-000000000000",
                    "maker_address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                    "market": "0x0000000000000000000000000000000000000000000000000000000000000abc",
                    "asset_id": "12345",
                    "side": "BUY",
                    "original_size": "100.0",
                    "size_matched": "0",
                    "price": "0.50",
                    "associate_trades": [],
                    "outcome": "Yes",
                    "created_at": 1740000000,
                    "expiration": "1750000000",
                    "order_type": "GTC"
                }
            ],
            "next_cursor": "LTE=",
            "limit": 50,
            "count": 1
        })))
        .mount(&clob_mock)
        .await;

    let state = test_state_with_clob(&mock.uri(), &clob_mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/clob/orders")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let orders: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();

    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0]["id"], "order-1");
    assert_eq!(orders[0]["price"], "0.50");
}

#[tokio::test]
async fn test_clob_get_midpoint() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/midpoint"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "mid": "0.6500"
        })))
        .mount(&clob_mock)
        .await;

    let state = test_state_with_clob(&mock.uri(), &clob_mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/clob/midpoint?token_id=48328953829")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["token_id"], "48328953829");
    assert_eq!(json["midpoint"], "0.6500");
}

#[tokio::test]
async fn test_clob_get_book() {
    let mock = MockServer::start().await;
    let clob_mock = MockServer::start().await;

    // SDK's OrderBookSummaryResponse requires: market (B256), asset_id (U256),
    // timestamp (millisecond string), min_order_size, neg_risk, tick_size.
    Mock::given(method("GET"))
        .and(path("/book"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "market": "0x0000000000000000000000000000000000000000000000000000000000000abc",
            "asset_id": "48328953829",
            "bids": [
                {"price": "0.64", "size": "500.0"},
                {"price": "0.63", "size": "300.0"}
            ],
            "asks": [
                {"price": "0.66", "size": "400.0"},
                {"price": "0.67", "size": "200.0"}
            ],
            "timestamp": "1740000000000",
            "min_order_size": "1.0",
            "neg_risk": false,
            "tick_size": "0.01"
        })))
        .mount(&clob_mock)
        .await;

    let state = test_state_with_clob(&mock.uri(), &clob_mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/clob/book?token_id=48328953829")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["bids"].as_array().unwrap().len(), 2);
    assert_eq!(json["asks"].as_array().unwrap().len(), 2);
    assert_eq!(json["bids"][0]["price"], "0.64");
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLLATERAL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_collateral_status_default() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    // GET /collateral/status — no RPC configured in test state, should return 503
    let response = app
        .oneshot(
            Request::builder()
                .uri("/collateral/status")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Test state has no rpc_url → 503 Service Unavailable
    assert_eq!(response.status(), 503);
}

#[tokio::test]
async fn test_collateral_release_requires_auth() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/collateral/release")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn test_collateral_return_requires_auth() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/collateral/return")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 401);
}

// ── Backtest API integration tests ──────────────────────────────────────────

fn backtest_candles() -> serde_json::Value {
    // 30 candles: downtrend (RSI drops) then uptrend (recovery)
    let mut candles = Vec::new();
    for i in 0..15 {
        let base = 100.0 - i as f64 * 2.0;
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": base,
            "high": base + 1.5,
            "low": base - 1.0,
            "close": base - 0.5,
            "volume": 1000000
        }));
    }
    for i in 0..15 {
        let base = 72.0 + i as f64 * 2.0;
        candles.push(serde_json::json!({
            "timestamp": (15 + i) * 3600,
            "token": "ETH",
            "open": base,
            "high": base + 1.5,
            "low": base - 0.5,
            "close": base + 1.0,
            "volume": 1000000
        }));
    }
    serde_json::Value::Array(candles)
}

fn backtest_config() -> serde_json::Value {
    serde_json::json!({
        "initial_capital": "10000",
        "harness": {
            "version": 1,
            "entry_rules": [{
                "signal": {"type": "rsi", "period": 5},
                "condition": {"type": "below", "threshold": 40.0},
                "weight": 1.0,
                "tokens": []
            }],
            "exit_rules": [
                {"type": "take_profit", "pct": 10.0},
                {"type": "stop_loss", "pct": 8.0}
            ],
            "filters": [],
            "position_sizing": {"method": "fixed_fraction", "fraction": 0.3},
            "entry_threshold": 0.3,
            "max_positions": 3
        },
        "slippage": {"model": "fixed_bps", "bps": 5},
        "gas_cost_usd": "1",
        "taker_fee_bps": 5
    })
}

async fn record_evolution_candles(app: &Router, auth_token: &str) {
    let mut candles = Vec::new();
    for i in 0..60 {
        let base = if i < 30 {
            120.0 - i as f64
        } else {
            90.0 + (i - 30) as f64 * 1.2
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.0),
            "low": format!("{:.2}", base - 0.5),
            "close": format!("{:.2}", base + 0.4),
            "volume": "100000"
        }));
    }

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", format!("Bearer {auth_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

async fn create_sandbox_revision(
    app: &Router,
    auth_token: &str,
    parent_revision_id: Option<&str>,
) -> String {
    let snapshot_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/snapshot")
                .header("authorization", format!("Bearer {auth_token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_repo": "https://github.com/tangle-network/ai-trading-blueprint",
                        "base_ref": "linh/feat/hype-perp",
                        "base_commit": "rev0",
                        "base_image_digest": "sha256:image",
                        "workspace_digest": "sha256:workspace"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot_resp.status(), 200);
    let bytes = snapshot_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let snapshot_id = snapshot["snapshot_id"].as_str().unwrap();

    let mut body = serde_json::json!({
        "user_intent": "Create exact revision-scoped paper evidence candidate.",
        "base_snapshot_id": snapshot_id,
        "patch": "diff --git a/strategy.rs b/strategy.rs\n+// revision-scoped evidence\n",
        "files_changed": ["strategy.rs"],
        "tests": ["cargo test -p trading-runtime --lib"],
        "status": "candidate"
    });
    if let Some(parent_revision_id) = parent_revision_id {
        body["parent_revision_id"] = serde_json::Value::String(parent_revision_id.to_string());
    }

    let revision_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/revisions")
                .header("authorization", format!("Bearer {auth_token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revision_resp.status(), 200);
    let bytes = revision_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let revision: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    revision["revision_id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn test_backtest_run_returns_trades_and_stats() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let body = serde_json::json!({
        "config": backtest_config(),
        "candles": backtest_candles(),
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/run")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Verify response structure
    let result = &json["result"];
    assert!(result["candles_processed"].as_u64().unwrap() > 0);
    assert!(!result["equity_curve"].as_array().unwrap().is_empty());
    assert!(result["stats"].is_object());
    assert!(result["stats"]["sharpe_ratio"].is_number());
    assert!(result["stats"]["max_drawdown_pct"].is_number());
    assert!(result["stats"]["win_rate"].is_number());
    assert!(
        result["tokens_traded"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("ETH"))
    );
}

#[tokio::test]
async fn test_backtest_run_rejects_empty_candles() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let body = serde_json::json!({
        "config": backtest_config(),
        "candles": [],
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/run")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn test_backtest_compare_returns_promotion_decision() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let mut candidate_config = backtest_config();
    // Modify candidate: wider stops
    candidate_config["harness"]["exit_rules"] = serde_json::json!([
        {"type": "take_profit", "pct": 15.0},
        {"type": "stop_loss", "pct": 12.0}
    ]);

    let body = serde_json::json!({
        "current": backtest_config(),
        "candidate": candidate_config,
        "candles": backtest_candles(),
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/compare")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Verify comparison structure
    assert!(json["should_promote"].is_boolean());
    assert!(json["comparison"]["sharpe_delta"].is_number());
    assert!(json["comparison"]["drawdown_delta"].is_number());
    assert!(json["comparison"]["win_rate_delta"].is_number());
    assert!(json["comparison"]["current"]["stats"].is_object());
    assert!(json["comparison"]["candidate"]["stats"].is_object());
}

#[tokio::test]
async fn test_backtest_run_with_sqrt_impact_slippage() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let mut config = backtest_config();
    config["slippage"] = serde_json::json!({
        "model": "sqrt_impact",
        "base_bps": 10,
        "depth_usd": "100000"
    });

    let body = serde_json::json!({
        "config": config,
        "candles": backtest_candles(),
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/run")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(json["result"]["candles_processed"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn test_backtest_compare_rejects_empty_candles() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let body = serde_json::json!({
        "current": backtest_config(),
        "candidate": backtest_config(),
        "candles": [],
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/compare")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn test_backtest_walk_forward_returns_split_results() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let mut candidate = backtest_config();
    candidate["harness"]["exit_rules"] = serde_json::json!([
        {"type": "take_profit", "pct": 12.0},
        {"type": "stop_loss", "pct": 7.0}
    ]);

    let body = serde_json::json!({
        "current": backtest_config(),
        "candidate": candidate,
        "candles": backtest_candles(),
        "train_pct": 0.7
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/walk-forward")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    let result = &json["result"];
    assert!(result["should_promote"].is_boolean());
    assert!(result["train_candles"].as_u64().unwrap() > 0);
    assert!(result["test_candles"].as_u64().unwrap() > 0);
    assert!(result["train"]["current"]["stats"].is_object());
    assert!(result["test"]["candidate"]["stats"].is_object());
}

// ── Candle store integration tests ──────────────────────────────────────

#[tokio::test]
async fn test_candle_store_record_and_query() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let body = serde_json::json!({
        "candles": [
            {"timestamp": 1000, "token": "ETH", "open": "2500", "high": "2520", "low": "2490", "close": "2510", "volume": "50000"},
            {"timestamp": 2000, "token": "ETH", "open": "2510", "high": "2530", "low": "2500", "close": "2525", "volume": "45000"},
            {"timestamp": 1000, "token": "BTC", "open": "40000", "high": "40500", "low": "39800", "close": "40200", "volume": "30000"}
        ]
    });

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["recorded"].as_u64().unwrap(), 3);

    // Query candles for ETH
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/market-data/candles?token=ETH")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let candles = json["candles"].as_array().unwrap();
    // May see candles from other tests sharing the same store, so check >= 2
    assert!(candles.len() >= 2, "Should return at least 2 ETH candles");
}

#[tokio::test]
async fn test_candle_store_rejects_empty_batch() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let body = serde_json::json!({"candles": []});
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
}

// ── Evolution integration tests ────────────────────────────────────────

#[tokio::test]
async fn test_evolution_status_returns_bot_info() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let bot_id = state.bot_id.clone();
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/status")
                .header("authorization", auth_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["bot_id"], bot_id);
}

#[tokio::test]
async fn test_evolution_run_rejects_insufficient_candles() {
    let mock = MockServer::start().await;
    let evo_bot_id = format!("evo-test-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &evo_bot_id).await;
    let app = build_router(state);

    let body = serde_json::json!({
        "current": backtest_config(),
        "candidate": backtest_config(),
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/run")
                .header("authorization", format!("Bearer {evo_bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 400);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("Not enough candle history"));
}

#[tokio::test]
async fn test_evolution_full_cycle_record_then_evolve() {
    let mock = MockServer::start().await;
    let bot_id = format!("evo-cycle-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    // Step 1: Record 50 candles
    let mut candles = Vec::new();
    for i in 0..50 {
        let base = if i < 25 {
            100.0 - i as f64 * 1.5
        } else {
            65.0 + (i - 25) as f64 * 1.5
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.0),
            "low": format!("{:.2}", base - 0.5),
            "close": format!("{:.2}", base + 0.5),
            "volume": "100000"
        }));
    }

    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    // Step 2: Run evolution
    let mut candidate = backtest_config();
    candidate["harness"]["exit_rules"] = serde_json::json!([
        {"type": "take_profit", "pct": 12.0},
        {"type": "stop_loss", "pct": 6.0}
    ]);

    let evo_body = serde_json::json!({
        "current": backtest_config(),
        "candidate": candidate,
        "token": "ETH",
        "train_pct": 0.7
    });

    let evo_resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/run")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&evo_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(evo_resp.status(), 200);
    let bytes = evo_resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(json["candles_used"].as_u64().unwrap() >= 50);
    assert!(json["result"]["should_promote"].is_boolean());
    assert!(json["result"]["train_candles"].as_u64().unwrap() > 0);
    assert!(json["result"]["test_candles"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn test_evolution_promotion_gate_blocks_without_real_paper_evidence() {
    let mock = MockServer::start().await;
    let bot_id = format!("evo-gate-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let mut candles = Vec::new();
    for i in 0..60 {
        let base = if i < 30 {
            120.0 - i as f64
        } else {
            90.0 + (i - 30) as f64 * 1.2
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.0),
            "low": format!("{:.2}", base - 0.5),
            "close": format!("{:.2}", base + 0.4),
            "volume": "100000"
        }));
    }

    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    let mut candidate = backtest_config();
    candidate["harness"]["position_sizing"] =
        serde_json::json!({"method": "fixed_fraction", "fraction": 0.35});

    let gate_body = serde_json::json!({
        "current": backtest_config(),
        "candidate": candidate,
        "token": "ETH",
        "train_pct": 0.7
    });

    let gate_resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/promotion-gate")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&gate_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = gate_resp.status();
    let bytes = gate_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["approved"], false);
    assert!(json["candles_used"].as_u64().unwrap() >= 60);
    assert!(json["blockers"].as_array().unwrap().iter().any(|b| {
        b.as_str()
            .unwrap()
            .contains("missing persisted paper trading evidence")
    }));
}

#[tokio::test]
async fn test_evolution_promotion_gate_ignores_forged_request_paper_evidence() {
    let mock = MockServer::start().await;
    let bot_id = format!("evo-gate-paper-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let mut candles = Vec::new();
    for i in 0..60 {
        let base = if i < 30 {
            120.0 - i as f64
        } else {
            90.0 + (i - 30) as f64 * 1.2
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.0),
            "low": format!("{:.2}", base - 0.5),
            "close": format!("{:.2}", base + 0.4),
            "volume": "100000"
        }));
    }
    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    let gate_body = serde_json::json!({
        "current": backtest_config(),
        "candidate": backtest_config(),
        "token": "ETH",
        "paper": {
            "trades": 999,
            "total_return_pct": 50.0,
            "max_drawdown_pct": 0.1,
            "candidate_hash": "sha256:forged"
        },
        "min_paper_trades": 20,
        "max_paper_drawdown_pct": 10.0
    });

    let gate_resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/promotion-gate")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&gate_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = gate_resp.status();
    let bytes = gate_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["approved"], false);
    assert_eq!(json["paper"], serde_json::Value::Null);
    let blockers = json["blockers"].as_array().unwrap();
    assert!(
        blockers
            .iter()
            .any(|b| b.as_str().unwrap().contains("missing persisted paper"))
    );
}

#[tokio::test]
async fn test_evolution_promotion_gate_derives_paper_evidence_from_persisted_candidate_trades() {
    let mock = MockServer::start().await;
    let bot_id = format!("evo-gate-persisted-paper-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let mut candles = Vec::new();
    for i in 0..60 {
        let base = if i < 30 {
            120.0 - i as f64
        } else {
            90.0 + (i - 30) as f64 * 1.2
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.0),
            "low": format!("{:.2}", base - 0.5),
            "close": format!("{:.2}", base + 0.4),
            "volume": "100000"
        }));
    }
    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    let candidate = backtest_config();
    let probe_body = serde_json::json!({
        "user_intent": "Probe exact candidate hash before persisted paper evidence exists.",
        "current": backtest_config(),
        "candidate": candidate,
        "token": "ETH",
        "train_pct": 0.7
    });
    let probe_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/self-improve")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&probe_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = probe_resp.status();
    let bytes = probe_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let probe_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let candidate_hash = probe_json["run"]["candidate_hash"]
        .as_str()
        .unwrap()
        .to_string();
    let snapshot_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/snapshot")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_repo": "https://github.com/tangle-network/ai-trading-blueprint",
                        "base_ref": "linh/feat/hype-perp",
                        "base_commit": "rev0",
                        "base_image_digest": "sha256:image",
                        "workspace_digest": "sha256:workspace"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot_resp.status(), 200);
    let bytes = snapshot_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let snapshot_id = snapshot["snapshot_id"].as_str().unwrap();

    let revision_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/revisions")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "user_intent": "Create exact revision-scoped paper evidence candidate.",
                        "base_snapshot_id": snapshot_id,
                        "patch": "diff --git a/strategy.rs b/strategy.rs\n+// revision-scoped evidence\n",
                        "files_changed": ["strategy.rs"],
                        "tests": ["cargo test -p trading-runtime --lib"],
                        "status": "candidate"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revision_resp.status(), 200);
    let bytes = revision_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let revision: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let revision_id = revision["revision_id"].as_str().unwrap().to_string();

    for i in 0..20 {
        let exec_body = execute_body_with_metadata(serde_json::json!({
            "test_nonce": uuid::Uuid::new_v4().to_string(),
            "candidate_hash": "sha256:intentionally-wrong",
            "revision_id": revision_id,
            "paper_pnl_pct": "0.1",
            "paper_equity_after": format!("{:.2}", 10_000.0 + (i as f64 * 10.0))
        }));
        let exec_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/execute")
                    .header("authorization", &format!("Bearer {bot_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(exec_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = exec_resp.status();
        let bytes = exec_resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    }

    let gate_body = serde_json::json!({
        "current": backtest_config(),
        "candidate": backtest_config(),
        "token": "ETH",
        "revision_id": revision_id,
        "paper": {
            "trades": 0,
            "total_return_pct": -99.0,
            "max_drawdown_pct": 99.0,
            "candidate_hash": "sha256:forged"
        },
        "min_paper_trades": 20,
        "max_paper_drawdown_pct": 10.0
    });

    let gate_resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/promotion-gate")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&gate_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = gate_resp.status();
    let bytes = gate_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["paper"]["candidate_hash"], candidate_hash);
    assert_eq!(json["paper"]["revision_id"], revision_id);
    assert_eq!(json["paper"]["trades"], 20);
    assert!(json["paper"]["total_return_pct"].as_f64().unwrap() > 0.0);
    assert_eq!(json["paper"]["max_drawdown_pct"].as_f64().unwrap(), 0.0);
    let blockers = json["blockers"].as_array().unwrap();
    assert!(!blockers.iter().any(|b| {
        let blocker = b.as_str().unwrap();
        blocker.contains("missing persisted paper")
            || blocker.contains("need at least")
            || blocker.contains("return must be positive")
            || blocker.contains("drawdown")
            || blocker.contains("missing pnl")
            || blocker.contains("missing equity")
    }));
}

#[tokio::test]
async fn test_evolution_promotion_gate_does_not_leak_revision_evidence_across_bots() {
    let mock = MockServer::start().await;
    let bot_a = format!("evo-isolation-a-{}", uuid::Uuid::new_v4());
    let bot_b = format!("evo-isolation-b-{}", uuid::Uuid::new_v4());
    let app_a = build_router(test_state_with_bot_id(&mock.uri(), &bot_a).await);
    let app_b = build_router(test_state_with_bot_id(&mock.uri(), &bot_b).await);
    record_evolution_candles(&app_a, &bot_a).await;
    record_evolution_candles(&app_b, &bot_b).await;

    let probe_body = serde_json::json!({
        "user_intent": "Probe shared candidate hash for bot isolation evidence.",
        "current": backtest_config(),
        "candidate": backtest_config(),
        "token": "ETH",
        "train_pct": 0.7
    });
    let probe_resp = app_a
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/self-improve")
                .header("authorization", format!("Bearer {bot_a}"))
                .header("content-type", "application/json")
                .body(Body::from(probe_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(probe_resp.status(), 200);
    let bytes = probe_resp.into_body().collect().await.unwrap().to_bytes();
    let probe_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let candidate_hash = probe_json["run"]["candidate_hash"].as_str().unwrap();
    let revision_id_a = create_sandbox_revision(&app_a, &bot_a, None).await;

    for i in 0..20 {
        let exec_body = execute_body_with_metadata(serde_json::json!({
            "test_nonce": uuid::Uuid::new_v4().to_string(),
            "candidate_hash": candidate_hash,
            "revision_id": revision_id_a,
            "paper_pnl_pct": "0.2",
            "paper_equity_after": format!("{:.2}", 10_000.0 + (i as f64 * 20.0))
        }));
        let exec_resp = app_a
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/execute")
                    .header("authorization", format!("Bearer {bot_a}"))
                    .header("content-type", "application/json")
                    .body(Body::from(exec_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(exec_resp.status(), 200);
    }

    let gate_body = serde_json::json!({
        "current": backtest_config(),
        "candidate": backtest_config(),
        "token": "ETH",
        "revision_id": revision_id_a,
        "min_paper_trades": 20,
        "max_paper_drawdown_pct": 10.0
    });
    let gate_resp = app_b
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/promotion-gate")
                .header("authorization", format!("Bearer {bot_b}"))
                .header("content-type", "application/json")
                .body(Body::from(gate_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = gate_resp.status();
    let bytes = gate_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["approved"], false);
    assert_eq!(json["paper"], serde_json::Value::Null);
    assert!(json["blockers"].as_array().unwrap().iter().any(|blocker| {
        blocker
            .as_str()
            .unwrap()
            .contains("missing persisted paper trading evidence")
    }));
}

#[tokio::test]
async fn test_execute_rejects_stale_live_revision_after_rollback() {
    let market = MockServer::start().await;
    let rpc = MockServer::start().await;
    let state = live_test_state(&market.uri(), &rpc.uri()).await;
    let app = build_router(state);

    let first_revision_id = create_sandbox_revision(&app, TEST_TOKEN, None).await;
    let second_revision_id =
        create_sandbox_revision(&app, TEST_TOKEN, Some(&first_revision_id)).await;

    let activate_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/evolution/sandbox/revisions/{second_revision_id}/activate"
                ))
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"reason": "candidate passed paper evidence"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(activate_resp.status(), 200);

    let rollback_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/rollback")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "target_revision_id": first_revision_id,
                        "reason": "candidate failed canary"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rollback_resp.status(), 200);

    let exec_body = execute_body_with_metadata(serde_json::json!({
        "test_nonce": uuid::Uuid::new_v4().to_string(),
        "revision_id": second_revision_id
    }));
    let exec_resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/execute")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(exec_body))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = exec_resp.status();
    let bytes = exec_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        String::from_utf8_lossy(&bytes).contains("not the active live revision"),
        "{}",
        String::from_utf8_lossy(&bytes)
    );
}

#[tokio::test]
async fn test_self_improvement_loop_generates_candidate_gates_and_persists_run() {
    let mock = MockServer::start().await;
    let bot_id = format!("self-improve-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let mut candles = Vec::new();
    for i in 0..72 {
        let base = if i < 36 {
            140.0 - i as f64 * 1.1
        } else {
            100.0 + (i - 36) as f64 * 1.05
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.2),
            "low": format!("{:.2}", base - 0.8),
            "close": format!("{:.2}", base + 0.35),
            "volume": "120000"
        }));
    }

    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    let body = serde_json::json!({
        "user_intent": "Make this strategy safer and reduce risk before any live promotion.",
        "current": backtest_config(),
        "token": "ETH",
        "train_pct": 0.7
    });

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/self-improve")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(json["run"]["bot_id"], bot_id);
    assert!(
        json["run"]["candidate_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(json["run"]["approved"], false);
    assert_eq!(json["run"]["status"], "blocked");
    assert!(json["run"]["blockers"].as_array().unwrap().iter().any(|b| {
        b.as_str()
            .unwrap()
            .contains("missing persisted paper trading evidence")
    }));
    assert_eq!(
        json["run"]["candidate_config"]["harness"]["version"].as_u64(),
        Some(2)
    );
    assert!(
        json["run"]["candidate_config"]["harness"]["entry_threshold"]
            .as_f64()
            .unwrap()
            > backtest_config()["harness"]["entry_threshold"]
                .as_f64()
                .unwrap()
    );

    let list_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/self-improve/runs")
                .header("authorization", &format!("Bearer {bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_resp.status(), 200);
    let bytes = list_resp.into_body().collect().await.unwrap().to_bytes();
    let runs: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["run_id"], json["run"]["run_id"]);
}

#[tokio::test]
async fn test_self_improvement_records_sandbox_lineage_and_survives_rollback() {
    let mock = MockServer::start().await;
    let bot_id = format!("self-improve-sandbox-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let mut candles = Vec::new();
    for i in 0..72 {
        let base = if i < 36 {
            140.0 - i as f64 * 1.1
        } else {
            100.0 + (i - 36) as f64 * 1.05
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.2),
            "low": format!("{:.2}", base - 0.8),
            "close": format!("{:.2}", base + 0.35),
            "volume": "120000"
        }));
    }
    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    let snapshot_body = serde_json::json!({
        "base_repo": "https://github.com/tangle-network/ai-trading-blueprint",
        "base_ref": "linh/feat/hype-perp",
        "base_commit": "cc4b514",
        "base_image_digest": "sha256:base-image",
        "workspace_digest": "sha256:workspace-v0",
        "workspace_path": "/workspace/bot"
    });
    let snapshot_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/snapshot")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(snapshot_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = snapshot_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let snapshot_id = snapshot["snapshot_id"].as_str().unwrap().to_string();

    let candidate = backtest_config();
    let first_body = serde_json::json!({
        "user_intent": "Rewrite the local sandbox strategy runner to test a safer entry threshold.",
        "current": backtest_config(),
        "candidate": candidate,
        "token": "ETH",
        "train_pct": 0.7,
        "sandbox_mutation": {
            "base_snapshot_id": snapshot_id,
            "patch": "diff --git a/trading-runtime/src/backtest/runner.rs b/trading-runtime/src/backtest/runner.rs\n+// safer threshold experiment\n",
            "files_changed": ["trading-runtime/src/backtest/runner.rs"],
            "tests": ["cargo test -p trading-runtime --lib"]
        }
    });
    let first_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/self-improve")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(first_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = first_resp.status();
    let bytes = first_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let first_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let candidate_hash = first_json["run"]["candidate_hash"].as_str().unwrap();
    let first_revision_id = first_json["run"]["sandbox_revision_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(first_json["run"]["base_snapshot_id"], snapshot_id);

    for i in 0..20 {
        let exec_body = execute_body_with_metadata(serde_json::json!({
            "test_nonce": uuid::Uuid::new_v4().to_string(),
            "candidate_hash": candidate_hash,
            "paper_pnl_pct": "0.1",
            "paper_equity_after": format!("{:.2}", 10_000.0 + (i as f64 * 10.0))
        }));
        let exec_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/execute")
                    .header("authorization", &format!("Bearer {bot_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(exec_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = exec_resp.status();
        let bytes = exec_resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    }

    let second_body = serde_json::json!({
        "user_intent": "Continue the same sandbox experiment after paper trading evidence exists.",
        "current": backtest_config(),
        "candidate": backtest_config(),
        "token": "ETH",
        "train_pct": 0.7,
        "sandbox_mutation": {
            "base_snapshot_id": snapshot_id,
            "parent_revision_id": first_revision_id,
            "patch": "diff --git a/trading-http-api/src/routes/evolution.rs b/trading-http-api/src/routes/evolution.rs\n+// persist paper evidence linkage\n",
            "files_changed": ["trading-http-api/src/routes/evolution.rs"],
            "tests": ["cargo test -p trading-http-api evolution --test api_tests"]
        }
    });
    let second_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/self-improve")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(second_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = second_resp.status();
    let bytes = second_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    let second_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(second_json["run"]["paper_evidence"]["trades"], 20);
    let second_revision_id = second_json["run"]["sandbox_revision_id"]
        .as_str()
        .unwrap()
        .to_string();

    let activate_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/evolution/sandbox/revisions/{second_revision_id}/activate"
                ))
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"reason": "passed paper evidence"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(activate_resp.status(), 200);

    let rollback_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/rollback")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "target_revision_id": first_revision_id,
                        "reason": "regression detected"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = rollback_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let rollback: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(rollback["revision_id"], first_revision_id);
    assert_eq!(rollback["rollback_from"], second_revision_id);

    let lineage_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/sandbox/lineage")
                .header("authorization", &format!("Bearer {bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = lineage_resp.into_body().collect().await.unwrap().to_bytes();
    let lineage: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(lineage["snapshots"].as_array().unwrap().len(), 1);
    assert_eq!(lineage["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(lineage["active_revision"]["revision_id"], first_revision_id);
    assert_eq!(
        lineage["active_revision"]["rollback_from"],
        second_revision_id
    );
    assert!(
        lineage["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|revision| {
                revision["run_id"] == second_json["run"]["run_id"]
                    && revision["parent_revision_id"] == first_revision_id
            })
    );
}

#[tokio::test]
async fn test_revision_arena_projects_revision_zero_and_active_candidate() {
    let mock = MockServer::start().await;
    let bot_id = format!("revision-arena-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let initial_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/revision-arena")
                .header("authorization", &format!("Bearer {bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(initial_resp.status(), 200);
    let bytes = initial_resp.into_body().collect().await.unwrap().to_bytes();
    let initial: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(initial["active_revision_id"], "rev-0");
    assert_eq!(initial["live_revision_id"], serde_json::Value::Null);
    assert_eq!(initial["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(initial["revisions"][0]["revision_id"], "rev-0");
    assert_eq!(initial["revisions"][0]["run_mode"], "paper");
    assert_eq!(initial["revisions"][0]["can_execute_live"], false);
    assert!(
        initial["invariant"]
            .as_str()
            .unwrap()
            .contains("Only the active live/canary revision")
    );

    let snapshot_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/snapshot")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "base_repo": "https://github.com/tangle-network/ai-trading-blueprint",
                        "base_ref": "linh/feat/hype-perp",
                        "base_commit": "rev0",
                        "base_image_digest": "sha256:image",
                        "workspace_digest": "sha256:workspace"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot_resp.status(), 200);
    let bytes = snapshot_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let snapshot_id = snapshot["snapshot_id"].as_str().unwrap();

    let revision_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/sandbox/revisions")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "user_intent": "Create a paper-only revision arena candidate.",
                        "base_snapshot_id": snapshot_id,
                        "patch": "diff --git a/strategy.rs b/strategy.rs\n+// candidate\n",
                        "files_changed": ["strategy.rs"],
                        "tests": ["cargo test -p trading-runtime --lib"],
                        "status": "candidate"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revision_resp.status(), 200);
    let bytes = revision_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let revision: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let revision_id = revision["revision_id"].as_str().unwrap();

    let activate_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/evolution/sandbox/revisions/{revision_id}/activate"
                ))
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"reason": "paper promotion accepted"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(activate_resp.status(), 200);

    let arena_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/revision-arena")
                .header("authorization", &format!("Bearer {bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(arena_resp.status(), 200);
    let bytes = arena_resp.into_body().collect().await.unwrap().to_bytes();
    let arena: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(arena["active_revision_id"], revision_id);
    assert_eq!(arena["live_revision_id"], serde_json::Value::Null);
    assert_eq!(arena["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(arena["revisions"][0]["status"], "superseded");
    assert_eq!(arena["revisions"][1]["revision_id"], revision_id);
    assert_eq!(arena["revisions"][1]["status"], "active");
    assert_eq!(arena["revisions"][1]["run_mode"], "paper");
    assert_eq!(arena["revisions"][1]["can_execute_live"], false);
    assert_eq!(arena["revisions"][1]["parent_revision_id"], "rev-0");
    assert_eq!(arena["revisions"][1]["files_changed"][0], "strategy.rs");
    assert!(
        arena["modes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mode| mode["mode"] == "live" && mode["can_touch_funds"] == true)
    );
}

#[tokio::test]
async fn test_self_improvement_rejects_short_intent_before_artifacting() {
    let mock = MockServer::start().await;
    let bot_id = format!("self-improve-short-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);

    let body = serde_json::json!({
        "user_intent": "too short",
        "current": backtest_config(),
        "token": "ETH"
    });

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/evolution/self-improve")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let list_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/self-improve/runs")
                .header("authorization", &format!("Bearer {bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_resp.status(), 200);
    let bytes = list_resp.into_body().collect().await.unwrap().to_bytes();
    let runs: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(runs.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_self_improvement_stress_concurrent_runs_persist_and_stay_bot_scoped() {
    let mock = MockServer::start().await;
    let bot_id = format!("self-improve-stress-{}", uuid::Uuid::new_v4());
    let other_bot_id = format!("self-improve-other-{}", uuid::Uuid::new_v4());
    let state = test_state_with_bot_id(&mock.uri(), &bot_id).await;
    let app = build_router(state);
    let other_state = test_state_with_bot_id(&mock.uri(), &other_bot_id).await;
    let other_app = build_router(other_state);

    let mut candles = Vec::new();
    for i in 0..96 {
        let base = if i < 48 {
            160.0 - i as f64 * 0.9
        } else {
            116.0 + (i - 48) as f64 * 0.85
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "ETH",
            "open": format!("{base:.2}"),
            "high": format!("{:.2}", base + 1.1),
            "low": format!("{:.2}", base - 0.7),
            "close": format!("{:.2}", base + 0.3),
            "volume": "150000"
        }));
    }

    let record_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/market-data/candles")
                .header("authorization", &format!("Bearer {bot_id}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"candles": candles}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(record_resp.status(), 200);

    let mut explicit_candidate = backtest_config();
    explicit_candidate["harness"]["version"] = serde_json::json!(77);
    explicit_candidate["harness"]["entry_threshold"] = serde_json::json!(0.42);

    let mut calls = Vec::new();
    for i in 0..12 {
        let app = app.clone();
        let bot_id = bot_id.clone();
        let mut body = serde_json::json!({
            "user_intent": format!("Concurrent improvement run {i}: reduce drawdown without live mutation."),
            "current": backtest_config(),
            "candidate": explicit_candidate,
            "token": "ETH",
            "train_pct": 0.7
        });
        if i % 2 == 0 {
            body["paper"] = serde_json::json!({
                "trades": 3,
                "total_return_pct": -0.2,
                "max_drawdown_pct": 15.0,
                "candidate_hash": format!("candidate-{i}")
            });
        }
        calls.push(tokio::spawn(async move {
            let resp = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/evolution/self-improve")
                        .header("authorization", &format!("Bearer {bot_id}"))
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_string(&body).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = resp.status();
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        }));
    }

    let results = futures_util::future::join_all(calls).await;
    let mut run_ids = std::collections::BTreeSet::new();
    for result in results {
        let json = result.unwrap();
        assert_eq!(json["run"]["approved"], false);
        assert_eq!(json["run"]["status"], "blocked");
        assert_eq!(
            json["run"]["candidate_config"]["harness"]["version"].as_u64(),
            Some(77),
            "explicit agent candidate must not be overwritten by generator"
        );
        assert!(run_ids.insert(json["run"]["run_id"].as_str().unwrap().to_string()));
    }
    assert_eq!(run_ids.len(), 12);

    let list_resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/self-improve/runs")
                .header("authorization", &format!("Bearer {bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_resp.status(), 200);
    let bytes = list_resp.into_body().collect().await.unwrap().to_bytes();
    let runs: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(runs.as_array().unwrap().len(), 12);

    let other_resp = other_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/evolution/self-improve/runs")
                .header("authorization", &format!("Bearer {other_bot_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(other_resp.status(), 200);
    let bytes = other_resp.into_body().collect().await.unwrap().to_bytes();
    let other_runs: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(other_runs.as_array().unwrap().len(), 0);
}

// ── Backtest multi-token tests ─────────────────────────────────────────

#[tokio::test]
async fn test_backtest_run_multi_token() {
    let mock = MockServer::start().await;
    let state = test_state(&mock.uri()).await;
    let app = build_router(state);

    let mut candles = backtest_candles().as_array().unwrap().clone();
    // Add BTC candles at same timestamps
    for i in 0..30 {
        let base = if i < 15 {
            40000.0 - i as f64 * 500.0
        } else {
            33000.0 + (i - 15) as f64 * 500.0
        };
        candles.push(serde_json::json!({
            "timestamp": i * 3600,
            "token": "BTC",
            "open": base,
            "high": base + 200.0,
            "low": base - 100.0,
            "close": base + 100.0,
            "volume": 500000
        }));
    }

    let body = serde_json::json!({
        "config": backtest_config(),
        "candles": candles,
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/backtest/run")
                .header("authorization", auth_header())
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    let tokens = json["result"]["tokens_traded"].as_array().unwrap();
    assert!(tokens.contains(&serde_json::json!("ETH")));
    assert!(tokens.contains(&serde_json::json!("BTC")));
}

// ── /learning/* — strategy bandit + slippage learner ────────────────────────

#[tokio::test]
async fn test_multi_bot_learning_slippage_returns_fallback_when_unobserved() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/learning/slippage?token_in=0x0000000000000000000000000000000000000111&token_out=0x0000000000000000000000000000000000000222&fallback=75")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["recommended_max_bps"], 75);
    assert_eq!(json["observation_count"], 0);
    assert_eq!(json["failure_count"], 0);
}

#[tokio::test]
async fn test_multi_bot_learning_strategy_outcome_records_arm_pull() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state.clone());

    // Record one outcome for variant-x.
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/learning/strategy-outcome")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "variant_id": "variant-x",
                        "reward": 2.5,
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["variant_id"], "variant-x");
    assert_eq!(json["arm_pulls"], 1);
    assert_eq!(json["total_pulls"], 1);
    assert!((json["arm_mean_reward"].as_f64().unwrap() - 2.5).abs() < 1e-9);

    // Second outcome stacks on the same arm.
    let resp2 = build_multi_bot_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/learning/strategy-outcome")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_string(&serde_json::json!({
                        "variant_id": "variant-x",
                        "reward": 4.5,
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp2.status(), 200);
    let body = resp2.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["arm_pulls"], 2);
    assert!((json["arm_mean_reward"].as_f64().unwrap() - 3.5).abs() < 1e-9);
}

#[tokio::test]
async fn test_multi_bot_learning_bandit_status_reports_best_arm() {
    // Use a fresh bot so prior tests don't leak state into the assertion.
    let bot_id = format!("bandit-status-bot-{}", uuid::Uuid::new_v4());
    let token = format!("bandit-status-token-{}", uuid::Uuid::new_v4());
    let state =
        multi_bot_state_with_market_and_bot("http://localhost:1234", &token, &bot_id, 31337);

    // Seed two arms with different rewards.
    for (variant, reward) in [("alpha", 1.0_f64), ("beta", 5.0_f64)] {
        build_multi_bot_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/learning/strategy-outcome")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_string(&serde_json::json!({
                            "variant_id": variant,
                            "reward": reward,
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    }

    let resp = build_multi_bot_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/learning/bandit-status")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["bot_id"], bot_id);
    assert_eq!(json["total_pulls"], 2);
    let arms = json["arms"].as_array().unwrap();
    assert_eq!(arms.len(), 2);
    assert_eq!(json["best_arm"]["variant_id"], "beta");
    assert!((json["best_arm"]["total_reward"].as_f64().unwrap() - 5.0).abs() < 1e-9);
}

#[tokio::test]
async fn test_multi_bot_learning_rejects_unauthenticated_request() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    // Bad bearer -> auth middleware rejects with 401, simulating the
    // "missing/unresolvable bot" path before any handler logic runs.
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/learning/bandit-status")
                .header("authorization", "Bearer nope-not-a-real-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn test_multi_bot_learning_slippage_rejects_invalid_token_address() {
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/learning/slippage?token_in=not-an-address&token_out=0x0000000000000000000000000000000000000222")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 400);
}

// ── CEX route tests ─────────────────────────────────────────────────────────
//
// These run the live router with a wiremock-backed venue. We set per-venue
// env vars (BINANCE_BASE_URL / COINBASE_BASE_URL) to point at the mock server.

/// Test EC P-256 PKCS#8 PEM — generated via:
///   openssl ecparam -name prime256v1 -genkey -noout |
///   openssl pkcs8 -topk8 -nocrypt
const CEX_TEST_COINBASE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQSFkfB4L5EN45Zm8\nCN/zU4PTqMFDNOlNeiZuVDZ8QNyhRANCAATYsJm0lw3OdvU4tsOyAtl6VIvz7VaP\nGsmTzm980uKpRWCq3Ubxeaz8PaAetQJEWwT98YNTxe5FXR5+QwgW9RzW\n-----END PRIVATE KEY-----\n";

/// Set CEX env vars so client builders pick up the mock server. Synchronized
/// across tests via a global mutex; restored after each test.
struct CexEnvGuard {
    keys: Vec<&'static str>,
    prior: Vec<(String, Option<String>)>,
}

impl CexEnvGuard {
    fn set(values: &[(&'static str, &str)]) -> Self {
        // SAFETY: env var mutations are synchronized via cex_env_lock.
        let prior: Vec<_> = values
            .iter()
            .map(|(k, _)| (k.to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in values {
            unsafe {
                std::env::set_var(k, v);
            }
        }
        let keys = values.iter().map(|(k, _)| *k).collect();
        Self { keys, prior }
    }
}

impl Drop for CexEnvGuard {
    fn drop(&mut self) {
        for (k, prior) in self.prior.drain(..) {
            unsafe {
                match prior {
                    Some(v) => std::env::set_var(&k, v),
                    None => std::env::remove_var(&k),
                }
            }
        }
        // Make sure all keys are removed if the prior was None.
        for k in &self.keys {
            if !self.prior.iter().any(|(p, _)| p == *k) {
                unsafe { std::env::remove_var(k) };
            }
        }
    }
}

fn cex_env_lock() -> &'static tokio::sync::Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::const_new(()))
}

#[tokio::test]
async fn test_cex_unknown_venue_returns_404() {
    let _guard = cex_env_lock().lock().await;
    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/cex/kraken/account")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn test_cex_live_direct_route_rejected_for_live_bot() {
    let _guard = cex_env_lock().lock().await;
    ensure_state_dir();
    let bot_id = format!("bot-direct-cex-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("bot-token-cex-direct", bot);
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/cex/binance/order")
                .header("authorization", "Bearer bot-token-cex-direct")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "symbol": "BTCUSDT",
                        "side": "buy",
                        "order_type": { "type": "market" },
                        "quantity": "0.001"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 403);
}

#[tokio::test]
async fn test_cex_binance_paper_order_through_mock() {
    let _guard = cex_env_lock().lock().await;
    let mock = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v3/order"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "symbol": "BTCUSDT",
            "orderId": 12345,
            "clientOrderId": "test-1",
            "transactTime": 1700000000000_i64,
            "price": "0",
            "origQty": "0.001",
            "executedQty": "0.001",
            "cummulativeQuoteQty": "30.0",
            "status": "FILLED",
            "timeInForce": "IOC",
            "type": "MARKET",
            "side": "BUY",
            "fills": [
                { "price": "30000", "qty": "0.001",
                  "commission": "0.03", "commissionAsset": "USDT",
                  "tradeId": 1 }
            ]
        })))
        .mount(&mock)
        .await;

    let _env = CexEnvGuard::set(&[
        ("BINANCE_BASE_URL", &mock.uri()),
        ("BINANCE_API_KEY", "test-key"),
        ("BINANCE_API_SECRET", "test-secret"),
    ]);

    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/cex/binance/order")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "symbol": "BTCUSDT",
                        "side": "buy",
                        "order_type": { "type": "market" },
                        "quantity": "0.001"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = resp.status();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));

    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["venue"], "binance");
    assert_eq!(json["venue_order_id"], "12345");
    assert_eq!(json["status"], "filled");
    assert_eq!(json["filled_quantity"], "0.001");
}

#[tokio::test]
async fn test_cex_binance_account_endpoint() {
    let _guard = cex_env_lock().lock().await;
    let mock = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v3/account"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "makerCommission": 10,
            "takerCommission": 10,
            "balances": [
                { "asset": "BTC", "free": "0.5", "locked": "0.0" },
                { "asset": "USDT", "free": "1000.0", "locked": "50.0" },
                { "asset": "ZRX", "free": "0", "locked": "0" }
            ]
        })))
        .mount(&mock)
        .await;

    let _env = CexEnvGuard::set(&[
        ("BINANCE_BASE_URL", &mock.uri()),
        ("BINANCE_API_KEY", "test-key"),
        ("BINANCE_API_SECRET", "test-secret"),
    ]);

    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/cex/binance/account")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["venue"], "binance");
    let balances = json["balances"].as_array().unwrap();
    assert_eq!(balances.len(), 2, "zero-balance entries should be filtered");
}

#[tokio::test]
async fn test_cex_binance_translates_insufficient_balance_to_402() {
    let _guard = cex_env_lock().lock().await;
    let mock = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v3/order"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "code": -2010,
            "msg": "Account has insufficient balance for requested action."
        })))
        .mount(&mock)
        .await;

    let _env = CexEnvGuard::set(&[
        ("BINANCE_BASE_URL", &mock.uri()),
        ("BINANCE_API_KEY", "test-key"),
        ("BINANCE_API_SECRET", "test-secret"),
    ]);

    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/cex/binance/order")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "symbol": "BTCUSDT",
                        "side": "buy",
                        "order_type": { "type": "market" },
                        "quantity": "10000"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 402);
}

#[tokio::test]
async fn test_cex_coinbase_paper_order_through_mock() {
    let _guard = cex_env_lock().lock().await;
    let mock = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v3/brokerage/orders"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "success": true,
            "success_response": {
                "order_id": "abc-123",
                "product_id": "BTC-USD",
                "side": "BUY",
                "client_order_id": "test-1"
            }
        })))
        .mount(&mock)
        .await;

    let _env = CexEnvGuard::set(&[
        ("COINBASE_BASE_URL", &mock.uri()),
        (
            "COINBASE_API_KEY_NAME",
            "organizations/test-org/apiKeys/test-key",
        ),
        ("COINBASE_API_PRIVATE_KEY", CEX_TEST_COINBASE_PEM),
    ]);

    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/cex/coinbase/order")
                .header("authorization", "Bearer bot-token-abc")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "symbol": "BTC-USD",
                        "side": "buy",
                        "order_type": { "type": "market" },
                        "quantity": "0.001"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = resp.status();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["venue"], "coinbase");
    assert_eq!(json["venue_order_id"], "abc-123");
    assert_eq!(json["status"], "pending");
}

#[tokio::test]
async fn test_cex_coinbase_misconfigured_key_returns_503() {
    let _guard = cex_env_lock().lock().await;
    let _env = CexEnvGuard::set(&[
        ("COINBASE_BASE_URL", "http://127.0.0.1:1"),
        (
            "COINBASE_API_KEY_NAME",
            "organizations/test-org/apiKeys/test-key",
        ),
        ("COINBASE_API_PRIVATE_KEY", "not-a-valid-pem"),
    ]);

    let state = multi_bot_state();
    let app = build_multi_bot_router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/cex/coinbase/account")
                .header("authorization", "Bearer bot-token-abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), 503);
}

// ── Audit: concurrent envelope writes ───────────────────────────────────────

/// Stress test for `audits/http-api-concurrency-audit.md` finding #1/#2.
///
/// Spawns 10 tokio tasks, each PUTting an envelope at a distinct nonce.
/// After the join, the on-disk envelope must
///   1. Deserialize cleanly (atomic write — no truncated JSON).
///   2. Carry a nonce equal to the highest one that successfully landed
///      (monotonicity — no stale write clobbers a higher one).
/// The router enforces nonce monotonicity, so concurrent PUTs at the same
/// nonce should produce exactly one 200 + nine 409s; the file content
/// must match the single accepted envelope.
#[tokio::test]
async fn test_concurrent_put_envelope_is_atomic_and_monotonic() {
    ensure_state_dir();
    let bot_id = format!("bot-concurrent-put-{}", uuid::Uuid::new_v4());
    let bot = live_bot_with_trust(&bot_id, trading_runtime::ValidationTrust::Envelope);
    let state = multi_bot_state_for_bot("concurrent-put-token", bot.clone());
    let app = build_multi_bot_router(state);

    // Pre-seed nonce=0 so the first concurrent batch is the contested one.
    {
        let mut seed = signed_envelope_for_bot(&bot);
        seed.nonce = 0;
        resign_envelope(&mut seed);
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/envelope")
                    .header("authorization", "Bearer concurrent-put-token")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&seed).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "seed PUT must succeed");
    }

    // Fire 10 concurrent PUTs. Each task picks a unique nonce in [1..=10]
    // so we can compute the expected highest-accepted nonce.
    let mut handles = Vec::new();
    for nonce in 1u64..=10 {
        let app = app.clone();
        let bot = bot.clone();
        handles.push(tokio::spawn(async move {
            let mut env = signed_envelope_for_bot(&bot);
            env.nonce = nonce;
            resign_envelope(&mut env);
            let resp = app
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/envelope")
                        .header("authorization", "Bearer concurrent-put-token")
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&env).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            (nonce, resp.status())
        }));
    }

    let mut accepted_nonces: Vec<u64> = Vec::new();
    for h in handles {
        let (nonce, status) = h.await.unwrap();
        // 200 (accepted) or 409 (rejected because a higher nonce already
        // landed). Anything else (5xx, 400, etc.) means the route bricked
        // under contention — that's the failure this test is hunting.
        assert!(
            status == StatusCode::OK || status == StatusCode::CONFLICT,
            "unexpected status {status} for nonce={nonce}"
        );
        if status == StatusCode::OK {
            accepted_nonces.push(nonce);
        }
    }

    // At least one PUT must have landed (10 was tried last in the natural
    // ordering — but the actual happy-path count depends on scheduling).
    assert!(!accepted_nonces.is_empty(), "no PUTs landed");

    // GET the envelope back; it must deserialize cleanly and its nonce must
    // be the largest one we observed in the accepted set.
    let get = app
        .oneshot(
            Request::builder()
                .uri("/envelope")
                .header("authorization", "Bearer concurrent-put-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get.status(), 200);
    let body = get.into_body().collect().await.unwrap().to_bytes();
    // The atomic-write check: parse must succeed, never see a truncated blob.
    let value: serde_json::Value =
        serde_json::from_slice(&body).expect("envelope JSON must round-trip");

    let stored_nonce = value["nonce"].as_u64().expect("nonce field");
    let max_accepted = *accepted_nonces.iter().max().unwrap();
    assert_eq!(
        stored_nonce, max_accepted,
        "stored nonce must equal max accepted nonce; accepted={accepted_nonces:?}"
    );
}
