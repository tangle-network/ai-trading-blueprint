//! Tier 1 — Core logic integration tests.
//!
//! Always run, no Docker or Tangle required.  Tests exercise the `*_core`
//! functions directly with pre-seeded persistent stores.

mod common;

use blueprint_sdk::alloy::primitives::{Address, U256};
use blueprint_sdk::alloy::sol_types::SolValue;
use trading_blueprint_lib::jobs::{
    activate_bot_with_secrets, configure_core, deprovision_core, extend_core, provision_core,
    start_core, status_core, stop_core, wipe_bot_secrets,
};
use trading_blueprint_lib::prompts::{
    build_generic_agent_profile, build_loop_prompt, build_pack_agent_profile,
    build_pack_loop_prompt, build_system_prompt, packs,
};
use trading_blueprint_lib::state::{bot_key, bots, find_bot_by_sandbox};
use trading_blueprint_lib::{
    TradingExtendRequest, TradingProvisionOutput, TradingProvisionRequest, TradingStatusResponse,
};

use common::fixtures;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_provision_request(name: &str, strategy: &str) -> TradingProvisionRequest {
    make_provision_request_with_lifetime(name, strategy, 0)
}

fn make_provision_request_with_lifetime(
    name: &str,
    strategy: &str,
    max_lifetime_days: u64,
) -> TradingProvisionRequest {
    TradingProvisionRequest {
        name: name.to_string(),
        strategy_type: strategy.to_string(),
        strategy_config_json: r#"{"max_slippage":0.5}"#.to_string(),
        risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
        factory_address: Address::from([0xBB; 20]),
        asset_token: Address::from([0xCC; 20]),
        signers: vec![Address::from([0x01; 20]), Address::from([0x02; 20])],
        required_signatures: U256::from(2),
        chain_id: U256::from(31337),
        rpc_url: "http://localhost:8545".to_string(),
        trading_loop_cron: "0 */5 * * * *".to_string(),
        cpu_cores: 2,
        memory_mb: 4096,
        max_lifetime_days,
        validator_service_ids: vec![],
    }
}

fn mock_sandbox(id: &str) -> sandbox_runtime::SandboxRecord {
    sandbox_runtime::SandboxRecord {
        id: id.to_string(),
        container_id: format!("container-{id}"),
        sidecar_url: "http://127.0.0.1:19999".to_string(),
        sidecar_port: 19999,
        ssh_port: None,
        token: "test-sidecar-token".to_string(),
        created_at: chrono::Utc::now().timestamp() as u64,
        cpu_cores: 2,
        memory_mb: 4096,
        state: sandbox_runtime::SandboxState::Running,
        idle_timeout_seconds: 0,
        max_lifetime_seconds: 86400,
        last_activity_at: chrono::Utc::now().timestamp() as u64,
        stopped_at: None,
        snapshot_image_id: None,
        snapshot_s3_url: None,
        container_removed_at: None,
        image_removed_at: None,
        original_image: String::new(),
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
        tee_config: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_provision_creates_records() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-provision-1");
    let sandbox_id = sandbox.id.clone();

    let request = make_provision_request("test-bot", "dex");
    let output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();

    assert_eq!(output.sandbox_id, sandbox_id);
    assert_eq!(output.workflow_id, 0, "two-phase: workflow_id should be 0 (awaiting secrets)");
    assert_eq!(output.vault_address, Address::ZERO, "two-phase: vault created on-chain later, not during provision");

    // Verify bot record was stored in awaiting-secrets state
    let bot = find_bot_by_sandbox(&sandbox_id).unwrap();
    assert_eq!(bot.sandbox_id, sandbox_id);
    assert_eq!(bot.strategy_type, "dex");
    assert!(!bot.trading_active, "two-phase: bot should be inactive until secrets are pushed");
    assert_eq!(bot.submitter_address, "0xTESTCALLER");
    assert_eq!(bot.chain_id, 31337);
    assert_eq!(bot.workflow_id, None, "two-phase: no workflow until activation");
}

#[tokio::test]
async fn test_configure_updates_params() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-configure-1";
    let bot_id = "trading-configure-1";
    fixtures::seed_bot_record(bot_id, sandbox_id, "dex", "0xBB", None);

    let new_config = r#"{"max_slippage":0.3,"pair":"ETH/USDC"}"#;
    let new_risk = r#"{"max_drawdown_pct":3.0}"#;

    let response = configure_core(sandbox_id, new_config, new_risk)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "configured");

    // Verify the update persisted
    let bot = find_bot_by_sandbox(sandbox_id).unwrap();
    assert_eq!(bot.strategy_config["max_slippage"], 0.3);
    assert_eq!(bot.strategy_config["pair"], "ETH/USDC");
    assert_eq!(bot.risk_params["max_drawdown_pct"], 3.0);
}

