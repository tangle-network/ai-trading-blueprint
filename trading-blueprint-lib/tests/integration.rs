//! Tier 1 — Core logic integration tests.
//!
//! Always run, no Docker or Tangle required.  Tests exercise the `*_core`
//! functions directly with pre-seeded persistent stores.

mod common;

use blueprint_sdk::alloy::primitives::{Address, U256};
use blueprint_sdk::alloy::sol_types::SolValue;
use trading_blueprint_lib::jobs::{
    configure_core, deprovision_core, extend_core, provision_core, start_core, status_core,
    stop_core,
};
use trading_blueprint_lib::prompts::{
    build_generic_agent_profile, build_loop_prompt, build_pack_agent_profile,
    build_pack_loop_prompt, build_pack_system_prompt, build_system_prompt, packs,
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
        env_json: String::new(),
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
        env_json: "{}".to_string(),
        snapshot_destination: None,
        tee_deployment_id: None,
        tee_metadata_json: None,
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
    let output = provision_core(request, Some(sandbox)).await.unwrap();

    assert_eq!(output.sandbox_id, sandbox_id);
    assert!(output.workflow_id > 0);
    assert_eq!(output.vault_address, Address::from([0xBB; 20]));

    // Verify bot record was stored
    let bot = find_bot_by_sandbox(&sandbox_id).unwrap();
    assert_eq!(bot.sandbox_id, sandbox_id);
    assert_eq!(bot.strategy_type, "dex");
    assert!(bot.trading_active);
    assert_eq!(bot.chain_id, 31337);
    assert_eq!(bot.workflow_id, Some(output.workflow_id));

    // Verify workflow was stored
    let wf_key =
        ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");
    assert!(wf.active);
    assert_eq!(wf.trigger_type, "cron");
    assert_eq!(wf.trigger_config, "0 */5 * * * *");
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

    let response = deprovision_core(sandbox_id, true).await.unwrap();
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

    // 1. Provision
    let sandbox = mock_sandbox("sb-lifecycle-1");
    let sandbox_id = sandbox.id.clone();
    let request = make_provision_request("lifecycle-bot", "multi");
    let output = provision_core(request, Some(sandbox)).await.unwrap();
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
    let deprov_result = deprovision_core(&sandbox_id, true).await.unwrap();
    assert!(deprov_result.json.contains("deprovisioned"));
    assert!(find_bot_by_sandbox(&sandbox_id).is_err());
}

#[tokio::test]
async fn test_workflow_created_with_cron() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-cron-1");
    let request = make_provision_request("cron-bot", "dex");
    let output = provision_core(request, Some(sandbox)).await.unwrap();

    let wf_key =
        ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");

    assert!(wf.active);
    assert_eq!(wf.trigger_config, "0 */5 * * * *");
    assert!(wf.next_run_at.is_some());
    assert!(wf.last_run_at.is_none());
    assert!(wf.name.contains("trading-loop-"));
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
    let _output = provision_core(request, Some(sandbox)).await.unwrap();

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
    let _output = provision_core(request, Some(sandbox)).await.unwrap();

    let bot = find_bot_by_sandbox("sb-lifetime-90").unwrap();
    assert_eq!(bot.max_lifetime_days, 90);
}

#[tokio::test]
async fn test_provision_defaults_to_30_days() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-lifetime-default");
    let request = make_provision_request_with_lifetime("default-bot", "dex", 0);
    let _output = provision_core(request, Some(sandbox)).await.unwrap();

    let bot = find_bot_by_sandbox("sb-lifetime-default").unwrap();
    assert_eq!(bot.max_lifetime_days, 30);
}

