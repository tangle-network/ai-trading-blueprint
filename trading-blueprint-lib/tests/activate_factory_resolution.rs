mod common;

use axum::{Json, Router, routing::post};
use blueprint_sdk::alloy::primitives::{Address, U256};
use blueprint_sdk::alloy::sol_types::SolValue;
use trading_blueprint_lib::TradingProvisionRequest;
use trading_blueprint_lib::jobs::{activate_bot_with_secrets, provision_core};
use trading_blueprint_lib::state::find_bot_by_sandbox;

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
        max_lifetime_seconds: 86_400,
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
        service_id: None,
        tee_config: None,
        extra_ports: std::collections::HashMap::new(),
        ssh_login_user: None,
        ssh_authorized_keys: Vec::new(),
        tee_attestation_json: None,
        capabilities_json: String::new(),
    }
}

fn make_provision_request(
    name: &str,
    strategy_config_json: &str,
    rpc_url: String,
) -> TradingProvisionRequest {
    TradingProvisionRequest {
        name: name.to_string(),
        strategy_type: "prediction".to_string(),
        strategy_config_json: strategy_config_json.to_string(),
        risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
        factory_address: Address::from([0xBB; 20]),
        asset_token: Address::from([0xCC; 20]),
        signers: vec![Address::from([0x01; 20]), Address::from([0x02; 20])],
        required_signatures: U256::from(2),
        chain_id: U256::from(31337),
        rpc_url,
        trading_loop_cron: "0 */5 * * * *".to_string(),
        cpu_cores: 2,
        memory_mb: 4096,
        max_lifetime_days: 0,
        validator_service_ids: vec![],
        max_collateral_bps: U256::from(0),
    }
}

async fn spawn_mock_factory_rpc() -> String {
    let app = Router::new().route(
        "/",
        post(|Json(payload): Json<serde_json::Value>| async move {
            let empty_vaults = Vec::<Address>::new();
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": payload.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "result": format!("0x{}", hex::encode(SolValue::abi_encode(&empty_vaults))),
            }))
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock factory rpc");
    let addr = listener.local_addr().expect("mock factory rpc addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve mock factory rpc");
    });
    format!("http://{addr}")
}

async fn spawn_reverting_factory_rpc() -> String {
    let app = Router::new().route(
        "/",
        post(|Json(payload): Json<serde_json::Value>| async move {
            Json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": payload.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "error": {
                    "code": 3,
                    "message": "execution reverted",
                    "data": "0x"
                },
            }))
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind reverting mock factory rpc");
    let addr = listener
        .local_addr()
        .expect("reverting mock factory rpc addr");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve reverting mock factory rpc");
    });
    format!("http://{addr}")
}

fn activation_env(secret: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut env = serde_json::Map::new();
    env.insert(
        "ANTHROPIC_API_KEY".into(),
        serde_json::Value::String(secret.to_string()),
    );
    env
}

#[tokio::test]
async fn test_activate_paper_trade_bot_allows_unresolved_factory_vault() {
    let _dir = common::init_test_env();
    unsafe {
        std::env::set_var("ALLOW_LOOPBACK_RPC_URLS", "true");
    }

    let rpc_url = spawn_mock_factory_rpc().await;
    let output = provision_core(
        make_provision_request("paper-factory-bot", r#"{"paper_trade":true}"#, rpc_url),
        Some(mock_sandbox("sb-paper-factory")),
        42,
        7,
        "0xPAPERCALLER".to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(output.workflow_id, 0);

    let bot = find_bot_by_sandbox("sb-paper-factory").unwrap();
    let placeholder_vault = bot.vault_address.clone();
    assert!(bot.paper_trade);
    assert!(placeholder_vault.starts_with("factory:"));

    let activated = activate_bot_with_secrets(
        &bot.id,
        activation_env("sk-paper-key"),
        Some(mock_sandbox("sb-paper-active")),
    )
    .await
    .unwrap();

    let updated = trading_blueprint_lib::state::get_bot(&bot.id)
        .unwrap()
        .unwrap();
    assert!(updated.trading_active);
    assert_eq!(updated.sandbox_id, "sb-paper-active");
    assert_eq!(updated.workflow_id, Some(activated.workflow_id));
    assert_eq!(updated.vault_address, placeholder_vault);
}

#[tokio::test]
async fn test_activate_live_bot_still_fails_with_unresolved_factory_vault() {
    let _dir = common::init_test_env();
    unsafe {
        std::env::set_var("ALLOW_LOOPBACK_RPC_URLS", "true");
    }

    let rpc_url = spawn_mock_factory_rpc().await;
    let output = provision_core(
        make_provision_request("live-factory-bot", r#"{"paper_trade":false}"#, rpc_url),
        Some(mock_sandbox("sb-live-factory")),
        43,
        8,
        "0xLIVECALLER".to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(output.workflow_id, 0);

    let bot = find_bot_by_sandbox("sb-live-factory").unwrap();
    assert!(!bot.paper_trade);
    assert!(bot.vault_address.starts_with("factory:"));

    let err = activate_bot_with_secrets(
        &bot.id,
        activation_env("sk-live-key"),
        Some(mock_sandbox("sb-live-active")),
    )
    .await
    .unwrap_err();

    assert!(err.contains("Failed to resolve vault from factory"));
    assert!(err.contains("No vaults found for this service"));
    assert!(err.contains("Refusing to trade with unresolved vault address"));
}

#[tokio::test]
async fn test_activate_paper_trade_bot_allows_reverting_factory_lookup() {
    let _dir = common::init_test_env();
    unsafe {
        std::env::set_var("ALLOW_LOOPBACK_RPC_URLS", "true");
    }

    let rpc_url = spawn_reverting_factory_rpc().await;
    let output = provision_core(
        make_provision_request(
            "paper-factory-revert-bot",
            r#"{"paper_trade":true}"#,
            rpc_url,
        ),
        Some(mock_sandbox("sb-paper-revert-factory")),
        44,
        9,
        "0xPAPERREVERTCALLER".to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(output.workflow_id, 0);

    let bot = find_bot_by_sandbox("sb-paper-revert-factory").unwrap();
    let placeholder_vault = bot.vault_address.clone();
    assert!(bot.paper_trade);
    assert!(placeholder_vault.starts_with("factory:"));

    let activated = activate_bot_with_secrets(
        &bot.id,
        activation_env("sk-paper-revert-key"),
        Some(mock_sandbox("sb-paper-revert-active")),
    )
    .await
    .unwrap();

    let updated = trading_blueprint_lib::state::get_bot(&bot.id)
        .unwrap()
        .unwrap();
    assert!(updated.trading_active);
    assert_eq!(updated.sandbox_id, "sb-paper-revert-active");
    assert_eq!(updated.workflow_id, Some(activated.workflow_id));
    assert_eq!(updated.vault_address, placeholder_vault);
}