#[tokio::test]
async fn test_configure_partial_update() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-configure-partial";
    let bot_id = "trading-configure-partial";
    fixtures::seed_bot_record(bot_id, sandbox_id, "yield", "0xCC", None);

    // Update only strategy config, leave risk_params empty
    let response = configure_core(sandbox_id, r#"{"target_apy":8.0}"#, "")
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "configured");

    let bot = find_bot_by_sandbox(sandbox_id).unwrap();
    assert_eq!(bot.strategy_config["target_apy"], 8.0);
    // Risk params should be unchanged
    assert_eq!(bot.risk_params["max_drawdown_pct"], 5.0);
}

#[tokio::test]
async fn test_status_returns_state() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-status-1";
    let bot_id = "trading-status-1";
    let wf_id = 12345u64;
    fixtures::seed_bot_record(bot_id, sandbox_id, "perp", "0xDD", Some(wf_id));

    let response = status_core(sandbox_id, true).await.unwrap();
    assert_eq!(response.sandbox_id, sandbox_id);
    assert_eq!(response.state, "test"); // skip_docker = true
    assert!(response.trading_active);

    // Verify portfolio JSON content
    let portfolio: serde_json::Value =
        serde_json::from_str(&response.portfolio_json).unwrap();
    assert_eq!(portfolio["strategy_type"], "perp");
    assert_eq!(portfolio["vault_address"], "0xDD");
    assert_eq!(portfolio["workflow_id"], wf_id);
}

#[tokio::test]
async fn test_stop_deactivates_workflow() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-stop-1";
    let bot_id = "trading-stop-1";
    let wf_id = 99999u64;

    fixtures::seed_bot_record(bot_id, sandbox_id, "dex", "0xEE", Some(wf_id));
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    let response = stop_core(sandbox_id, true).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "stopped");

    // Bot should be inactive
    let bot = find_bot_by_sandbox(sandbox_id).unwrap();
    assert!(!bot.trading_active);

    // Workflow should be deactivated
    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .unwrap();
    assert!(!wf.active);
    assert!(wf.next_run_at.is_none());
}

#[tokio::test]
async fn test_start_reactivates_workflow() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-start-1";
    let bot_id = "trading-start-1";
    let wf_id = 88888u64;

    let mut bot = fixtures::seed_bot_record(bot_id, sandbox_id, "dex", "0xFF", Some(wf_id));
    bot.trading_active = false;
    bots()
        .unwrap()
        .update(&bot_key(bot_id), |b| b.trading_active = false)
        .unwrap();
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    // Deactivate workflow first
    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
    ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .update(&wf_key, |e| {
            e.active = false;
            e.next_run_at = None;
        })
        .unwrap();

    let response = start_core(sandbox_id, true).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "started");

    // Bot should be active again
    let bot = find_bot_by_sandbox(sandbox_id).unwrap();
    assert!(bot.trading_active);

    // Workflow should be reactivated
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .unwrap();
    assert!(wf.active);
}

#[tokio::test]
async fn test_deprovision_cleans_everything() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-deprovision-1";
    let bot_id = "trading-deprovision-1";
    let wf_id = 77777u64;

    fixtures::seed_bot_record(bot_id, sandbox_id, "yield", "0xAA", Some(wf_id));
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    let response = deprovision_core(sandbox_id, true, None).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "deprovisioned");
    assert_eq!(json["bot_id"], bot_id);

    // Bot record should be gone
    assert!(find_bot_by_sandbox(sandbox_id).is_err());

    // Workflow should be gone
    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap();
    assert!(wf.is_none());
}