#[tokio::test]
async fn test_extend_increases_lifetime() {
    let _dir = common::init_test_env();

    // Provision with 30 days
    let sandbox = mock_sandbox("sb-extend-1");
    let request = make_provision_request_with_lifetime("extend-bot", "dex", 30);
    let _output = provision_core(request, Some(sandbox)).await.unwrap();

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
async fn test_provision_with_pack_creates_rich_workflow() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-pack-prediction");
    let request = make_provision_request("pack-bot", "prediction");
    let output = provision_core(request, Some(sandbox)).await.unwrap();

    // Verify workflow_json contains backend_profile_json with agent profile
    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");

    let wf_json: serde_json::Value = serde_json::from_str(&wf.workflow_json).unwrap();

    // Should NOT have legacy system_prompt
    assert!(
        wf_json.get("system_prompt").is_none(),
        "workflow should not have legacy system_prompt"
    );

    // Should have backend_profile_json
    let profile_str = wf_json["backend_profile_json"]
        .as_str()
        .expect("should have backend_profile_json");
    let profile: serde_json::Value = serde_json::from_str(profile_str).unwrap();

    // Profile uses resources.instructions, not systemPrompt
    assert!(
        profile.get("systemPrompt").is_none(),
        "profile should not set systemPrompt directly"
    );
    let instructions = profile["resources"]["instructions"]["content"]
        .as_str()
        .expect("profile should have resources.instructions.content");
    assert!(
        instructions.contains("gamma-api.polymarket.com"),
        "instructions should contain Polymarket Gamma API URL"
    );
    assert!(
        instructions.contains("clob.polymarket.com"),
        "instructions should contain Polymarket CLOB API URL"
    );
    assert!(
        instructions.contains("/validate"),
        "instructions should contain base Trading HTTP API endpoints"
    );
    assert!(
        instructions.contains("persistent workspace"),
        "instructions should contain workspace awareness"
    );

    // Profile has permissions and memory
    assert_eq!(profile["permission"]["bash"], "allow");
    assert_eq!(profile["memory"]["enabled"], true);

    // Loop prompt should reference the pack name
    let loop_prompt = wf_json["prompt"].as_str().unwrap();
    assert!(loop_prompt.contains("Polymarket Prediction Trading"));

    // Pack overrides
    assert_eq!(wf_json["max_turns"], 20);
    assert_eq!(wf_json["timeout_ms"], 240_000);
}

#[tokio::test]
async fn test_provision_without_pack_uses_generic_prompt() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-pack-unknown");
    let request = make_provision_request("generic-bot", "exotic");
    let output = provision_core(request, Some(sandbox)).await.unwrap();

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");

    let wf_json: serde_json::Value = serde_json::from_str(&wf.workflow_json).unwrap();
    // No legacy system_prompt
    assert!(
        wf_json.get("system_prompt").is_none(),
        "workflow should not have legacy system_prompt"
    );

    // Should still have backend_profile_json even for unknown strategy types
    let profile_str = wf_json["backend_profile_json"]
        .as_str()
        .expect("generic strategy should still get a backend_profile_json");
    let profile: serde_json::Value = serde_json::from_str(profile_str).unwrap();
    let instructions = profile["resources"]["instructions"]["content"]
        .as_str()
        .expect("generic profile should have instructions");
    assert!(
        instructions.contains("persistent workspace"),
        "generic profile should have workspace awareness"
    );
    assert!(
        instructions.contains("multi-strategy"),
        "generic profile should contain multi-strategy fragment"
    );

    // Generic loop prompt
    let prompt = wf_json["prompt"].as_str().unwrap();
    assert!(prompt.contains("exotic"));
    assert!(prompt.contains("trading loop iteration"));

    // Default max_turns and timeout
    assert_eq!(wf_json["max_turns"], 10);
    assert_eq!(wf_json["timeout_ms"], 120_000);
}

#[tokio::test]
async fn test_provision_pack_uses_default_cron() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-pack-cron");
    let mut request = make_provision_request("cron-pack-bot", "prediction");
    request.trading_loop_cron = String::new(); // Empty — should use pack default

    let output = provision_core(request, Some(sandbox)).await.unwrap();

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");

    // Polymarket pack default cron: every 3 minutes
    assert_eq!(wf.trigger_config, "0 */3 * * * *");
}

