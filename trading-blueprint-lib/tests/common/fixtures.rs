use trading_blueprint_lib::state::{TradingBotRecord, bot_key, bots};
use trading_blueprint_lib::SandboxRecord;

/// Seed a `SandboxRecord` into the sandbox store.
pub fn seed_sandbox_record(id: &str, sidecar_url: &str, token: &str) -> SandboxRecord {
    let record = SandboxRecord {
        id: id.to_string(),
        container_id: format!("container-{id}"),
        sidecar_url: sidecar_url.to_string(),
        sidecar_port: 8080,
        ssh_port: None,
        token: token.to_string(),
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
        tee_config: None,
    };
    record
}

/// Seed a `TradingBotRecord` into the bots store.
pub fn seed_bot_record(
    bot_id: &str,
    sandbox_id: &str,
    strategy_type: &str,
    vault_address: &str,
    workflow_id: Option<u64>,
) -> TradingBotRecord {
    let record = TradingBotRecord {
        id: bot_id.to_string(),
        sandbox_id: sandbox_id.to_string(),
        vault_address: vault_address.to_string(),
        share_token: String::new(),
        strategy_type: strategy_type.to_string(),
        strategy_config: serde_json::json!({"max_slippage": 0.5}),
        risk_params: serde_json::json!({"max_position_pct": 10.0, "max_drawdown_pct": 5.0}),
        chain_id: 31337,
        rpc_url: "http://localhost:8545".to_string(),
        trading_api_url: "http://localhost:9100".to_string(),
        trading_api_token: "test-token".to_string(),
        workflow_id,
        trading_active: true,
        created_at: chrono::Utc::now().timestamp() as u64,
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
    bots()
        .expect("bots store")
        .insert(bot_key(bot_id), record.clone())
        .expect("insert bot");
    record
}

/// Seed a `WorkflowEntry` into the workflow store.
pub fn seed_workflow(
    workflow_id: u64,
    sidecar_url: &str,
    token: &str,
    cron: &str,
) -> ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
    let workflow_json = serde_json::json!({
        "sidecar_url": sidecar_url,
        "prompt": "trading loop iteration",
        "session_id": format!("wf-{workflow_id}"),
        "max_turns": 10,
        "timeout_ms": 120_000,
        "sidecar_token": token,
    })
    .to_string();

    let next_run =
        ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run("cron", cron, None)
            .unwrap_or(None);

    let entry = ai_agent_sandbox_blueprint_lib::workflows::WorkflowEntry {
        id: workflow_id,
        name: format!("trading-loop-{workflow_id}"),
        workflow_json,
        trigger_type: "cron".to_string(),
        trigger_config: cron.to_string(),
        sandbox_config_json: String::new(),
        active: true,
        next_run_at: next_run,
        last_run_at: None,
        owner: String::new(),
    };

    ai_agent_sandbox_blueprint_lib::workflows::workflows()
        .expect("workflows store")
        .insert(
            ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id),
            entry.clone(),
        )
        .expect("insert workflow");

    entry
}

/// Seed a complete trading bot with sandbox, bot record, and workflow.
/// Returns `(bot_id, sandbox_id, workflow_id)`.
pub fn seed_full_bot(
    strategy_type: &str,
    sidecar_url: &str,
) -> (String, String, u64) {
    let sandbox_id = format!("sandbox-{}", uuid::Uuid::new_v4());
    let bot_id = format!("trading-{}", uuid::Uuid::new_v4());
    let workflow_id = chrono::Utc::now().timestamp() as u64;
    let token = "test-token";

    seed_sandbox_record(&sandbox_id, sidecar_url, token);
    seed_bot_record(&bot_id, &sandbox_id, strategy_type, "0xAABBCCDD", Some(workflow_id));
    seed_workflow(workflow_id, sidecar_url, token, "0 */5 * * * *");

    (bot_id, sandbox_id, workflow_id)
}