#[tokio::test]
async fn test_bot_lifecycle_transitions() {
    let _dir = common::init_test_env();

    // 1. Provision (two-phase: bot starts inactive, awaiting secrets)
    let sandbox = mock_sandbox("sb-lifecycle-1");
    let sandbox_id = sandbox.id.clone();
    let request = make_provision_request("lifecycle-bot", "multi");
    let _output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();
    let bot = find_bot_by_sandbox(&sandbox_id).unwrap();
    assert!(!bot.trading_active, "two-phase: bot starts inactive");

    // Simulate activation (normally done via operator API + activate_bot_with_secrets)
    bots().unwrap()
        .update(&bot_key(&bot.id), |b| {
            b.trading_active = true;
        })
        .unwrap();
    assert!(find_bot_by_sandbox(&sandbox_id).unwrap().trading_active);

    // 2. Configure
    let cfg_result = configure_core(&sandbox_id, r#"{"updated":true}"#, "")
        .await
        .unwrap();
    assert!(cfg_result.json.contains("configured"));

    // 3. Stop
    let stop_result = stop_core(&sandbox_id, true).await.unwrap();
    assert!(stop_result.json.contains("stopped"));
    assert!(!find_bot_by_sandbox(&sandbox_id).unwrap().trading_active);

    // 4. Start
    let start_result = start_core(&sandbox_id, true).await.unwrap();
    assert!(start_result.json.contains("started"));
    assert!(find_bot_by_sandbox(&sandbox_id).unwrap().trading_active);

    // 5. Deprovision
    let deprov_result = deprovision_core(&sandbox_id, true, None).await.unwrap();
    assert!(deprov_result.json.contains("deprovisioned"));
    assert!(find_bot_by_sandbox(&sandbox_id).is_err());
}

#[tokio::test]
async fn test_provision_returns_zero_workflow_id() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-cron-1");
    let request = make_provision_request("cron-bot", "dex");
    let output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();

    // Two-phase: provision never creates workflows — that happens in activate_bot_with_secrets
    assert_eq!(output.workflow_id, 0, "provision should return workflow_id=0");

    // No workflow should exist
    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(0);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap();
    assert!(wf.is_none(), "no workflow should be stored during provision");
}

#[tokio::test]
async fn test_loop_prompt_per_strategy() {
    for strategy in &["dex", "yield", "perp", "prediction", "multi"] {
        let prompt = build_loop_prompt(strategy);
        assert!(
            prompt.contains(strategy),
            "Loop prompt for '{strategy}' should mention the strategy type"
        );
        assert!(prompt.contains("trading loop iteration"));
        assert!(prompt.contains("market prices"));
        assert!(prompt.contains("circuit breaker"));
    }
}

#[tokio::test]
async fn test_system_prompt_includes_api_info() {
    let config = trading_blueprint_lib::state::TradingBotRecord {
        id: "test".to_string(),
        sandbox_id: "sb".to_string(),
        vault_address: "0xVAULT".to_string(),
        share_token: String::new(),
        strategy_type: "dex".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({"max_position_pct": 10}),
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        trading_api_url: "http://test-api:9100".to_string(),
        trading_api_token: "secret-token-xyz".to_string(),
        workflow_id: None,
        trading_active: true,
        created_at: 0,
        operator_address: String::new(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: String::new(),
        trading_loop_cron: String::new(),
        call_id: 0,
        service_id: 0,
    };

    let prompt = build_system_prompt("dex", &config);

    assert!(prompt.contains("http://test-api:9100"), "Should contain API URL");
    assert!(prompt.contains("secret-token-xyz"), "Should contain bearer token");
    assert!(prompt.contains("0xVAULT"), "Should contain vault address");
    assert!(prompt.contains("31337"), "Should contain chain ID");
    assert!(prompt.contains("Uniswap V3"), "DEX strategy should mention Uniswap");
    assert!(prompt.contains("/validate"), "Should list validate endpoint");
    assert!(prompt.contains("/execute"), "Should list execute endpoint");
}

#[tokio::test]
async fn test_abi_round_trip_provision() {
    // Verify ABI encode/decode round-trip for provision types
    let request = make_provision_request("abi-test", "yield");
    let encoded = request.abi_encode();
    let decoded = TradingProvisionRequest::abi_decode(&encoded).unwrap();
    assert_eq!(decoded.name, "abi-test");
    assert_eq!(decoded.strategy_type, "yield");
    assert_eq!(decoded.chain_id, U256::from(31337));

    let output = TradingProvisionOutput {
        vault_address: Address::from([0xBB; 20]),
        share_token: Address::ZERO,
        sandbox_id: "sb-123".to_string(),
        workflow_id: 42,
    };
    let encoded = output.abi_encode();
    let decoded = TradingProvisionOutput::abi_decode(&encoded).unwrap();
    assert_eq!(decoded.sandbox_id, "sb-123");
    assert_eq!(decoded.workflow_id, 42);
}

#[tokio::test]
async fn test_abi_round_trip_status() {
    let response = TradingStatusResponse {
        sandbox_id: "sb-abi".to_string(),
        state: "Running".to_string(),
        portfolio_json: r#"{"vault":"0xAA"}"#.to_string(),
        trading_active: true,
    };
    let encoded = response.abi_encode();
    let decoded = TradingStatusResponse::abi_decode(&encoded).unwrap();
    assert_eq!(decoded.sandbox_id, "sb-abi");
    assert_eq!(decoded.state, "Running");
    assert!(decoded.trading_active);
}

#[tokio::test]
async fn test_operator_context_lifecycle() {
    // Operator context uses OnceCell so this test verifies the API
    // without actually initializing (since other tests may have already).
    let ctx = trading_blueprint_lib::context::operator_context();
    // Either None (not yet initialized) or Some (initialized by another test)
    // In either case, the function should not panic.
    let _ = ctx;
}

#[tokio::test]
async fn test_bot_record_has_new_fields() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-new-fields-1");
    let request = make_provision_request("new-fields-bot", "yield");
    let _output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();

    let bot = find_bot_by_sandbox("sb-new-fields-1").unwrap();
    // New fields should have default values (no operator context, no validator service IDs)
    assert!(bot.validator_service_ids.is_empty());
    // operator_address empty because context wasn't initialized with one for this test
}

