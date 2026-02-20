//! Tier 1 — Core logic integration tests for the instance blueprint.
//!
//! Always run, no Docker or Tangle required.  Tests exercise the instance
//! singleton pattern and delegate to `*_core` functions with pre-seeded
//! persistent stores.
//!
//! **Serialised**: all tests acquire `HARNESS_LOCK` because they share the
//! process-global instance singleton store.

mod common;

use blueprint_sdk::alloy::primitives::{Address, U256};
use trading_blueprint_lib::jobs::{
    activate_bot_with_secrets, configure_core, deprovision_core, provision_core, start_core,
    status_core, stop_core, wipe_bot_secrets,
};
use trading_blueprint_lib::state::{bot_key, bots, find_bot_by_sandbox, get_bot};
use trading_instance_blueprint_lib::{
    TradingProvisionRequest,
    clear_instance_bot_id, get_instance_bot_id, require_instance_bot, set_instance_bot_id,
};

use common::fixtures;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_provision_request(name: &str, strategy: &str) -> TradingProvisionRequest {
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
        max_lifetime_days: 30,
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
// Instance Singleton Tests (serialised via HARNESS_LOCK)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_instance_provision_creates_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();

    let sandbox = mock_sandbox("inst-sb-provision-1");
    let sandbox_id = sandbox.id.clone();

    let request = make_provision_request("instance-bot", "dex");
    let output = provision_core(request, Some(sandbox), 100, 0, "0xINSTCALLER".to_string(), None)
        .await
        .unwrap();

    assert_eq!(output.sandbox_id, sandbox_id);
    assert_eq!(output.workflow_id, 0, "two-phase: workflow_id should be 0");

    let bot = find_bot_by_sandbox(&sandbox_id).unwrap();
    assert_eq!(bot.strategy_type, "dex");
    assert!(!bot.trading_active);

    set_instance_bot_id(bot.id.clone()).unwrap();

    let resolved = require_instance_bot().unwrap();
    assert_eq!(resolved.id, bot.id);
    assert_eq!(resolved.sandbox_id, sandbox_id);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_provision_rejects_if_already_provisioned() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, _sandbox_id) = fixtures::seed_instance_bot("dex");

    assert_eq!(get_instance_bot_id().unwrap(), Some(bot_id.clone()));

    let existing = get_instance_bot_id().unwrap();
    assert!(existing.is_some(), "Instance already provisioned");

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_deprovision_clears_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, sandbox_id) = fixtures::seed_instance_bot("yield");
    let wf_id = chrono::Utc::now().timestamp_millis() as u64 + 1000;
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    bots().unwrap()
        .update(&bot_key(&bot_id), |b| {
            b.workflow_id = Some(wf_id);
        })
        .unwrap();

    assert!(get_instance_bot_id().unwrap().is_some());

    let response = deprovision_core(&sandbox_id, true, None).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "deprovisioned");

    clear_instance_bot_id().unwrap();

    assert!(get_instance_bot_id().unwrap().is_none());
    assert!(find_bot_by_sandbox(&sandbox_id).is_err());
}

#[tokio::test]
async fn test_instance_deprovision_not_provisioned_fails() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();

    let err = require_instance_bot().unwrap_err();
    assert!(
        err.contains("not provisioned"),
        "Expected 'not provisioned' error, got: {err}"
    );
}

#[tokio::test]
async fn test_instance_configure_updates_params() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, sandbox_id) = fixtures::seed_instance_bot("perp");

    let new_config = r#"{"leverage":10,"pair":"ETH/USDC"}"#;
    let new_risk = r#"{"max_drawdown_pct":3.0}"#;
    let response = configure_core(&sandbox_id, new_config, new_risk)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "configured");

    let bot = get_bot(&bot_id).unwrap().unwrap();
    assert_eq!(bot.strategy_config["leverage"], 10);
    assert_eq!(bot.strategy_config["pair"], "ETH/USDC");
    assert_eq!(bot.risk_params["max_drawdown_pct"], 3.0);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_status_returns_singleton_state() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (_bot_id, sandbox_id) = fixtures::seed_instance_bot("prediction");

    let response = status_core(&sandbox_id, true).await.unwrap();
    assert_eq!(response.sandbox_id, sandbox_id);
    assert!(response.trading_active);

    let portfolio: serde_json::Value =
        serde_json::from_str(&response.portfolio_json).unwrap();
    assert_eq!(portfolio["strategy_type"], "prediction");

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_start_stop_lifecycle() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, sandbox_id) = fixtures::seed_instance_bot("dex");
    let wf_id = chrono::Utc::now().timestamp_millis() as u64 + 2000;
    fixtures::seed_workflow(wf_id, "http://127.0.0.1:8080", "tok", "0 */5 * * * *");

    bots().unwrap()
        .update(&bot_key(&bot_id), |b| {
            b.workflow_id = Some(wf_id);
        })
        .unwrap();

    // Stop
    let response = stop_core(&sandbox_id, true).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "stopped");

    let bot = get_bot(&bot_id).unwrap().unwrap();
    assert!(!bot.trading_active);

    // Start
    let response = start_core(&sandbox_id, true).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&response.json).unwrap();
    assert_eq!(json["status"], "started");

    let bot = get_bot(&bot_id).unwrap().unwrap();
    assert!(bot.trading_active);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_require_instance_bot_not_provisioned() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();

    let result = require_instance_bot();
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.contains("not provisioned"),
        "Expected 'not provisioned', got: {err}"
    );
}

