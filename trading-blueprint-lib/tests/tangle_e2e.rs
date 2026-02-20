//! Tier 2 — Tangle E2E tests.
//!
//! Exercises the full BlueprintHarness → TangleLayer → Router pipeline for all
//! 6 trading blueprint jobs.  Runs real validator HTTP servers with EIP-712
//! signers and deploys the TradeValidator contract on Anvil.
//!
//! Gate: `SIDECAR_E2E=1` + Docker + TNT core artifacts + forge build artifacts.
//!
//! ```bash
//! SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_e2e -- --nocapture
//! ```

mod common;

use alloy::node_bindings::Anvil;
use alloy::network::EthereumWallet;
use alloy::primitives::{Address, U256};
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use anyhow::{Context, Result};
use blueprint_sdk::alloy::primitives::Bytes;
use tokio::time::timeout;

use trading_blueprint_lib::{
    JOB_CONFIGURE, JOB_DEPROVISION, JOB_PROVISION, JOB_START_TRADING, JOB_STATUS, JOB_STOP_TRADING,
    JsonResponse, TradingConfigureRequest, TradingControlRequest, TradingProvisionOutput,
    TradingProvisionRequest, TradingStatusResponse,
};

/// Extract raw key bytes from Anvil pre-funded accounts for validator indices.
fn validator_key_bytes(anvil: &alloy::node_bindings::AnvilInstance, indices: &[usize]) -> Vec<Vec<u8>> {
    indices.iter().map(|&i| anvil.keys()[i].to_bytes().to_vec()).collect()
}