#[tokio::test]
async fn test_provision_uses_requested_lifetime() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-lifetime-90");
    let request = make_provision_request_with_lifetime("lifetime-bot", "dex", 90);
    let _output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();

    let bot = find_bot_by_sandbox("sb-lifetime-90").unwrap();
    assert_eq!(bot.max_lifetime_days, 90);
}

#[tokio::test]
async fn test_provision_defaults_to_30_days() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-lifetime-default");
    let request = make_provision_request_with_lifetime("default-bot", "dex", 0);
    let _output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();

    let bot = find_bot_by_sandbox("sb-lifetime-default").unwrap();
    assert_eq!(bot.max_lifetime_days, 30);
}

#[tokio::test]
async fn test_extend_increases_lifetime() {
    let _dir = common::init_test_env();

    // Provision with 30 days
    let sandbox = mock_sandbox("sb-extend-1");
    let request = make_provision_request_with_lifetime("extend-bot", "dex", 30);
    let _output = provision_core(request, Some(sandbox), 0, 0, "0xTESTCALLER".to_string(), None).await.unwrap();

    let bot = find_bot_by_sandbox("sb-extend-1").unwrap();
    assert_eq!(bot.max_lifetime_days, 30);

    // Extend by 60 days (skip_docker = true since we used a mock sandbox)
    let response = extend_core("sb-extend-1", 60, true).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "extended");
    assert_eq!(json["previous_lifetime_days"], 30);
    assert_eq!(json["additional_days"], 60);
    assert_eq!(json["new_lifetime_days"], 90);

    // Verify bot record updated
    let bot = find_bot_by_sandbox("sb-extend-1").unwrap();
    assert_eq!(bot.max_lifetime_days, 90);
}

#[tokio::test]
async fn test_extend_unknown_sandbox_fails() {
    let _dir = common::init_test_env();

    let result = extend_core("nonexistent-sandbox", 30, true).await;
    assert!(result.is_err());
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected error"),
    };
    assert!(err.contains("No trading bot found"), "got: {err}");
}

#[tokio::test]
async fn test_extend_zero_days_fails() {
    let _dir = common::init_test_env();

    let result = extend_core("any-sandbox", 0, true).await;
    assert!(result.is_err());
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected error"),
    };
    assert!(err.contains("additional_days must be > 0"), "got: {err}");
}

#[tokio::test]
async fn test_abi_round_trip_extend() {
    let request = TradingExtendRequest {
        sandbox_id: "sb-extend-abi".to_string(),
        additional_days: 90,
    };
    let encoded = request.abi_encode();
    let decoded = TradingExtendRequest::abi_decode(&encoded).unwrap();
    assert_eq!(decoded.sandbox_id, "sb-extend-abi");
    assert_eq!(decoded.additional_days, 90);
}

// ---------------------------------------------------------------------------
// Strategy Pack tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_pack_profile_has_rich_content() {
    // Tests the profile/prompt building that activate_bot_with_secrets uses.
    // (Provision no longer creates workflows — activation does, via the operator API.)
    let pack = packs::get_pack("prediction").unwrap();
    let config = trading_blueprint_lib::state::TradingBotRecord {
        id: "test".to_string(),
        sandbox_id: "sb".to_string(),
        vault_address: "0xVAULT".to_string(),
        share_token: String::new(),
        strategy_type: "prediction".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({"max_drawdown_pct": 5}),
        chain_id: 137,
        rpc_url: "http://polygon-rpc".to_string(),
        trading_api_url: "http://test-api:9100".to_string(),
        trading_api_token: "test-token".to_string(),
        workflow_id: None,
        trading_active: false,
        created_at: 0,
        operator_address: String::new(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: String::new(),
        trading_loop_cron: String::new(),
        call_id: 0,
        service_id: 0,
    };

    let profile = build_pack_agent_profile(&pack, &config);

    // Profile uses resources.instructions, not systemPrompt
    assert!(profile.get("systemPrompt").is_none());
    let instructions = profile["resources"]["instructions"]["content"]
        .as_str()
        .expect("profile should have resources.instructions.content");
    assert!(instructions.contains("gamma-api.polymarket.com"));
    assert!(instructions.contains("clob.polymarket.com"));
    assert!(instructions.contains("/validate"));
    assert!(instructions.contains("persistent workspace"));

    // Profile has permissions and memory
    assert_eq!(profile["permission"]["bash"], "allow");
    assert_eq!(profile["memory"]["enabled"], true);

    // Loop prompt references the pack name
    let loop_prompt = build_pack_loop_prompt(&pack);
    assert!(loop_prompt.contains("Polymarket Prediction Trading"));
}