#[tokio::test]
async fn test_pack_system_prompt_includes_base_config() {
    let pack = packs::get_pack("prediction").unwrap();
    let config = trading_blueprint_lib::state::TradingBotRecord {
        id: "test".to_string(),
        sandbox_id: "sb".to_string(),
        vault_address: "0xTEST_VAULT".to_string(),
        share_token: String::new(),
        strategy_type: "prediction".to_string(),
        strategy_config: serde_json::json!({}),
        risk_params: serde_json::json!({"max_drawdown_pct": 10}),
        chain_id: 137,
        rpc_url: "http://polygon-rpc".to_string(),
        trading_api_url: "http://my-api:9100".to_string(),
        trading_api_token: "bearer-xyz".to_string(),
        workflow_id: None,
        trading_active: true,
        created_at: 0,
        operator_address: String::new(),
        validator_service_ids: vec![],
        max_lifetime_days: 30,
        paper_trade: true,
        wind_down_started_at: None,
    };

    let combined = build_pack_system_prompt(&pack, &config);

    // Should contain base Trading HTTP API config
    assert!(combined.contains("http://my-api:9100"), "Should contain trading API URL");
    assert!(combined.contains("bearer-xyz"), "Should contain bearer token");
    assert!(combined.contains("0xTEST_VAULT"), "Should contain vault address");
    assert!(combined.contains("137"), "Should contain chain ID");

    // Should contain expert Polymarket knowledge
    assert!(combined.contains("gamma-api.polymarket.com"), "Should contain Gamma API");
    assert!(combined.contains("half-Kelly"), "Should contain Kelly criterion");
    assert!(combined.contains("Expert Strategy Instructions"), "Should have section header");
}

// ---------------------------------------------------------------------------
// Agent Profile tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_provision_creates_backend_profile() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-profile-1");
    let request = make_provision_request("profile-bot", "dex");
    let output = provision_core(request, Some(sandbox)).await.unwrap();

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");

    let wf_json: serde_json::Value = serde_json::from_str(&wf.workflow_json).unwrap();

    // Must have backend_profile_json
    let profile_str = wf_json["backend_profile_json"]
        .as_str()
        .expect("workflow must have backend_profile_json");
    let profile: serde_json::Value = serde_json::from_str(profile_str).unwrap();

    // Profile has resources.instructions
    let instructions = profile["resources"]["instructions"]["content"]
        .as_str()
        .expect("profile must have resources.instructions.content");
    assert!(instructions.contains("Uniswap V3"));
    assert!(instructions.contains("persistent workspace"));
    assert!(instructions.contains("/home/agent/"));
}

#[tokio::test]
async fn test_provision_no_system_prompt_in_workflow() {
    let _dir = common::init_test_env();

    // Test all known pack types
    for strategy in &["prediction", "dex", "yield", "perp"] {
        let sandbox = mock_sandbox(&format!("sb-no-sp-{strategy}"));
        let request = make_provision_request(&format!("no-sp-{strategy}"), strategy);
        let output = provision_core(request, Some(sandbox)).await.unwrap();

        let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
        let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
            .unwrap()
            .get(&wf_key)
            .unwrap()
            .expect("workflow should exist");

        let wf_json: serde_json::Value = serde_json::from_str(&wf.workflow_json).unwrap();
        assert!(
            wf_json.get("system_prompt").is_none(),
            "strategy {strategy} should not have system_prompt in workflow_json"
        );
        assert!(
            wf_json.get("backend_profile_json").is_some(),
            "strategy {strategy} should have backend_profile_json in workflow_json"
        );
    }
}

#[tokio::test]
async fn test_provision_generic_strategy_gets_profile() {
    let _dir = common::init_test_env();

    let sandbox = mock_sandbox("sb-generic-profile");
    let request = make_provision_request("generic-profile-bot", "exotic");
    let output = provision_core(request, Some(sandbox)).await.unwrap();

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(output.workflow_id);
    let wf = ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .unwrap()
        .get(&wf_key)
        .unwrap()
        .expect("workflow should exist");

    let wf_json: serde_json::Value = serde_json::from_str(&wf.workflow_json).unwrap();
    let profile_str = wf_json["backend_profile_json"]
        .as_str()
        .expect("exotic strategy must get backend_profile_json");
    let profile: serde_json::Value = serde_json::from_str(profile_str).unwrap();

    // Generic profile has workspace awareness
    let instructions = profile["resources"]["instructions"]["content"].as_str().unwrap();
    assert!(instructions.contains("persistent workspace"));
    assert!(instructions.contains("multi-strategy"));
    // Still has permissions
    assert_eq!(profile["permission"]["bash"], "allow");
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