use common::contract_deployer;
use common::validators;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_tangle_trading_lifecycle() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping tangle_e2e: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(common::ANVIL_TEST_TIMEOUT, async {
        // ── 1. Start Anvil + deploy TradeValidator ──────────────────────
        eprintln!("[setup] Starting Anvil and deploying contracts...");
        let anvil = Anvil::new().try_spawn().context("Failed to spawn Anvil")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_wallet = EthereumWallet::from(deployer_key);
        let deployer_provider = ProviderBuilder::new()
            .wallet(deployer_wallet)
            .connect_http(rpc_url.parse().unwrap());

        // Validator addresses from Anvil accounts 3,4,5
        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let (tv_addr, vault_addr) = contract_deployer::deploy_trade_validator(
            &deployer_provider,
            val_addrs.clone(),
            2, // 2-of-3 multisig
        )
        .await;
        eprintln!("        TradeValidator: {tv_addr}");
        eprintln!("        Vault: {vault_addr} (2-of-3)");

        // ── 2. Start 3 real validator HTTP servers ──────────────────────
        eprintln!("[setup] Starting 3 real validator servers...");
        let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
        let cluster = validators::start_validator_cluster(
            &val_keys,
            tv_addr,
            vault_addr,
            None, // policy-only scoring (no AI key needed)
        )
        .await;

        for (i, (endpoint, addr)) in cluster
            .endpoints
            .iter()
            .zip(cluster.validator_addresses.iter())
            .enumerate()
        {
            eprintln!("        Validator {} @ {} ({})", i + 1, endpoint, addr);
        }

        // ── 3. Set environment for Trading HTTP API ─────────────────────
        unsafe {
            std::env::set_var("TRADING_API_URL", "http://127.0.0.1:9100");
        }

        // ── 4. Set up sidecar env + spawn BlueprintHarness ──────────────
        common::setup_sidecar_env();
        let Some(harness) = common::spawn_harness().await? else {
            eprintln!("Skipping: TNT artifacts not found");
            return Ok(());
        };
        eprintln!("[setup] BlueprintHarness spawned");

        // ── 5. JOB_PROVISION (0) ────────────────────────────────────────
        eprintln!("\n[test] Submitting JOB_PROVISION...");
        let provision_payload = TradingProvisionRequest {
            name: "e2e-trading-bot".to_string(),
            strategy_type: "dex".to_string(),
            strategy_config_json: r#"{"max_slippage":0.5}"#.to_string(),
            risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
            factory_address: vault_addr,
            asset_token: Address::from([0xCC; 20]),
            signers: val_addrs.clone(),
            required_signatures: U256::from(2),
            chain_id: U256::from(31337),
            rpc_url: rpc_url.clone(),
            trading_loop_cron: "0 */5 * * * *".to_string(),
            cpu_cores: 2,
            memory_mb: 4096,
            max_lifetime_days: 30,
            validator_service_ids: vec![],
        }
        .abi_encode();

        let provision_sub = harness
            .submit_job(JOB_PROVISION, Bytes::from(provision_payload))
            .await?;
        let provision_output = harness
            .wait_for_job_result_with_deadline(provision_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let provision_receipt = TradingProvisionOutput::abi_decode(&provision_output)?;
        let sandbox_id = provision_receipt.sandbox_id.clone();

        eprintln!(
            "        sandbox_id={}, workflow_id={}, vault={}",
            sandbox_id, provision_receipt.workflow_id, provision_receipt.vault_address
        );
        assert!(!sandbox_id.is_empty(), "sandbox_id should not be empty");
        // Two-phase provisioning: workflow_id=0 means "awaiting secrets injection"
        assert_eq!(provision_receipt.workflow_id, 0, "workflow_id should be 0 (awaiting secrets)");

        // ── 6a. JOB_STATUS (4) — verify "awaiting secrets" state ──────
        eprintln!("[test] Submitting JOB_STATUS (pre-activation)...");
        let status_payload = TradingControlRequest {
            sandbox_id: sandbox_id.clone(),
        }
        .abi_encode();
        let status_sub = harness
            .submit_job(JOB_STATUS, Bytes::from(status_payload.clone()))
            .await?;
        let status_output = harness
            .wait_for_job_result_with_deadline(status_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let status_receipt = TradingStatusResponse::abi_decode(&status_output)?;

        eprintln!(
            "        state={}, trading_active={}",
            status_receipt.state, status_receipt.trading_active
        );
        // Before secrets injection, bot is inactive
        assert!(!status_receipt.trading_active, "bot should be inactive before secrets");
        assert_eq!(status_receipt.sandbox_id, sandbox_id);

        // ── 6b. Activate with secrets (HTTP API path, not on-chain) ──
        eprintln!("[test] Activating bot with mock secrets...");
        let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&sandbox_id)
            .expect("bot should exist after provision");
        let mock_sb = sandbox_runtime::SandboxRecord {
            id: sandbox_id.clone(),
            container_id: format!("container-{}", sandbox_id),
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
        };
        let mut user_env = serde_json::Map::new();
        user_env.insert("ANTHROPIC_API_KEY".to_string(), serde_json::json!("test-key"));
        let activate_result = trading_blueprint_lib::jobs::activate_bot_with_secrets(
            &bot.id,
            user_env,
            Some(mock_sb),
        )
        .await;
        assert!(activate_result.is_ok(), "activation should succeed: {:?}", activate_result.err());
        let activate_out = activate_result.unwrap();
        eprintln!("        workflow_id={}", activate_out.workflow_id);
        assert!(activate_out.workflow_id > 0, "workflow_id should be set after activation");

        // ── 6c. JOB_STATUS (4) — verify active state ─────────────────
        eprintln!("[test] Submitting JOB_STATUS (post-activation)...");
        let status_sub2 = harness
            .submit_job(JOB_STATUS, Bytes::from(status_payload))
            .await?;
        let status_output2 = harness
            .wait_for_job_result_with_deadline(status_sub2, common::JOB_RESULT_TIMEOUT)
            .await?;
        let status_receipt2 = TradingStatusResponse::abi_decode(&status_output2)?;
        eprintln!(
            "        state={}, trading_active={}",
            status_receipt2.state, status_receipt2.trading_active
        );
        assert!(status_receipt2.trading_active, "bot should be active after secrets injection");
        assert_eq!(status_receipt2.sandbox_id, sandbox_id);

        // ── 7. JOB_CONFIGURE (1) ────────────────────────────────────────
        eprintln!("[test] Submitting JOB_CONFIGURE...");
        let configure_payload = TradingConfigureRequest {
            sandbox_id: sandbox_id.clone(),
            strategy_config_json: r#"{"max_slippage":0.3,"pair":"ETH/USDC"}"#.to_string(),
            risk_params_json: r#"{"max_drawdown_pct":3.0}"#.to_string(),
        }
        .abi_encode();
        let configure_sub = harness
            .submit_job(JOB_CONFIGURE, Bytes::from(configure_payload))
            .await?;
        let configure_output = harness
            .wait_for_job_result_with_deadline(configure_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let configure_receipt = JsonResponse::abi_decode(&configure_output)?;
        eprintln!("        {}", configure_receipt.json);
        assert!(configure_receipt.json.contains("configured"));

        // ── 8. JOB_STOP_TRADING (3) ─────────────────────────────────────────────
        eprintln!("[test] Submitting JOB_STOP_TRADING...");
        let stop_payload = TradingControlRequest {
            sandbox_id: sandbox_id.clone(),
        }
        .abi_encode();
        let stop_sub = harness
            .submit_job(JOB_STOP_TRADING, Bytes::from(stop_payload))
            .await?;
        let stop_output = harness
            .wait_for_job_result_with_deadline(stop_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let stop_receipt = JsonResponse::abi_decode(&stop_output)?;
        eprintln!("        {}", stop_receipt.json);
        assert!(stop_receipt.json.contains("stopped"));

        // ── 9. JOB_START_TRADING (2) ────────────────────────────────────────────
        eprintln!("[test] Submitting JOB_START_TRADING...");
        let start_payload = TradingControlRequest {
            sandbox_id: sandbox_id.clone(),
        }
        .abi_encode();
        let start_sub = harness
            .submit_job(JOB_START_TRADING, Bytes::from(start_payload))
            .await?;
        let start_output = harness
            .wait_for_job_result_with_deadline(start_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let start_receipt = JsonResponse::abi_decode(&start_output)?;
        eprintln!("        {}", start_receipt.json);
        assert!(start_receipt.json.contains("started"));

        // ── 10. JOB_DEPROVISION (5) ──────────────────────────────────────
        eprintln!("[test] Submitting JOB_DEPROVISION...");
        let deprovision_payload = TradingControlRequest {
            sandbox_id: sandbox_id.clone(),
        }
        .abi_encode();
        let deprovision_sub = harness
            .submit_job(JOB_DEPROVISION, Bytes::from(deprovision_payload))
            .await?;
        let deprovision_output = harness
            .wait_for_job_result_with_deadline(deprovision_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let deprovision_receipt = JsonResponse::abi_decode(&deprovision_output)?;
        eprintln!("        {}", deprovision_receipt.json);
        assert!(deprovision_receipt.json.contains("deprovisioned"));

        // ── Done ─────────────────────────────────────────────────────────
        eprintln!("\n[done] Full trading lifecycle completed successfully!");
        harness.shutdown().await;
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test_tangle_trading_lifecycle timed out")?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_validator_cluster_scores_and_signs() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    // Serialize with the lifecycle test to avoid resource contention
    let _guard = common::HARNESS_LOCK.lock().await;

    // ── Deploy TradeValidator on Anvil ───────────────────────────────
    let anvil = Anvil::new().try_spawn().context("Anvil")?;
    let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
    let deployer_provider = ProviderBuilder::new()
        .wallet(EthereumWallet::from(deployer_key))
        .connect_http(anvil.endpoint().parse().unwrap());

    let val_addrs: Vec<Address> = (3..6)
        .map(|i| {
            let k: PrivateKeySigner = anvil.keys()[i].clone().into();
            k.address()
        })
        .collect();

    let (tv_addr, vault_addr) =
        contract_deployer::deploy_trade_validator(&deployer_provider, val_addrs, 2).await;

    // ── Start 3 validator servers ───────────────────────────────────
    let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
    let cluster =
        validators::start_validator_cluster(&val_keys, tv_addr, vault_addr, None).await;

    // ── Build a trade intent and validate ───────────────────────────
    // Use real well-known mainnet token addresses (WETH → USDC)
    let intent = trading_runtime::TradeIntentBuilder::new()
        .strategy_id("e2e-test")
        .action(trading_runtime::Action::Swap)
        .token_in("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
        .token_out("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
        .amount_in(rust_decimal::Decimal::new(1000, 0))
        .min_amount_out(rust_decimal::Decimal::new(950, 0))
        .target_protocol("uniswap_v3")
        .build()
        .unwrap();

    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;

    let result = cluster
        .client
        .validate(&intent, &format!("{vault_addr}"), deadline)
        .await
        .expect("Validation should succeed");

    eprintln!("Aggregate score: {}, approved: {}", result.aggregate_score, result.approved);
    assert_eq!(result.validator_responses.len(), 3);

    // All signatures should be real EIP-712
    for resp in &result.validator_responses {
        let zero_sig = format!("0x{}", "00".repeat(65));
        assert_ne!(resp.signature, zero_sig);
        assert_eq!(resp.signature.len(), 2 + 65 * 2);
    }

    // ── Verify 2-of-3 on-chain ──────────────────────────────────────
    let ih_hex = &result.intent_hash;
    let ih_stripped = ih_hex.strip_prefix("0x").unwrap_or(ih_hex);
    let ih_bytes = hex::decode(ih_stripped).unwrap();
    let mut ih_arr = [0u8; 32];
    ih_arr.copy_from_slice(&ih_bytes);

    let mut sigs = Vec::new();
    let mut scores = Vec::new();
    for vr in result.validator_responses.iter().take(2) {
        let sig_hex = vr.signature.strip_prefix("0x").unwrap_or(&vr.signature);
        sigs.push(alloy::primitives::Bytes::from(
            hex::decode(sig_hex).unwrap(),
        ));
        scores.push(U256::from(vr.score));
    }

    let tv = contract_deployer::TradeValidator::new(tv_addr, &deployer_provider);
    let on_chain = tv
        .validateWithSignatures(
            alloy::primitives::FixedBytes::<32>::from(ih_arr),
            vault_addr,
            sigs,
            scores,
            U256::from(deadline),
        )
        .call()
        .await
        .unwrap();

    assert!(on_chain.approved, "On-chain validation should pass with 2-of-3");
    assert_eq!(on_chain.validCount, U256::from(2));

    eprintln!("On-chain verified: approved={}, validCount={}", on_chain.approved, on_chain.validCount);
    Ok(())
}

/// Multi-strategy provision test — provisions bots with all 5 strategy types
/// via the Tangle harness and verifies each receives the correct pack profile.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_multi_strategy_provision_via_tangle() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(common::ANVIL_TEST_TIMEOUT, async {
        let anvil = Anvil::new().try_spawn().context("Failed to spawn Anvil")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_wallet = EthereumWallet::from(deployer_key);
        let deployer_provider = ProviderBuilder::new()
            .wallet(deployer_wallet)
            .connect_http(rpc_url.parse().unwrap());

        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let (_tv_addr, vault_addr) = contract_deployer::deploy_trade_validator(
            &deployer_provider,
            val_addrs.clone(),
            2,
        )
        .await;

        unsafe { std::env::set_var("TRADING_API_URL", "http://127.0.0.1:9100"); }
        common::setup_sidecar_env();

        let Some(harness) = common::spawn_harness().await? else {
            eprintln!("Skipping: TNT artifacts not found");
            return Ok(());
        };

        let strategies = ["dex", "yield", "perp", "prediction", "multi"];

        for strategy in &strategies {
            eprintln!("\n[test] Provisioning strategy: {strategy}");
            let provision_payload = TradingProvisionRequest {
                name: format!("e2e-{strategy}-bot"),
                strategy_type: strategy.to_string(),
                strategy_config_json: r#"{"max_slippage":0.5}"#.to_string(),
                risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
                factory_address: vault_addr,
                asset_token: Address::from([0xCC; 20]),
                signers: val_addrs.clone(),
                required_signatures: U256::from(2),
                chain_id: U256::from(31337),
                rpc_url: rpc_url.clone(),
                trading_loop_cron: "0 */5 * * * *".to_string(),
                cpu_cores: 2,
                memory_mb: 4096,
                max_lifetime_days: 30,
                validator_service_ids: vec![],
            }
            .abi_encode();

            let sub = harness
                .submit_job(JOB_PROVISION, Bytes::from(provision_payload))
                .await?;
            let output = harness
                .wait_for_job_result_with_deadline(sub, common::JOB_RESULT_TIMEOUT)
                .await?;
            let receipt = TradingProvisionOutput::abi_decode(&output)?;

            eprintln!(
                "        sandbox_id={}, workflow_id={}, vault={}",
                receipt.sandbox_id, receipt.workflow_id, receipt.vault_address
            );
            assert!(!receipt.sandbox_id.is_empty(), "{strategy} sandbox_id empty");
            // Two-phase provisioning: workflow_id=0 means "awaiting secrets"
            assert_eq!(receipt.workflow_id, 0, "{strategy} workflow_id should be 0 (awaiting secrets)");

            // Verify the bot record has the correct strategy type
            let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&receipt.sandbox_id)
                .expect("bot should exist");
            assert_eq!(
                bot.strategy_type, *strategy,
                "Bot strategy should be {strategy}"
            );

            // Deprovision to free resources
            let deprov_payload = TradingControlRequest {
                sandbox_id: receipt.sandbox_id.clone(),
            }
            .abi_encode();
            let deprov_sub = harness
                .submit_job(JOB_DEPROVISION, Bytes::from(deprov_payload))
                .await?;
            let deprov_output = harness
                .wait_for_job_result_with_deadline(deprov_sub, common::JOB_RESULT_TIMEOUT)
                .await?;
            let deprov_receipt = JsonResponse::abi_decode(&deprov_output)?;
            assert!(
                deprov_receipt.json.contains("deprovisioned"),
                "{strategy} deprovision failed"
            );
        }

        eprintln!("\n[done] All 5 strategies provisioned and deprovisioned successfully!");
        harness.shutdown().await;
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test_multi_strategy_provision_via_tangle timed out")?
}