#[tokio::test]
async fn test_generic_strategy_gets_profile() {
    // Unknown strategy types still get a valid profile via the generic builder
    let config = trading_blueprint_lib::state::TradingBotRecord {
        id: "test".to_string(),
        sandbox_id: "sb".to_string(),
        vault_address: "0xVAULT".to_string(),
        share_token: String::new(),
        strategy_type: "exotic".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({}),
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        trading_api_url: "http://test-api:9100".to_string(),
        trading_api_token: "test-token".to_string(),
        workflow_id: None,
        trading_active: false,
        created_at: 0,
        operator_address: String::new(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: String::new(),
        trading_loop_cron: String::new(),
        call_id: 0,
        service_id: 0,
    };

    let profile = build_generic_agent_profile("exotic", &config);

    let instructions = profile["resources"]["instructions"]["content"]
        .as_str()
        .expect("generic profile should have instructions");
    assert!(instructions.contains("persistent workspace"));
    assert!(instructions.contains("multi-strategy"));
    assert_eq!(profile["permission"]["bash"], "allow");

    // Generic loop prompt
    let prompt = build_loop_prompt("exotic");
    assert!(prompt.contains("exotic"));
    assert!(prompt.contains("trading loop iteration"));
}

#[tokio::test]
async fn test_prediction_pack_has_default_cron() {
    let pack = packs::get_pack("prediction").unwrap();
    // Polymarket pack default cron: every 15 minutes
    assert_eq!(pack.default_cron, "0 */15 * * * *");
}

// ---------------------------------------------------------------------------
// Agent Profile tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_dex_profile_has_uniswap_content() {
    let pack = packs::get_pack("dex").unwrap();
    let config = trading_blueprint_lib::state::TradingBotRecord {
        id: "test".to_string(),
        sandbox_id: "sb".to_string(),
        vault_address: "0xVAULT".to_string(),
        share_token: String::new(),
        strategy_type: "dex".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({}),
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        trading_api_url: "http://test-api:9100".to_string(),
        trading_api_token: "test-token".to_string(),
        workflow_id: None,
        trading_active: false,
        created_at: 0,
        operator_address: String::new(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: String::new(),
        trading_loop_cron: String::new(),
        call_id: 0,
        service_id: 0,
    };

    let profile = build_pack_agent_profile(&pack, &config);

    let instructions = profile["resources"]["instructions"]["content"]
        .as_str()
        .expect("profile must have resources.instructions.content");
    assert!(instructions.contains("Uniswap V3"));
    assert!(instructions.contains("persistent workspace"));
    assert!(instructions.contains("/home/agent/"));
}

#[tokio::test]
async fn test_all_packs_use_instructions_not_system_prompt() {
    // Verify all known pack types use resources.instructions, not systemPrompt
    for strategy in &["prediction", "dex", "yield", "perp"] {
        let pack = packs::get_pack(strategy).expect(&format!("pack {strategy} should exist"));
        let config = trading_blueprint_lib::state::TradingBotRecord {
            id: "test".to_string(),
            sandbox_id: "sb".to_string(),
            vault_address: "0xVAULT".to_string(),
            share_token: String::new(),
            strategy_type: strategy.to_string(),
            strategy_config: serde_json::json!({}),
            risk_params: serde_json::json!({}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://test-api:9100".to_string(),
            trading_api_token: "test-token".to_string(),
            workflow_id: None,
            trading_active: false,
            created_at: 0,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
            submitter_address: String::new(),
            trading_loop_cron: String::new(),
            call_id: 0,
            service_id: 0,
        };

        let profile = build_pack_agent_profile(&pack, &config);
        assert!(
            profile.get("systemPrompt").is_none(),
            "strategy {strategy} should not set systemPrompt directly"
        );
        assert!(
            profile["resources"]["instructions"]["content"].as_str().is_some(),
            "strategy {strategy} should have resources.instructions.content"
        );
    }
}

#[tokio::test]
async fn test_build_pack_agent_profile_integration() {
    let pack = packs::get_pack("yield").unwrap();
    let config = trading_blueprint_lib::state::TradingBotRecord {
        id: "test".to_string(),
        sandbox_id: "sb".to_string(),
        vault_address: "0xVAULT_YIELD".to_string(),
        share_token: String::new(),
        strategy_type: "yield".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({"max_drawdown_pct": 5}),
        chain_id: 1,
        rpc_url: "http://mainnet-rpc".to_string(),
        trading_api_url: "http://api:9100".to_string(),
        trading_api_token: "yield-token".to_string(),
        workflow_id: None,
        trading_active: true,
        created_at: 0,
        operator_address: String::new(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
        submitter_address: String::new(),
        trading_loop_cron: String::new(),
        call_id: 0,
        service_id: 0,
    };

    let profile = build_pack_agent_profile(&pack, &config);

    // Structural checks
    assert!(profile.get("systemPrompt").is_none());
    assert_eq!(profile["name"], "trading-yield");
    assert_eq!(profile["description"], "DeFi Yield Optimization");

    // Content checks
    let instructions = profile["resources"]["instructions"]["content"].as_str().unwrap();
    assert!(instructions.contains("Aave V3"));
    assert!(instructions.contains("Morpho"));
    assert!(instructions.contains("0xVAULT_YIELD"));
    assert!(instructions.contains("yield-token"));
    assert!(instructions.contains("persistent workspace"));
    assert!(instructions.contains("metrics"));
}

// ---------------------------------------------------------------------------
// Two-phase provision E2E test
// ---------------------------------------------------------------------------

/// Full two-phase provision lifecycle:
///   provision → awaiting secrets → activate with secrets → active → wipe → awaiting secrets
#[tokio::test]
async fn test_two_phase_provision_e2e() {
    let _dir = common::init_test_env();

    // ── Phase 1: Provision ─────────────────────────────────────────────────
    let sandbox = mock_sandbox("sb-2phase-1");
    let sandbox_id = sandbox.id.clone();
    let request = make_provision_request("two-phase-bot", "dex");
    let output = provision_core(request, Some(sandbox), 0, 0, "0xSUBMITTER".to_string(), None)
        .await
        .unwrap();

    // Verify: workflow_id=0 signals awaiting secrets
    assert_eq!(output.workflow_id, 0);

    // Verify: bot in awaiting-secrets state
    let bot = find_bot_by_sandbox(&sandbox_id).unwrap();
    let bot_id = bot.id.clone();
    assert!(!bot.trading_active);
    assert_eq!(bot.workflow_id, None);
    assert_eq!(bot.submitter_address, "0xSUBMITTER");

    // Verify: no workflow exists for this bot (workflow_id=0 is sentinel)
    let wf_key_zero = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(0);
    assert!(
        ai_agent_sandbox_blueprint_lib::workflows::workflows()
            .unwrap()
            .get(&wf_key_zero)
            .unwrap()
            .is_none(),
        "no workflow should exist after provision"
    );

    // ── Phase 2: Activate with secrets ─────────────────────────────────────
    let mut user_env = serde_json::Map::new();
    user_env.insert(
        "ANTHROPIC_API_KEY".into(),
        serde_json::Value::String("sk-test-secret".to_string()),
    );
    user_env.insert(
        "CUSTOM_VAR".into(),
        serde_json::Value::String("custom-value".to_string()),
    );

    let activate_mock = mock_sandbox("sb-2phase-activated");
    let result = activate_bot_with_secrets(&bot_id, user_env, Some(activate_mock))
        .await
        .unwrap();

    assert_eq!(result.sandbox_id, "sb-2phase-activated");
    assert!(result.workflow_id > 0);

    // Verify: bot is now active
    let bot = trading_blueprint_lib::state::get_bot(&bot_id)
        .unwrap()
        .unwrap();
    assert!(bot.trading_active);
    assert_eq!(bot.sandbox_id, "sb-2phase-activated");
    assert_eq!(bot.workflow_id, Some(result.workflow_id));

    // Verify: workflow was created
    let wf_key =
        ai_agent_sandbox_blueprint_lib::workflows::workflow_key(result.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist after activation");
    assert!(wf.active);
    assert_eq!(wf.trigger_type, "cron");
    assert!(wf.name.contains(&bot_id));

    // Verify: workflow JSON contains sidecar info
    let wf_json: serde_json::Value = serde_json::from_str(&wf.workflow_json).unwrap();
    assert!(wf_json["sidecar_url"].as_str().is_some());
    assert!(wf_json["prompt"].as_str().unwrap().contains("Trading iteration"));

    // ── Phase 2b: Double-activate should fail ──────────────────────────────
    let err = activate_bot_with_secrets(
        &bot_id,
        serde_json::Map::new(),
        Some(mock_sandbox("sb-should-not-use")),
    )
    .await
    .unwrap_err();
    assert!(err.contains("already has secrets configured"));

    // ── Phase 3: Wipe secrets ──────────────────────────────────────────────
    let wipe_mock = mock_sandbox("sb-2phase-wiped");
    wipe_bot_secrets(&bot_id, Some(wipe_mock)).await.unwrap();

    // Verify: bot back to awaiting-secrets
    let bot = trading_blueprint_lib::state::get_bot(&bot_id)
        .unwrap()
        .unwrap();
    assert!(!bot.trading_active);
    assert_eq!(bot.sandbox_id, "sb-2phase-wiped");
    assert_eq!(bot.workflow_id, None);

    // Verify: workflow was removed
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap();
    assert!(wf.is_none(), "workflow should be removed after wipe");

    // ── Phase 3b: Double-wipe should fail ──────────────────────────────────
    let err = wipe_bot_secrets(&bot_id, Some(mock_sandbox("sb-should-not-use")))
        .await
        .unwrap_err();
    assert!(err.contains("no secrets to wipe"));

    // ── Phase 4: Re-activate (round-trip) ──────────────────────────────────
    let mut new_env = serde_json::Map::new();
    new_env.insert(
        "ANTHROPIC_API_KEY".into(),
        serde_json::Value::String("sk-new-key".to_string()),
    );

    let reactivate_mock = mock_sandbox("sb-2phase-reactivated");
    let result2 = activate_bot_with_secrets(&bot_id, new_env, Some(reactivate_mock))
        .await
        .unwrap();

    let bot = trading_blueprint_lib::state::get_bot(&bot_id)
        .unwrap()
        .unwrap();
    assert!(bot.trading_active);
    assert_eq!(bot.sandbox_id, "sb-2phase-reactivated");
    assert!(result2.workflow_id > 0);
}

// ---------------------------------------------------------------------------
// Part 3: Multi-strategy provision tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_provision_all_strategy_types() {
    let _dir = common::init_test_env();

    for strategy in &["dex", "yield", "perp", "prediction", "multi"] {
        let sb_id = format!("sb-strategy-{strategy}");
        let sandbox = mock_sandbox(&sb_id);
        let request = make_provision_request(&format!("{strategy}-bot"), strategy);
        let output = provision_core(
            request,
            Some(sandbox),
            0,
            0,
            "0xSTRATCALLER".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(output.workflow_id, 0);
        let bot = find_bot_by_sandbox(&sb_id).unwrap();
        assert_eq!(bot.strategy_type, *strategy);
    }
}

#[tokio::test]
async fn test_activate_each_strategy_gets_correct_pack_profile() {
    let _dir = common::init_test_env();

    for strategy in &["dex", "yield", "perp", "prediction"] {
        let sb_id = format!("sb-packtest-{strategy}");
        let sandbox = mock_sandbox(&sb_id);
        let request = make_provision_request(&format!("pack-{strategy}"), strategy);
        let _output = provision_core(
            request,
            Some(sandbox),
            0,
            0,
            "0xPACKCALLER".to_string(),
            None,
        )
        .await
        .unwrap();

        let bot = find_bot_by_sandbox(&sb_id).unwrap();

        // Activate to verify workflow creation uses correct pack
        let mut env = serde_json::Map::new();
        env.insert(
            "ANTHROPIC_API_KEY".into(),
            serde_json::Value::String("sk-test".to_string()),
        );

        let mock = mock_sandbox(&format!("sb-packtest-{strategy}-active"));
        let result = activate_bot_with_secrets(&bot.id, env, Some(mock))
            .await
            .unwrap();

        assert!(result.workflow_id > 0);

        // Verify workflow has correct prompt content
        let wf_key =
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(result.workflow_id);
        let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
            .unwrap()
            .get(&wf_key)
            .unwrap()
            .expect("workflow should exist");

        let wf_json: serde_json::Value =
            serde_json::from_str(&wf.workflow_json).unwrap();
        let prompt = wf_json["prompt"].as_str().unwrap();
        assert!(
            prompt.contains("Trading iteration") || prompt.contains("trading"),
            "Workflow prompt for {strategy} should contain trading context, got: {}",
            &prompt[..prompt.len().min(100)]
        );
    }
}

#[tokio::test]
async fn test_strategy_specific_cron_defaults() {
    // Prediction pack uses 15-minute intervals
    let prediction_pack = packs::get_pack("prediction").unwrap();
    assert_eq!(prediction_pack.default_cron, "0 */15 * * * *");

    // DEX pack uses 5-minute intervals
    let dex_pack = packs::get_pack("dex").unwrap();
    assert!(
        dex_pack.default_cron.contains("*/5") || dex_pack.default_cron.contains("*/10"),
        "DEX should have 5 or 10 minute cron, got: {}",
        dex_pack.default_cron
    );
}

// ---------------------------------------------------------------------------
// Part 5a: Edge case tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_provision_empty_name_still_works() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-empty-name-1");
    let request = make_provision_request("", "dex");
    let output = provision_core(
        request,
        Some(sandbox),
        0,
        0,
        "0xCALLER".to_string(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(output.workflow_id, 0);
    let bot = find_bot_by_sandbox("sb-empty-name-1").unwrap();
    assert!(!bot.id.is_empty(), "bot_id should be generated even with empty name");
}

#[tokio::test]
async fn test_provision_empty_strategy_config() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-empty-cfg-1");
    let mut request = make_provision_request("empty-cfg-bot", "dex");
    request.strategy_config_json = String::new();
    request.risk_params_json = String::new();

    let output = provision_core(
        request,
        Some(sandbox),
        0,
        0,
        "0xCALLER".to_string(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(output.workflow_id, 0);
    let bot = find_bot_by_sandbox("sb-empty-cfg-1").unwrap();
    // Empty string → serde_json::from_str("").unwrap_or_default() → Value::Null
    // This verifies provision doesn't panic on empty config
    assert!(
        bot.strategy_config.is_null() || bot.strategy_config.is_object(),
        "strategy_config should be null (default) or object, got: {}",
        bot.strategy_config
    );
}

#[tokio::test]
async fn test_configure_nonexistent_sandbox_fails() {
    let _dir = common::init_test_env();

    let result = configure_core("nonexistent-sandbox-xyz", r#"{"a":1}"#, "").await;
    assert!(result.is_err(), "configure with bad sandbox_id should fail");
}

#[tokio::test]
async fn test_start_nonexistent_sandbox_fails() {
    let _dir = common::init_test_env();

    let result = start_core("nonexistent-sandbox-xyz", true).await;
    assert!(result.is_err(), "start with bad sandbox_id should fail");
}

#[tokio::test]
async fn test_stop_already_stopped_bot() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-stop-idem-1";
    let bot_id = "trading-stop-idem-1";
    let wf_id = 33333u64;

    let mut bot = fixtures::seed_bot_record(bot_id, sandbox_id, "dex", "0xII", Some(wf_id));
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    // Stop once
    let _ = stop_core(sandbox_id, true).await.unwrap();
    let bot_after = find_bot_by_sandbox(sandbox_id).unwrap();
    assert!(!bot_after.trading_active);

    // Stop again — should succeed idempotently (or at least not crash)
    let result = stop_core(sandbox_id, true).await;
    // Could succeed or error but should not panic
    let _ = result;
}

#[tokio::test]
async fn test_deprovision_already_deprovisioned_fails() {
    let _dir = common::init_test_env();

    let sandbox_id = "sb-deprov-dup-1";
    let bot_id = "trading-deprov-dup-1";
    let wf_id = 44444u64;

    fixtures::seed_bot_record(bot_id, sandbox_id, "yield", "0xDD", Some(wf_id));
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    // First deprovision succeeds
    let response = deprovision_core(sandbox_id, true, None).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "deprovisioned");

    // Second deprovision should fail (bot record gone)
    let result = deprovision_core(sandbox_id, true, None).await;
    assert!(result.is_err(), "second deprovision should fail");
}

#[tokio::test]
async fn test_concurrent_provision_unique_ids() {
    let _dir = common::init_test_env();

    let mut handles = Vec::new();
    for i in 0..5 {
        let sandbox = mock_sandbox(&format!("sb-concurrent-{i}"));
        let request = make_provision_request(&format!("concurrent-{i}"), "dex");
        handles.push(tokio::spawn(async move {
            provision_core(
                request,
                Some(sandbox),
                700 + i as u64,
                0,
                format!("0xCALLER{i}"),
                None,
            )
            .await
            .unwrap()
        }));
    }

    let mut sandbox_ids = std::collections::HashSet::new();
    for handle in handles {
        let output = handle.await.unwrap();
        assert!(!output.sandbox_id.is_empty());
        sandbox_ids.insert(output.sandbox_id);
    }

    assert_eq!(
        sandbox_ids.len(),
        5,
        "all 5 provisions should have unique sandbox IDs"
    );
}