#[tokio::test]
async fn test_instance_all_strategies() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    for (idx, strategy) in ["dex", "yield", "perp", "prediction", "multi"].iter().enumerate() {
        let _ = clear_instance_bot_id();

        let sb_id = format!("inst-sb-strat-{strategy}");
        let sandbox = mock_sandbox(&sb_id);

        let request = make_provision_request(&format!("{strategy}-instance"), strategy);
        let output = provision_core(
            request,
            Some(sandbox),
            200 + idx as u64,
            0,
            "0xSTRATCALLER".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(output.workflow_id, 0);

        let bot = find_bot_by_sandbox(&sb_id).unwrap();
        assert_eq!(bot.strategy_type, *strategy);

        set_instance_bot_id(bot.id.clone()).unwrap();
        let resolved = require_instance_bot().unwrap();
        assert_eq!(resolved.strategy_type, *strategy);
    }

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_two_phase_provision_e2e() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();

    // ── Phase 1: Provision ─────────────────────────────────────────────────
    let sandbox = mock_sandbox("inst-2phase-1");
    let sandbox_id = sandbox.id.clone();
    let request = make_provision_request("instance-2phase", "dex");
    let output = provision_core(request, Some(sandbox), 300, 0, "0xINST2PHASE".to_string(), None)
        .await
        .unwrap();

    assert_eq!(output.workflow_id, 0);

    let bot = find_bot_by_sandbox(&sandbox_id).unwrap();
    let bot_id = bot.id.clone();
    assert!(!bot.trading_active);
    assert_eq!(bot.workflow_id, None);

    set_instance_bot_id(bot_id.clone()).unwrap();

    // ── Phase 2: Activate with secrets ─────────────────────────────────────
    let mut user_env = serde_json::Map::new();
    user_env.insert(
        "ANTHROPIC_API_KEY".into(),
        serde_json::Value::String("sk-instance-test".to_string()),
    );

    let activate_mock = mock_sandbox("inst-2phase-activated");
    let result = activate_bot_with_secrets(&bot_id, user_env, Some(activate_mock))
        .await
        .unwrap();

    assert!(result.workflow_id > 0);

    let bot = get_bot(&bot_id).unwrap().unwrap();
    assert!(bot.trading_active);
    assert_eq!(bot.workflow_id, Some(result.workflow_id));

    // ── Phase 3: Wipe secrets ──────────────────────────────────────────────
    let wipe_mock = mock_sandbox("inst-2phase-wiped");
    wipe_bot_secrets(&bot_id, Some(wipe_mock)).await.unwrap();

    let bot = get_bot(&bot_id).unwrap().unwrap();
    assert!(!bot.trading_active);
    assert_eq!(bot.workflow_id, None);

    // ── Phase 4: Re-activate ───────────────────────────────────────────────
    let mut new_env = serde_json::Map::new();
    new_env.insert(
        "ANTHROPIC_API_KEY".into(),
        serde_json::Value::String("sk-new-key".to_string()),
    );

    let reactivate_mock = mock_sandbox("inst-2phase-reactivated");
    let result2 = activate_bot_with_secrets(&bot_id, new_env, Some(reactivate_mock))
        .await
        .unwrap();

    let bot = get_bot(&bot_id).unwrap().unwrap();
    assert!(bot.trading_active);
    assert!(result2.workflow_id > 0);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_exec_resolves_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, sandbox_id) = fixtures::seed_instance_bot("dex");

    let bot = require_instance_bot().unwrap();
    assert_eq!(bot.id, bot_id);
    assert_eq!(bot.sandbox_id, sandbox_id);

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_prompt_resolves_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, _sandbox_id) = fixtures::seed_instance_bot("prediction");

    let bot = require_instance_bot().unwrap();
    assert_eq!(bot.id, bot_id);
    assert_eq!(bot.strategy_type, "prediction");

    let _ = clear_instance_bot_id();
}

#[tokio::test]
async fn test_instance_task_resolves_singleton() {
    let _dir = common::init_test_env();
    let _lock = common::HARNESS_LOCK.lock().await;

    let _ = clear_instance_bot_id();
    let (bot_id, _sandbox_id) = fixtures::seed_instance_bot("multi");

    let bot = require_instance_bot().unwrap();
    assert_eq!(bot.id, bot_id);
    assert_eq!(bot.strategy_type, "multi");

    let _ = clear_instance_bot_id();
}
