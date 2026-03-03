//! Full end-to-end pipeline tests.
//!
//! Exercises the **complete** trade lifecycle:
//!   provision → activate → POST /validate → validator fan-out → POST /execute → trade stored → verify
//!
//! Test variants:
//! - `test_full_trade_pipeline_harness` — policy-only validators, paper trade (fast)
//! - `test_full_trade_pipeline_with_ai` — real AI scoring via Zhipu GLM-4.7 (slow)
//! - `test_vault_execute_on_chain` — real vault.execute() with MockTarget on Anvil
//! - `test_full_bot_lifecycle` — provision → activate → stop → start → configure → wipe → deprovision
//! - `test_fee_settlement_on_chain` — deposit → trade → settle fees → verify fee extraction
//! - `test_adversarial_contract_paths` — 6 on-chain failure paths (deadline, sigs, replay, auth, target, minOutput)
//! - `test_fee_parity_rust_solidity` — verify Rust fee math matches Solidity within tolerance
//!
//! Gate: `SIDECAR_E2E=1` + Docker + forge artifacts + TNT artifacts.
//!
//! ```bash
//! SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_e2e_full -- --nocapture
//! ```

mod common;

use alloy::network::EthereumWallet;
use alloy::node_bindings::Anvil;
use alloy::primitives::{Address, FixedBytes, U256};
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use anyhow::{Context, Result};
use blueprint_sdk::alloy::primitives::Bytes;
use rust_decimal::Decimal;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use trading_validator_lib::risk_evaluator::AiProvider;

use common::contract_deployer;
use common::e2e_helpers;
use common::validators;

use trading_blueprint_lib::{JOB_PROVISION, TradingProvisionOutput, TradingProvisionRequest};

/// Extract raw key bytes from Anvil pre-funded accounts for validator indices.
fn validator_key_bytes(
    anvil: &alloy::node_bindings::AnvilInstance,
    indices: &[usize],
) -> Vec<Vec<u8>> {
    indices
        .iter()
        .map(|&i| anvil.keys()[i].to_bytes().to_vec())
        .collect()
}

/// Core E2E pipeline shared by both test variants.
///
/// 1. Deploy TradeValidator (2-of-3 multisig) on Anvil
/// 2. Start 3 validator servers
/// 3. Spawn BlueprintHarness, submit JOB_PROVISION
/// 4. Activate bot with mock sandbox
/// 5. Start Trading HTTP API
/// 6. POST /validate → verify 3 validator signatures
/// 7. Verify on-chain 2-of-3 multisig
/// 8. POST /execute → paper trade
/// 9. Verify trade stored in trade_store
async fn run_full_pipeline(ai_provider: Option<AiProvider>) -> Result<()> {
    common::setup_log();
    common::setup_sidecar_env();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let test_timeout = if ai_provider.is_some() { 900 } else { 600 };

    let result = timeout(Duration::from_secs(test_timeout), async {
        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  1. Deploy on-chain infrastructure                              ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[1/9] Deploying TradeValidator on Anvil...");
        let anvil = Anvil::new()
            .arg("--code-size-limit")
            .arg("50000")
            .try_spawn()
            .context("Anvil spawn")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let (tv_addr, vault_addr) =
            contract_deployer::deploy_trade_validator(&deployer_provider, val_addrs.clone(), 2)
                .await;

        eprintln!("        TradeValidator: {tv_addr}");
        eprintln!("        Vault: {vault_addr} (2-of-3)");

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  2. Start 3 validator servers                                   ║
        // ╚══════════════════════════════════════════════════════════════════╝
        let has_ai = ai_provider.is_some();
        let ai_label = if has_ai {
            "AI (GLM-4.7)"
        } else {
            "policy-only"
        };
        eprintln!("[2/9] Starting 3 {ai_label} validator servers...");

        let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
        let cluster =
            validators::start_validator_cluster(&val_keys, tv_addr, vault_addr, ai_provider).await;

        for (i, (ep, addr)) in cluster
            .endpoints
            .iter()
            .zip(cluster.validator_addresses.iter())
            .enumerate()
        {
            eprintln!("        Validator {} @ {} ({})", i + 1, ep, addr);
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  3. Spawn BlueprintHarness and provision a bot                  ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[3/9] Provisioning bot via BlueprintHarness...");

        let Some(harness) = common::spawn_harness().await? else {
            eprintln!("        Skipping: TNT core artifacts not found");
            return Ok(());
        };

        let provision_payload = TradingProvisionRequest {
            name: "e2e-full-pipeline-bot".to_string(),
            strategy_type: "dex".to_string(),
            strategy_config_json: r#"{"max_slippage":0.5}"#.to_string(),
            risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
            factory_address: vault_addr,
            asset_token: Address::from([0xCC; 20]),
            signers: val_addrs,
            required_signatures: U256::from(2),
            chain_id: U256::from(31337),
            rpc_url: rpc_url.clone(),
            trading_loop_cron: "0 */5 * * * *".to_string(),
            cpu_cores: 2,
            memory_mb: 4096,
            max_lifetime_days: 30,
            validator_service_ids: vec![],
            max_collateral_bps: U256::from(0),
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
            "        Provisioned: sandbox_id={}, workflow_id={}",
            receipt.sandbox_id, receipt.workflow_id
        );
        assert!(!receipt.sandbox_id.is_empty(), "sandbox_id should be set");
        assert_eq!(
            receipt.workflow_id, 0,
            "workflow_id=0 means awaiting secrets"
        );

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  4. Activate bot with mock sandbox (two-phase provisioning)     ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[4/9] Activating bot with mock sandbox...");

        let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&receipt.sandbox_id)
            .expect("bot should exist after provision");
        let bot_id = bot.id.clone();
        let api_token = bot.trading_api_token.clone();

        eprintln!("        Bot ID: {bot_id}");
        eprintln!("        API token: {api_token}");
        assert!(
            !bot.trading_active,
            "bot should not be active before secrets"
        );

        let mock_sb = sandbox_runtime::SandboxRecord {
            id: receipt.sandbox_id.clone(),
            container_id: format!("container-{}", receipt.sandbox_id),
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
            extra_ports: std::collections::HashMap::new(),
            tee_attestation_json: None,
        };

        let mut user_env = serde_json::Map::new();
        user_env.insert(
            "ANTHROPIC_API_KEY".to_string(),
            serde_json::json!("test-key"),
        );

        let activate_result = trading_blueprint_lib::jobs::activate_bot_with_secrets(
            &bot_id,
            user_env,
            Some(mock_sb),
        )
        .await;
        assert!(
            activate_result.is_ok(),
            "activation should succeed: {:?}",
            activate_result.err()
        );
        let activate_out = activate_result.unwrap();
        eprintln!(
            "        Activated: sandbox_id={}, workflow_id={}",
            activate_out.sandbox_id, activate_out.workflow_id
        );
        assert!(
            activate_out.workflow_id > 0,
            "workflow_id should be set after activation"
        );

        // Verify bot is now active
        let bot_after = trading_blueprint_lib::state::get_bot(&bot_id)
            .expect("store access")
            .expect("bot exists");
        assert!(
            bot_after.trading_active,
            "bot should be active after secrets"
        );

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  5. Start Trading HTTP API with bot's credentials              ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[5/9] Starting Trading HTTP API (paper mode)...");

        let api_state = Arc::new(trading_http_api::TradingApiState {
            market_client: trading_runtime::market_data::MarketDataClient::new(
                "http://localhost:0".to_string(),
            ),
            validator_client: cluster.client.clone(),
            executor: trading_runtime::executor::TradeExecutor::new(
                &format!("{vault_addr}"),
                &rpc_url,
                &hex::encode(anvil.keys()[1].to_bytes()),
                31337,
            )
            .expect("executor"),
            portfolio: tokio::sync::RwLock::new(trading_runtime::PortfolioState::default()),
            api_token: api_token.clone(),
            vault_address: format!("{vault_addr}"),
            validator_endpoints: cluster.endpoints.clone(),
            validation_deadline_secs: 3600,
            bot_id: bot_id.clone(),
            paper_trade: true,
            operator_address: String::new(),
            submitter_address: String::new(),
            sidecar_url: String::new(),
            sidecar_token: String::new(),
            rpc_url: Some(rpc_url.clone()),
            chain_id: Some(31337),
            clob_client: None,
        });

        let api_router = trading_http_api::build_router(api_state);
        let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let api_port = api_listener.local_addr()?.port();
        let api_url = format!("http://127.0.0.1:{api_port}");
        eprintln!("        Trading API @ {api_url}");

        tokio::spawn(async move {
            axum::serve(api_listener, api_router).await.ok();
        });
        tokio::time::sleep(Duration::from_millis(100)).await;

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  6. Simulated agent: POST /validate                            ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[6/9] Agent: POST /validate (WETH → USDC swap)...");

        let http_client = e2e_helpers::e2e_http_client(if has_ai { 120 } else { 30 });
        let validate_body = e2e_helpers::validate_trade(&http_client, &api_url, &api_token).await?;

        let approved = validate_body["approved"].as_bool().unwrap_or(false);
        let score = validate_body["aggregate_score"].as_u64().unwrap_or(0);
        let validator_responses = validate_body["validator_responses"]
            .as_array()
            .context("missing validator_responses")?;

        eprintln!("        approved={approved}, aggregate_score={score}");
        eprintln!("        {} validator responses", validator_responses.len());
        assert!(score > 0, "Score should be > 0");
        assert_eq!(
            validator_responses.len(),
            3,
            "All 3 validators should respond"
        );

        for (i, vr) in validator_responses.iter().enumerate() {
            let sig = vr["signature"].as_str().unwrap_or("");
            let zero_sig = format!("0x{}", "00".repeat(65));
            assert_ne!(
                sig,
                zero_sig,
                "Validator {} signature should be real EIP-712",
                i + 1
            );
            eprintln!(
                "        Validator {}: score={}, sig={}...",
                i + 1,
                vr["score"],
                &sig[..std::cmp::min(sig.len(), 20)]
            );
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  7. Verify on-chain 2-of-3 multisig signatures                 ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[7/9] Verifying 2-of-3 signatures on-chain...");

        let (on_chain_approved, valid_count) = e2e_helpers::verify_on_chain_signatures(
            &deployer_provider,
            tv_addr,
            vault_addr,
            &validate_body,
            2,
        )
        .await?;

        eprintln!("        On-chain: approved={on_chain_approved}, validCount={valid_count}");
        // On-chain validates signatures are real (from registered signers),
        // independent of AI score threshold. Both sigs should be valid.
        assert_eq!(valid_count, 2, "Both signatures should be valid on-chain");

        // AI scoring may reject trades that policy-only validators approve.
        // When AI doesn't approve, verify the pipeline handled it correctly
        // (scores came back, signatures are real) then skip execute/store.
        if !approved {
            assert!(
                has_ai,
                "Policy-only validators should always approve this trade"
            );
            eprintln!(
                "        AI scored below threshold (score={score}) — expected for conservative AI"
            );
            eprintln!(
                "        Pipeline verified: AI scoring → EIP-712 signing → on-chain verification"
            );

            harness.shutdown().await;

            eprintln!("\n========================================");
            eprintln!("  FULL TRADE PIPELINE E2E (AI path): PASSED");
            eprintln!("  (AI rejected trade — pipeline integrity verified)");
            eprintln!("========================================");
            return Ok(());
        }

        assert!(
            on_chain_approved,
            "On-chain should approve 2-of-3 when AI approved"
        );

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  8. Simulated agent: POST /execute (paper trade)               ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[8/9] Agent: POST /execute (paper trade)...");

        let execute_body =
            e2e_helpers::execute_trade(&http_client, &api_url, &api_token, &validate_body).await?;

        let tx_hash = execute_body["tx_hash"].as_str().unwrap_or("");
        let paper = execute_body["paper_trade"].as_bool().unwrap_or(false);

        eprintln!("        tx_hash={tx_hash}");
        eprintln!("        paper_trade={paper}");
        assert!(paper, "Should be paper trade");
        assert!(
            tx_hash.starts_with("0xpaper_"),
            "Paper trade tx_hash should start with 0xpaper_"
        );

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  9. Verify trade stored in trade_store                         ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[9/9] Verifying trade stored in trade_store...");

        let trades = trading_http_api::trade_store::trades_for_bot(&bot_id, 10, 0)
            .map_err(|e| anyhow::anyhow!("trades_for_bot query: {e}"))?;
        eprintln!("        Total trades for bot: {}", trades.total);
        assert!(trades.total >= 1, "Should have at least 1 trade recorded");

        let trade = &trades.trades[0];
        assert_eq!(trade.action, "swap", "action should be swap");
        assert_eq!(trade.token_in, e2e_helpers::WETH, "token_in should be WETH");
        assert_eq!(
            trade.token_out,
            e2e_helpers::USDC,
            "token_out should be USDC"
        );
        assert!(trade.paper_trade, "trade should be paper_trade");
        assert!(trade.validation.approved, "validation should be approved");
        assert_eq!(
            trade.validation.responses.len(),
            3,
            "Should have 3 validator responses stored"
        );
        assert_eq!(
            trade.tx_hash, tx_hash,
            "tx_hash should match execute response"
        );

        eprintln!(
            "        Trade verified: id={}, action={}, paper_trade={}",
            trade.id, trade.action, trade.paper_trade
        );

        // Shutdown harness
        harness.shutdown().await;

        eprintln!("\n========================================");
        eprintln!("  FULL TRADE PIPELINE E2E: PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test timed out")?
}

/// Full pipeline with policy-only validators (deterministic, ~30s).
///
/// No AI key required. Validates the entire flow from provision through
/// paper trade execution and storage.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_full_trade_pipeline_harness() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }
    run_full_pipeline(None).await
}

/// Full pipeline with real AI scoring via Zhipu GLM-4.7 (~2-3 min).
///
/// Requires `ZAI_API_KEY` for real AI evaluation of the trade intent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_full_trade_pipeline_with_ai() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }
    let api_key = match std::env::var("ZAI_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            eprintln!("Skipping: set ZAI_API_KEY for real AI scoring");
            return Ok(());
        }
    };

    let model = std::env::var("AI_MODEL").unwrap_or_else(|_| "glm-4.7".into());
    let endpoint = std::env::var("AI_API_ENDPOINT")
        .unwrap_or_else(|_| "https://api.z.ai/api/coding/paas/v4".into());

    run_full_pipeline(Some(AiProvider::Zai {
        api_key,
        model,
        endpoint,
    }))
    .await
}

// ═════════════════════════════════════════════════════════════════════════════
// On-chain vault.execute() test
// ═════════════════════════════════════════════════════════════════════════════

/// Real on-chain vault.execute() with MockTarget.
///
/// Deploys the full trade stack (PolicyEngine, TradeValidator, FeeDistributor,
/// VaultShare, TradingVault, MockTarget), deposits user funds, gets validator
/// signatures via HTTP /validate, then calls vault.execute() directly on-chain.
/// Verifies output token balance in vault.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_vault_execute_on_chain() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    common::setup_sidecar_env();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(Duration::from_secs(600), async {
        // ── 1. Deploy full trade stack on Anvil ─────────────────────────────
        eprintln!("\n[1/8] Deploying full trade stack on Anvil...");
        let anvil = Anvil::new()
            .arg("--code-size-limit")
            .arg("50000")
            .try_spawn()
            .context("Anvil spawn")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_addr = deployer_key.address();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let operator_key: PrivateKeySigner = anvil.keys()[1].clone().into();
        let operator_addr = operator_key.address();
        let operator_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(operator_key))
            .connect_http(rpc_url.parse().unwrap());

        let user_key: PrivateKeySigner = anvil.keys()[2].clone().into();
        let user_addr = user_key.address();
        let user_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(user_key))
            .connect_http(rpc_url.parse().unwrap());

        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let stack = contract_deployer::deploy_full_trade_stack(
            &deployer_provider,
            deployer_addr,
            operator_addr,
            val_addrs.clone(),
            2,
        )
        .await;

        eprintln!("        Vault:      {}", stack.vault);
        eprintln!("        TokenA:     {}", stack.token_a);
        eprintln!("        TokenB:     {}", stack.token_b);
        eprintln!("        MockTarget: {}", stack.mock_target);

        // ── 2. Mint tokens and deposit to vault ─────────────────────────────
        eprintln!("[2/8] Minting tokens and depositing to vault...");
        let deposit_amount = U256::from(10_000u64) * U256::from(10u64).pow(U256::from(18u64));

        e2e_helpers::mint_tokens(&deployer_provider, stack.token_a, user_addr, deposit_amount)
            .await?;
        e2e_helpers::approve_tokens(&user_provider, stack.token_a, stack.vault, deposit_amount)
            .await?;
        e2e_helpers::deposit_to_vault(&user_provider, stack.vault, deposit_amount, user_addr)
            .await?;

        let total_assets = e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;
        assert_eq!(
            total_assets, deposit_amount,
            "Vault should hold deposited assets"
        );
        eprintln!("        Deposited {deposit_amount} tokenA → vault totalAssets = {total_assets}");

        // ── 3. Start 3 policy-only validator servers ────────────────────────
        eprintln!("[3/8] Starting 3 policy-only validator servers...");
        let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
        let cluster = validators::start_validator_cluster(
            &val_keys,
            stack.trade_validator,
            stack.vault,
            None,
        )
        .await;

        // ── 4. Start Trading HTTP API (for /validate only) ──────────────────
        eprintln!("[4/8] Starting Trading HTTP API...");
        let api_token = "e2e-vault-execute-token";
        let api_state = Arc::new(trading_http_api::TradingApiState {
            market_client: trading_runtime::market_data::MarketDataClient::new(
                "http://localhost:0".into(),
            ),
            validator_client: cluster.client.clone(),
            executor: trading_runtime::executor::TradeExecutor::new(
                &format!("{}", stack.vault),
                &rpc_url,
                &hex::encode(anvil.keys()[1].to_bytes()),
                31337,
            )
            .expect("executor"),
            portfolio: tokio::sync::RwLock::new(trading_runtime::PortfolioState::default()),
            api_token: api_token.to_string(),
            vault_address: format!("{}", stack.vault),
            validator_endpoints: cluster.endpoints.clone(),
            validation_deadline_secs: 3600,
            bot_id: "e2e-vault-execute-bot".to_string(),
            paper_trade: true,
            operator_address: String::new(),
            submitter_address: String::new(),
            sidecar_url: String::new(),
            sidecar_token: String::new(),
            rpc_url: Some(rpc_url.clone()),
            chain_id: Some(31337),
            clob_client: None,
        });

        let api_router = trading_http_api::build_router(api_state);
        let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let api_port = api_listener.local_addr()?.port();
        let api_url = format!("http://127.0.0.1:{api_port}");
        eprintln!("        Trading API @ {api_url}");

        tokio::spawn(async move {
            axum::serve(api_listener, api_router).await.ok();
        });
        tokio::time::sleep(Duration::from_millis(100)).await;

        // ── 5. POST /validate → get EIP-712 signatures ─────────────────────
        eprintln!("[5/8] POST /validate to get validator signatures...");
        let http_client = e2e_helpers::e2e_http_client(30);
        let validate_body = e2e_helpers::validate_trade(&http_client, &api_url, api_token).await?;

        assert!(
            validate_body["approved"].as_bool().unwrap_or(false),
            "Trade should be approved"
        );
        let num_vr = validate_body["validator_responses"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0);
        eprintln!("        Approved with {num_vr} validator responses");

        // ── 6. Verify on-chain 2-of-3 signatures ───────────────────────────
        eprintln!("[6/8] Verifying 2-of-3 signatures on-chain...");
        let (approved, valid_count) = e2e_helpers::verify_on_chain_signatures(
            &deployer_provider,
            stack.trade_validator,
            stack.vault,
            &validate_body,
            2,
        )
        .await?;
        assert!(approved, "On-chain 2-of-3 should approve");
        assert_eq!(valid_count, 2);
        eprintln!("        On-chain: approved={approved}, validCount={valid_count}");

        // ── 7. vault.execute() on-chain with MockTarget ─────────────────────
        eprintln!("[7/8] Calling vault.execute() on-chain...");
        let output_amount = U256::from(950u64) * U256::from(10u64).pow(U256::from(18u64));
        let min_output = U256::from(900u64) * U256::from(10u64).pow(U256::from(18u64));

        let tx_hash = e2e_helpers::execute_vault_trade_on_chain(
            &operator_provider,
            &stack,
            &validate_body,
            output_amount,
            min_output,
        )
        .await?;
        eprintln!("        vault.execute() tx: {tx_hash}");

        // ── 8. Verify on-chain token balances ───────────────────────────────
        eprintln!("[8/8] Verifying on-chain token balances...");
        let token_b_bal =
            e2e_helpers::vault_balance(&deployer_provider, stack.vault, stack.token_b).await?;
        assert_eq!(
            token_b_bal, output_amount,
            "Vault should hold output tokens from MockTarget.swap"
        );
        eprintln!("        Vault tokenB balance: {token_b_bal}");

        let token_a_bal =
            e2e_helpers::vault_balance(&deployer_provider, stack.vault, stack.token_a).await?;
        assert_eq!(
            token_a_bal, deposit_amount,
            "TokenA unchanged (MockTarget doesn't consume input)"
        );
        eprintln!("        Vault tokenA balance: {token_a_bal}");

        eprintln!("\n========================================");
        eprintln!("  VAULT EXECUTE ON-CHAIN: PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test timed out")?
}

// ═════════════════════════════════════════════════════════════════════════════
// Full bot lifecycle test
// ═════════════════════════════════════════════════════════════════════════════

/// Create a mock sandbox record for lifecycle testing.
fn mock_sandbox_record(id: &str) -> sandbox_runtime::SandboxRecord {
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
        extra_ports: std::collections::HashMap::new(),
        tee_attestation_json: None,
    }
}

/// Full bot lifecycle: provision → activate → stop → start → configure → wipe → re-activate → deprovision.
///
/// Pure Rust state machine test — no Anvil, no Docker, no sidecar.
/// Uses provision_core() and lifecycle _core() functions with mock sandbox
/// and skip_docker=true.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_full_bot_lifecycle() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    common::setup_sidecar_env();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(Duration::from_secs(60), async {
        // ── 1. Provision via provision_core ──────────────────────────────────
        eprintln!("\n[1/8] Provisioning bot via provision_core...");
        let initial_sb_id = format!("sandbox-lifecycle-{}", uuid::Uuid::new_v4());
        let mock_sb = mock_sandbox_record(&initial_sb_id);

        let request = TradingProvisionRequest {
            name: "lifecycle-test-bot".to_string(),
            strategy_type: "dex".to_string(),
            strategy_config_json: r#"{"max_slippage":0.5}"#.to_string(),
            risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
            factory_address: Address::from([0xBB; 20]),
            asset_token: Address::from([0xCC; 20]),
            signers: vec![],
            required_signatures: U256::from(2),
            chain_id: U256::from(31337),
            rpc_url: "http://localhost:8545".to_string(),
            trading_loop_cron: "0 */5 * * * *".to_string(),
            cpu_cores: 2,
            memory_mb: 4096,
            max_lifetime_days: 30,
            validator_service_ids: vec![],
            max_collateral_bps: U256::from(0),
        };

        let output = trading_blueprint_lib::jobs::provision_core(
            request,
            Some(mock_sb),
            42,
            0,
            "0x0000000000000000000000000000000000000000".into(),
            None,
        )
        .await
        .expect("provision_core should succeed");

        let sandbox_id = output.sandbox_id.clone();
        assert!(!sandbox_id.is_empty(), "sandbox_id should be set");
        assert_eq!(
            output.workflow_id, 0,
            "workflow_id=0 means awaiting secrets"
        );

        let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&sandbox_id)
            .expect("bot should exist");
        let bot_id = bot.id.clone();
        assert!(
            !bot.trading_active,
            "bot should not be active before secrets"
        );
        eprintln!("        Bot provisioned: id={bot_id}, sandbox={sandbox_id}");

        // ── 2. Activate with secrets ────────────────────────────────────────
        eprintln!("[2/8] Activating bot with secrets...");
        let mock_sb2 = mock_sandbox_record(&sandbox_id);
        let mut user_env = serde_json::Map::new();
        user_env.insert("ANTHROPIC_API_KEY".into(), serde_json::json!("test-key"));

        let activate = trading_blueprint_lib::jobs::activate_bot_with_secrets(
            &bot_id,
            user_env.clone(),
            Some(mock_sb2),
        )
        .await
        .expect("activate should succeed");

        assert!(activate.workflow_id > 0, "workflow_id should be set");
        let bot = trading_blueprint_lib::state::get_bot(&bot_id)
            .unwrap()
            .unwrap();
        assert!(bot.trading_active, "bot should be active after secrets");
        let sandbox_id = bot.sandbox_id.clone();
        eprintln!(
            "        Bot activated: workflow_id={}",
            activate.workflow_id
        );

        // ── 3. Stop ─────────────────────────────────────────────────────────
        eprintln!("[3/8] Stopping bot...");
        let stop_result = trading_blueprint_lib::jobs::stop_core(&sandbox_id, true).await;
        assert!(
            stop_result.is_ok(),
            "stop should succeed: {:?}",
            stop_result.err()
        );
        let bot = trading_blueprint_lib::state::get_bot(&bot_id)
            .unwrap()
            .unwrap();
        assert!(!bot.trading_active, "bot should be stopped");
        eprintln!("        Bot stopped: trading_active=false");

        // ── 4. Start ────────────────────────────────────────────────────────
        eprintln!("[4/8] Starting bot...");
        let start_result = trading_blueprint_lib::jobs::start_core(&sandbox_id, true).await;
        assert!(
            start_result.is_ok(),
            "start should succeed: {:?}",
            start_result.err()
        );
        let bot = trading_blueprint_lib::state::get_bot(&bot_id)
            .unwrap()
            .unwrap();
        assert!(bot.trading_active, "bot should be active again");
        eprintln!("        Bot started: trading_active=true");

        // ── 5. Configure ────────────────────────────────────────────────────
        eprintln!("[5/8] Configuring bot...");
        let new_config = r#"{"max_slippage":1.0,"paper_trade":false}"#;
        let new_params = r#"{"max_drawdown_pct":10.0}"#;
        let config_result =
            trading_blueprint_lib::jobs::configure_core(&sandbox_id, new_config, new_params).await;
        assert!(
            config_result.is_ok(),
            "configure should succeed: {:?}",
            config_result.err()
        );

        let bot = trading_blueprint_lib::state::get_bot(&bot_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            bot.strategy_config["max_slippage"], 1.0,
            "strategy config should be updated"
        );
        assert!(!bot.paper_trade, "paper_trade should be toggled off");
        eprintln!(
            "        Bot configured: paper_trade={}, max_slippage={}",
            bot.paper_trade, bot.strategy_config["max_slippage"]
        );

        // ── 6. Wipe secrets ─────────────────────────────────────────────────
        eprintln!("[6/8] Wiping bot secrets...");
        // Ensure sandbox store has the record with user secrets (activate stored it)
        if let Ok(store) = sandbox_runtime::runtime::sandboxes() {
            let mut sb = mock_sandbox_record(&sandbox_id);
            sb.user_env_json = serde_json::to_string(&user_env).unwrap_or_default();
            let _ = store.insert(sb.id.clone(), sb);
        }

        let mock_sb_wipe = mock_sandbox_record(&sandbox_id);
        let wipe_result =
            trading_blueprint_lib::jobs::wipe_bot_secrets(&bot_id, Some(mock_sb_wipe)).await;
        assert!(
            wipe_result.is_ok(),
            "wipe should succeed: {:?}",
            wipe_result.err()
        );

        let bot = trading_blueprint_lib::state::get_bot(&bot_id)
            .unwrap()
            .unwrap();
        assert!(!bot.trading_active, "bot should be inactive after wipe");
        assert!(bot.workflow_id.is_none(), "workflow should be cleared");
        let sandbox_id = bot.sandbox_id.clone();
        eprintln!("        Bot secrets wiped → awaiting-secrets state");

        // ── 7. Re-activate with new secrets ─────────────────────────────────
        eprintln!("[7/8] Re-activating bot with new secrets...");
        let mock_sb4 = mock_sandbox_record(&sandbox_id);
        let mut user_env2 = serde_json::Map::new();
        user_env2.insert("ZAI_API_KEY".into(), serde_json::json!("new-key"));

        let activate2 = trading_blueprint_lib::jobs::activate_bot_with_secrets(
            &bot_id,
            user_env2,
            Some(mock_sb4),
        )
        .await
        .expect("re-activate should succeed");

        assert!(activate2.workflow_id > 0, "new workflow_id should be set");
        let bot = trading_blueprint_lib::state::get_bot(&bot_id)
            .unwrap()
            .unwrap();
        assert!(bot.trading_active, "bot should be active again");
        let sandbox_id = bot.sandbox_id.clone();
        eprintln!(
            "        Bot re-activated: workflow_id={}",
            activate2.workflow_id
        );

        // ── 8. Deprovision ──────────────────────────────────────────────────
        eprintln!("[8/8] Deprovisioning bot...");
        let deprovision_result =
            trading_blueprint_lib::jobs::deprovision_core(&sandbox_id, true, None).await;
        assert!(
            deprovision_result.is_ok(),
            "deprovision should succeed: {:?}",
            deprovision_result.err()
        );

        let bot_gone = trading_blueprint_lib::state::get_bot(&bot_id).unwrap();
        assert!(bot_gone.is_none(), "bot record should be removed");
        eprintln!("        Bot deprovisioned and removed");

        eprintln!("\n========================================");
        eprintln!("  FULL BOT LIFECYCLE: PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test timed out")?
}

// ═════════════════════════════════════════════════════════════════════════════
// Fee settlement on-chain test
// ═════════════════════════════════════════════════════════════════════════════

/// On-chain fee settlement: deposit → trade → settle → simulate gains → settle again → verify.
///
/// Deploys the full trade stack, deposits funds, executes a trade via
/// vault.execute() with MockTarget, then tests the FeeDistributor's
/// settleFees mechanism: HWM initialization, performance fees after gains,
/// and management fees over time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_fee_settlement_on_chain() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    common::setup_sidecar_env();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(Duration::from_secs(600), async {
        // ── 1. Deploy full trade stack ───────────────────────────────────────
        eprintln!("\n[1/8] Deploying full trade stack on Anvil...");
        let anvil = Anvil::new()
            .arg("--code-size-limit")
            .arg("50000")
            .try_spawn()
            .context("Anvil spawn")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_addr = deployer_key.address();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let operator_key: PrivateKeySigner = anvil.keys()[1].clone().into();
        let operator_addr = operator_key.address();
        let operator_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(operator_key))
            .connect_http(rpc_url.parse().unwrap());

        let user_key: PrivateKeySigner = anvil.keys()[2].clone().into();
        let user_addr = user_key.address();
        let user_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(user_key))
            .connect_http(rpc_url.parse().unwrap());

        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let stack = contract_deployer::deploy_full_trade_stack(
            &deployer_provider,
            deployer_addr,
            operator_addr,
            val_addrs.clone(),
            2,
        )
        .await;
        eprintln!("        Vault: {}", stack.vault);

        // ── 2. Mint + deposit ────────────────────────────────────────────────
        eprintln!("[2/8] Minting and depositing...");
        let deposit_amount = U256::from(10_000u64) * U256::from(10u64).pow(U256::from(18u64));

        e2e_helpers::mint_tokens(&deployer_provider, stack.token_a, user_addr, deposit_amount)
            .await?;
        e2e_helpers::approve_tokens(&user_provider, stack.token_a, stack.vault, deposit_amount)
            .await?;
        e2e_helpers::deposit_to_vault(&user_provider, stack.vault, deposit_amount, user_addr)
            .await?;

        let aum_before = e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;
        eprintln!("        Vault AUM after deposit: {aum_before}");

        // ── 3. Validate + execute a trade ────────────────────────────────────
        eprintln!("[3/8] Validating and executing trade on-chain...");
        let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
        let cluster = validators::start_validator_cluster(
            &val_keys,
            stack.trade_validator,
            stack.vault,
            None,
        )
        .await;

        let api_token = "e2e-fee-test-token";
        let api_state = Arc::new(trading_http_api::TradingApiState {
            market_client: trading_runtime::market_data::MarketDataClient::new(
                "http://localhost:0".into(),
            ),
            validator_client: cluster.client.clone(),
            executor: trading_runtime::executor::TradeExecutor::new(
                &format!("{}", stack.vault),
                &rpc_url,
                &hex::encode(anvil.keys()[1].to_bytes()),
                31337,
            )
            .expect("executor"),
            portfolio: tokio::sync::RwLock::new(trading_runtime::PortfolioState::default()),
            api_token: api_token.to_string(),
            vault_address: format!("{}", stack.vault),
            validator_endpoints: cluster.endpoints.clone(),
            validation_deadline_secs: 3600,
            bot_id: "e2e-fee-test-bot".to_string(),
            paper_trade: true,
            operator_address: String::new(),
            submitter_address: String::new(),
            sidecar_url: String::new(),
            sidecar_token: String::new(),
            rpc_url: Some(rpc_url.clone()),
            chain_id: Some(31337),
            clob_client: None,
        });

        let api_router = trading_http_api::build_router(api_state);
        let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let api_port = api_listener.local_addr()?.port();
        let api_url = format!("http://127.0.0.1:{api_port}");

        tokio::spawn(async move {
            axum::serve(api_listener, api_router).await.ok();
        });
        tokio::time::sleep(Duration::from_millis(100)).await;

        let http_client = e2e_helpers::e2e_http_client(30);
        let validate_body = e2e_helpers::validate_trade(&http_client, &api_url, api_token).await?;

        let output_amount = U256::from(950u64) * U256::from(10u64).pow(U256::from(18u64));
        let min_output = U256::from(900u64) * U256::from(10u64).pow(U256::from(18u64));

        let tx_hash = e2e_helpers::execute_vault_trade_on_chain(
            &operator_provider,
            &stack,
            &validate_body,
            output_amount,
            min_output,
        )
        .await?;
        eprintln!("        Trade executed: {tx_hash}");

        // ── 4. First fee settlement → initializes HWM ───────────────────────
        eprintln!("[4/8] First fee settlement (HWM initialization)...");
        let (acc_before, hwm_before) = e2e_helpers::settle_fees_on_chain(
            &deployer_provider,
            stack.fee_distributor,
            stack.vault,
            stack.token_a,
        )
        .await?;
        eprintln!("        After first settle: accumulated={acc_before}, HWM={hwm_before}");
        // First settlement initializes HWM — no performance fee on initial capital
        assert!(
            hwm_before > U256::ZERO,
            "HWM should be initialized to current AUM"
        );

        // ── 5. Simulate gains: mint more tokenA to vault ────────────────────
        eprintln!("[5/8] Simulating gains (minting 5000 tokenA to vault)...");
        let gains = U256::from(5_000u64) * U256::from(10u64).pow(U256::from(18u64));
        e2e_helpers::mint_tokens(&deployer_provider, stack.token_a, stack.vault, gains).await?;

        let aum_after_gains =
            e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;
        eprintln!("        Vault AUM after gains: {aum_after_gains}");
        assert!(
            aum_after_gains > hwm_before,
            "AUM should exceed HWM after gains"
        );

        // ── 6. Advance time by 30 days ──────────────────────────────────────
        eprintln!("[6/8] Advancing Anvil time by 30 days...");
        e2e_helpers::advance_anvil_time(&deployer_provider, 30 * 86400).await?;

        // ── 7. Second fee settlement → extract perf + mgmt fees ─────────────
        eprintln!("[7/8] Second fee settlement (extracting fees)...");
        let (acc_after, hwm_after) = e2e_helpers::settle_fees_on_chain(
            &deployer_provider,
            stack.fee_distributor,
            stack.vault,
            stack.token_a,
        )
        .await?;
        eprintln!("        After second settle: accumulated={acc_after}, HWM={hwm_after}");

        assert!(
            acc_after > acc_before,
            "Accumulated fees should increase after gains + time"
        );
        assert!(
            hwm_after > hwm_before,
            "HWM should increase to new AUM level"
        );

        // ── 8. Verify fee tokens moved to FeeDistributor ────────────────────
        eprintln!("[8/8] Verifying fee tokens in FeeDistributor...");
        let fd_balance =
            e2e_helpers::token_balance(&deployer_provider, stack.token_a, stack.fee_distributor)
                .await?;
        assert!(
            fd_balance > U256::ZERO,
            "FeeDistributor should hold fee tokens"
        );
        eprintln!("        FeeDistributor tokenA balance: {fd_balance}");

        // Vault AUM should have decreased by the fee amount
        let final_aum = e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;
        assert!(
            final_aum < aum_after_gains,
            "Vault AUM should decrease after fee extraction"
        );
        eprintln!("        Final vault AUM: {final_aum} (down from {aum_after_gains})");

        eprintln!("\n========================================");
        eprintln!("  FEE SETTLEMENT ON-CHAIN: PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test timed out")?
}

// ═════════════════════════════════════════════════════════════════════════════
// Adversarial contract paths test
// ═════════════════════════════════════════════════════════════════════════════

/// Adversarial on-chain test: exercises 6 contract failure paths.
///
/// Deploys the full trade stack, gets valid validator signatures, then
/// manually constructs vault.execute() calls with malformed parameters
/// to verify that every security gate rejects correctly:
///   1. Expired deadline -> DeadlineExpired revert
///   2. Insufficient signatures -> ValidatorCheckFailed revert
///   3. Replay attack -> IntentAlreadyExecuted revert
///   4. Unauthorized caller -> AccessControl revert
///   5. Invalid target -> PolicyCheckFailed revert
///   6. Min output not met -> MinOutputNotMet revert
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_adversarial_contract_paths() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    common::setup_sidecar_env();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(Duration::from_secs(600), async {
        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Setup: Deploy full trade stack + get valid signatures          ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[SETUP] Deploying full trade stack on Anvil...");
        let anvil = Anvil::new()
            .arg("--code-size-limit")
            .arg("50000")
            .try_spawn()
            .context("Anvil spawn")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_addr = deployer_key.address();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let operator_key: PrivateKeySigner = anvil.keys()[1].clone().into();
        let operator_addr = operator_key.address();
        let operator_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(operator_key))
            .connect_http(rpc_url.parse().unwrap());

        let user_key: PrivateKeySigner = anvil.keys()[2].clone().into();
        let user_addr = user_key.address();
        let user_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(user_key))
            .connect_http(rpc_url.parse().unwrap());

        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let stack = contract_deployer::deploy_full_trade_stack(
            &deployer_provider,
            deployer_addr,
            operator_addr,
            val_addrs.clone(),
            2, // 2-of-3 multisig
        )
        .await;

        eprintln!("        Vault:      {}", stack.vault);
        eprintln!("        TokenA:     {}", stack.token_a);
        eprintln!("        TokenB:     {}", stack.token_b);
        eprintln!("        MockTarget: {}", stack.mock_target);

        // Mint + deposit tokens so vault has funds
        eprintln!("[SETUP] Minting tokens and depositing to vault...");
        let deposit_amount = U256::from(10_000u64) * U256::from(10u64).pow(U256::from(18u64));

        e2e_helpers::mint_tokens(&deployer_provider, stack.token_a, user_addr, deposit_amount)
            .await?;
        e2e_helpers::approve_tokens(&user_provider, stack.token_a, stack.vault, deposit_amount)
            .await?;
        e2e_helpers::deposit_to_vault(&user_provider, stack.vault, deposit_amount, user_addr)
            .await?;

        // Start validator cluster + Trading HTTP API to get real EIP-712 signatures
        eprintln!("[SETUP] Starting 3 policy-only validators + HTTP API...");
        let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
        let cluster = validators::start_validator_cluster(
            &val_keys,
            stack.trade_validator,
            stack.vault,
            None,
        )
        .await;

        let api_token = "e2e-adversarial-token";
        let api_state = Arc::new(trading_http_api::TradingApiState {
            market_client: trading_runtime::market_data::MarketDataClient::new(
                "http://localhost:0".into(),
            ),
            validator_client: cluster.client.clone(),
            executor: trading_runtime::executor::TradeExecutor::new(
                &format!("{}", stack.vault),
                &rpc_url,
                &hex::encode(anvil.keys()[1].to_bytes()),
                31337,
            )
            .expect("executor"),
            portfolio: tokio::sync::RwLock::new(trading_runtime::PortfolioState::default()),
            api_token: api_token.to_string(),
            vault_address: format!("{}", stack.vault),
            validator_endpoints: cluster.endpoints.clone(),
            validation_deadline_secs: 3600,
            bot_id: "e2e-adversarial-bot".to_string(),
            paper_trade: true,
            operator_address: String::new(),
            submitter_address: String::new(),
            sidecar_url: String::new(),
            sidecar_token: String::new(),
            rpc_url: Some(rpc_url.clone()),
            chain_id: Some(31337),
            clob_client: None,
        });

        let api_router = trading_http_api::build_router(api_state);
        let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let api_port = api_listener.local_addr()?.port();
        let api_url = format!("http://127.0.0.1:{api_port}");
        eprintln!("        Trading API @ {api_url}");

        tokio::spawn(async move {
            axum::serve(api_listener, api_router).await.ok();
        });
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Get valid EIP-712 signatures via POST /validate
        eprintln!("[SETUP] Getting valid EIP-712 signatures via POST /validate...");
        let http_client = e2e_helpers::e2e_http_client(30);
        let validate_body = e2e_helpers::validate_trade(&http_client, &api_url, api_token).await?;
        assert!(
            validate_body["approved"].as_bool().unwrap_or(false),
            "Baseline validation should be approved"
        );

        // Extract shared fields from validation response
        let intent_hash_str = validate_body["intent_hash"]
            .as_str()
            .context("missing intent_hash")?;
        let ih_stripped = intent_hash_str
            .strip_prefix("0x")
            .unwrap_or(intent_hash_str);
        let ih_bytes = hex::decode(ih_stripped)?;
        let mut ih_arr = [0u8; 32];
        ih_arr.copy_from_slice(&ih_bytes);
        let intent_hash = FixedBytes::<32>::from(ih_arr);

        let deadline = validate_body["deadline"]
            .as_u64()
            .context("missing deadline")?;

        let validator_responses = validate_body["validator_responses"]
            .as_array()
            .context("missing validator_responses")?;

        let mut all_sigs = Vec::new();
        let mut all_scores = Vec::new();
        for vr in validator_responses {
            let sig_str = vr["signature"].as_str().unwrap_or("");
            let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
            all_sigs.push(Bytes::from(hex::decode(sig_hex)?));
            all_scores.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
        }

        let output_amount = U256::from(950u64) * U256::from(10u64).pow(U256::from(18u64));
        let min_output = U256::from(900u64) * U256::from(10u64).pow(U256::from(18u64));
        let swap_calldata = contract_deployer::encode_mock_swap(stack.vault, output_amount);

        eprintln!("[SETUP] Complete. Running 6 adversarial scenarios...\n");

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Scenario 1: Expired deadline                                   ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("[1/6] Expired deadline -- vault.execute() with past deadline...");
        {
            // Use eth_call (not eth_sendTransaction) to verify revert without
            // affecting alloy's HTTP transport nonce/connection state.
            let vault = contract_deployer::TradingVault::new(stack.vault, &operator_provider);
            let params = contract_deployer::TradingVault::ExecuteParams {
                target: stack.mock_target,
                data: Bytes::from(swap_calldata.clone()),
                value: U256::ZERO,
                minOutput: min_output,
                outputToken: stack.token_b,
                intentHash: intent_hash,
                deadline: U256::from(1u64), // Unix timestamp 1 -- far in the past
            };

            let result = vault
                .execute(params, all_sigs.clone(), all_scores.clone())
                .call()
                .await;

            assert!(
                result.is_err(),
                "Expired deadline should revert, but got Ok"
            );
            let err_str = format!("{:?}", result.err().expect("should revert"));
            eprintln!(
                "        Reverted as expected: {}",
                &err_str[..std::cmp::min(err_str.len(), 200)]
            );
            eprintln!("        PASSED: Expired deadline correctly rejected");
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Scenario 2: Insufficient signatures (1 of 2 required)         ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[2/6] Insufficient signatures -- only 1 signature when 2 required...");
        {
            // Call validateWithSignatures directly with only 1 sig
            let tv =
                contract_deployer::TradeValidator::new(stack.trade_validator, &deployer_provider);
            let one_sig = vec![all_sigs[0].clone()];
            let one_score = vec![all_scores[0]];

            let result = tv
                .validateWithSignatures(
                    intent_hash,
                    stack.vault,
                    one_sig,
                    one_score,
                    U256::from(deadline),
                )
                .call()
                .await
                .context("validateWithSignatures call failed")?;

            assert!(
                !result.approved,
                "1-of-2 should NOT be approved, but got approved=true"
            );
            assert_eq!(
                result.validCount.to::<u64>(),
                1,
                "Should have exactly 1 valid signature"
            );
            eprintln!(
                "        approved={}, validCount={}",
                result.approved, result.validCount
            );
            eprintln!("        PASSED: Insufficient signatures correctly returns approved=false");
        }

        // Also verify that vault.execute() reverts when given only 1 sig
        eprintln!("        Verifying vault.execute() also reverts with 1 sig...");
        {
            let vault = contract_deployer::TradingVault::new(stack.vault, &operator_provider);
            let one_sig = vec![all_sigs[0].clone()];
            let one_score = vec![all_scores[0]];

            let params = contract_deployer::TradingVault::ExecuteParams {
                target: stack.mock_target,
                data: Bytes::from(swap_calldata.clone()),
                value: U256::ZERO,
                minOutput: min_output,
                outputToken: stack.token_b,
                intentHash: intent_hash,
                deadline: U256::from(deadline),
            };

            let result = vault.execute(params, one_sig, one_score).call().await;

            assert!(
                result.is_err(),
                "vault.execute() with 1-of-2 sigs should revert (ValidatorCheckFailed)"
            );
            let err_str = format!("{:?}", result.err().expect("should revert"));
            eprintln!(
                "        vault.execute() reverted: {}",
                &err_str[..std::cmp::min(err_str.len(), 200)]
            );
            eprintln!("        PASSED: Insufficient sigs vault.execute() correctly rejected");
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Scenario 3: Replay attack -- same intentHash twice            ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[3/6] Replay attack -- execute same intentHash twice...");
        {
            // Use the shared execute_vault_trade_on_chain helper for the first (valid) call.
            // This avoids alloy transport issues after error responses in scenarios 1-2.
            let tx_hash = e2e_helpers::execute_vault_trade_on_chain(
                &operator_provider,
                &stack,
                &validate_body,
                output_amount,
                min_output,
            )
            .await
            .context("First vault.execute() should succeed")?;
            eprintln!("        First execution succeeded: tx={tx_hash}");

            // Second execution: same intentHash -- should revert with IntentAlreadyExecuted
            let vault = contract_deployer::TradingVault::new(stack.vault, &operator_provider);
            let params_replay = contract_deployer::TradingVault::ExecuteParams {
                target: stack.mock_target,
                data: Bytes::from(swap_calldata.clone()),
                value: U256::ZERO,
                minOutput: min_output,
                outputToken: stack.token_b,
                intentHash: intent_hash, // same intentHash
                deadline: U256::from(deadline),
            };

            let replay_result = vault
                .execute(params_replay, all_sigs.clone(), all_scores.clone())
                .call()
                .await;

            assert!(
                replay_result.is_err(),
                "Replay with same intentHash should revert (IntentAlreadyExecuted)"
            );
            let err_str = format!("{:?}", replay_result.err().expect("should revert"));
            eprintln!(
                "        Replay reverted: {}",
                &err_str[..std::cmp::min(err_str.len(), 200)]
            );
            eprintln!("        PASSED: Intent replay correctly rejected");
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Scenario 4: Unauthorized caller (user, not operator)          ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[4/6] Unauthorized caller -- vault.execute() from user account...");
        {
            // Get fresh signatures for a new intent (previous intentHash is consumed)
            let validate_body_2 =
                e2e_helpers::validate_trade(&http_client, &api_url, api_token).await?;
            let ih2_str = validate_body_2["intent_hash"]
                .as_str()
                .context("missing intent_hash")?;
            let ih2_stripped = ih2_str.strip_prefix("0x").unwrap_or(ih2_str);
            let ih2_bytes = hex::decode(ih2_stripped)?;
            let mut ih2_arr = [0u8; 32];
            ih2_arr.copy_from_slice(&ih2_bytes);
            let intent_hash_2 = FixedBytes::<32>::from(ih2_arr);

            let deadline_2 = validate_body_2["deadline"]
                .as_u64()
                .context("missing deadline")?;

            let vr2 = validate_body_2["validator_responses"]
                .as_array()
                .context("missing validator_responses")?;

            let mut sigs2 = Vec::new();
            let mut scores2 = Vec::new();
            for vr in vr2 {
                let sig_str = vr["signature"].as_str().unwrap_or("");
                let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
                sigs2.push(Bytes::from(hex::decode(sig_hex)?));
                scores2.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
            }

            // Use user_provider (Anvil key[2]) -- does NOT have OPERATOR_ROLE
            let vault_as_user = contract_deployer::TradingVault::new(stack.vault, &user_provider);
            let params = contract_deployer::TradingVault::ExecuteParams {
                target: stack.mock_target,
                data: Bytes::from(contract_deployer::encode_mock_swap(
                    stack.vault,
                    output_amount,
                )),
                value: U256::ZERO,
                minOutput: min_output,
                outputToken: stack.token_b,
                intentHash: intent_hash_2,
                deadline: U256::from(deadline_2),
            };

            let result = vault_as_user.execute(params, sigs2, scores2).call().await;

            assert!(
                result.is_err(),
                "User (non-operator) calling vault.execute() should revert"
            );
            let err_str = format!("{:?}", result.err().expect("should revert"));
            eprintln!(
                "        Reverted as expected: {}",
                &err_str[..std::cmp::min(err_str.len(), 200)]
            );
            eprintln!("        User address: {user_addr} (no OPERATOR_ROLE)");
            eprintln!("        PASSED: Unauthorized caller correctly rejected");
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Scenario 5: Invalid target (not whitelisted in PolicyEngine)  ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[5/6] Invalid target -- vault.execute() with non-whitelisted target...");
        {
            // Get fresh signatures
            let validate_body_3 =
                e2e_helpers::validate_trade(&http_client, &api_url, api_token).await?;
            let ih3_str = validate_body_3["intent_hash"]
                .as_str()
                .context("missing intent_hash")?;
            let ih3_stripped = ih3_str.strip_prefix("0x").unwrap_or(ih3_str);
            let ih3_bytes = hex::decode(ih3_stripped)?;
            let mut ih3_arr = [0u8; 32];
            ih3_arr.copy_from_slice(&ih3_bytes);
            let intent_hash_3 = FixedBytes::<32>::from(ih3_arr);

            let deadline_3 = validate_body_3["deadline"]
                .as_u64()
                .context("missing deadline")?;

            let vr3 = validate_body_3["validator_responses"]
                .as_array()
                .context("missing validator_responses")?;

            let mut sigs3 = Vec::new();
            let mut scores3 = Vec::new();
            for vr in vr3 {
                let sig_str = vr["signature"].as_str().unwrap_or("");
                let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
                sigs3.push(Bytes::from(hex::decode(sig_hex)?));
                scores3.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
            }

            // Use a random address as target -- definitely not whitelisted
            let bogus_target = Address::from([0xDE; 20]);
            let vault = contract_deployer::TradingVault::new(stack.vault, &operator_provider);
            let params = contract_deployer::TradingVault::ExecuteParams {
                target: bogus_target,
                data: Bytes::from(vec![0u8; 4]), // dummy calldata
                value: U256::ZERO,
                minOutput: min_output,
                outputToken: stack.token_b,
                intentHash: intent_hash_3,
                deadline: U256::from(deadline_3),
            };

            let result = vault.execute(params, sigs3, scores3).call().await;

            assert!(
                result.is_err(),
                "Non-whitelisted target should revert (PolicyCheckFailed)"
            );
            let err_str = format!("{:?}", result.err().expect("should revert"));
            eprintln!("        Bogus target: {bogus_target}");
            eprintln!(
                "        Reverted as expected: {}",
                &err_str[..std::cmp::min(err_str.len(), 200)]
            );
            eprintln!("        PASSED: Invalid target correctly rejected");
        }

        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Scenario 6: Min output not met                                ║
        // ╚══════════════════════════════════════════════════════════════════╝
        eprintln!("\n[6/6] Min output not met -- vault.execute() with outputAmount < minOutput...");
        {
            // Get fresh signatures
            let validate_body_4 =
                e2e_helpers::validate_trade(&http_client, &api_url, api_token).await?;
            let ih4_str = validate_body_4["intent_hash"]
                .as_str()
                .context("missing intent_hash")?;
            let ih4_stripped = ih4_str.strip_prefix("0x").unwrap_or(ih4_str);
            let ih4_bytes = hex::decode(ih4_stripped)?;
            let mut ih4_arr = [0u8; 32];
            ih4_arr.copy_from_slice(&ih4_bytes);
            let intent_hash_4 = FixedBytes::<32>::from(ih4_arr);

            let deadline_4 = validate_body_4["deadline"]
                .as_u64()
                .context("missing deadline")?;

            let vr4 = validate_body_4["validator_responses"]
                .as_array()
                .context("missing validator_responses")?;

            let mut sigs4 = Vec::new();
            let mut scores4 = Vec::new();
            for vr in vr4 {
                let sig_str = vr["signature"].as_str().unwrap_or("");
                let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
                sigs4.push(Bytes::from(hex::decode(sig_hex)?));
                scores4.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
            }

            // MockTarget.swap will mint only 100e18 tokens, but minOutput is 900e18
            let tiny_output = U256::from(100u64) * U256::from(10u64).pow(U256::from(18u64));
            let high_min = U256::from(900u64) * U256::from(10u64).pow(U256::from(18u64));
            let swap_data = contract_deployer::encode_mock_swap(stack.vault, tiny_output);

            let vault = contract_deployer::TradingVault::new(stack.vault, &operator_provider);
            let params = contract_deployer::TradingVault::ExecuteParams {
                target: stack.mock_target,
                data: Bytes::from(swap_data),
                value: U256::ZERO,
                minOutput: high_min,
                outputToken: stack.token_b,
                intentHash: intent_hash_4,
                deadline: U256::from(deadline_4),
            };

            let result = vault.execute(params, sigs4, scores4).call().await;

            assert!(
                result.is_err(),
                "Output below minOutput should revert (MinOutputNotMet)"
            );
            let err_str = format!("{:?}", result.err().expect("should revert"));
            eprintln!("        MockTarget outputs: {tiny_output}, minOutput required: {high_min}");
            eprintln!(
                "        Reverted as expected: {}",
                &err_str[..std::cmp::min(err_str.len(), 200)]
            );
            eprintln!("        PASSED: Min output not met correctly rejected");
        }

        eprintln!("\n========================================");
        eprintln!("  ADVERSARIAL CONTRACT PATHS: ALL 6 PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test timed out")?
}

// ═════════════════════════════════════════════════════════════════════════════
// Fee parity: Rust vs Solidity
// ═════════════════════════════════════════════════════════════════════════════

/// Convert a U256 (18-decimal fixed-point) to `rust_decimal::Decimal`.
///
/// On-chain values are in 18-decimal fixed-point (e.g., 100_000 * 1e18).
/// The Rust fee functions work with "human" units (e.g., 100_000 means 100k tokens).
/// This divides by 1e18 to convert from wei to human units.
fn u256_to_decimal(v: U256) -> Decimal {
    // U256 can be very large; use string round-trip for precision.
    let s = v.to_string();
    let raw: Decimal = s.parse().expect("U256 -> Decimal");
    let scale: Decimal = "1000000000000000000".parse().unwrap(); // 1e18
    raw / scale
}

/// Convert a `Decimal` (human units) back to a U256 (18-decimal fixed-point),
/// truncating fractional sub-wei.
fn decimal_to_u256(d: Decimal) -> U256 {
    let scale: Decimal = "1000000000000000000".parse().unwrap(); // 1e18
    let scaled = d * scale;
    // Truncate toward zero (floor for positive values)
    let truncated = scaled.trunc();
    let s = truncated.to_string();
    U256::from_str_radix(&s, 10).expect("Decimal -> U256")
}

/// Verify Rust fee calculations match on-chain Solidity FeeDistributor within tolerance.
///
/// Deploys full trade stack, deposits 100k tokens, does an initial settlement to
/// set HWM, then mints 20k gains. At three time checkpoints (30d, 90d, 365d),
/// computes fees via Rust functions, settles on-chain, and compares.
///
/// Tolerance: 1e12 wei (0.0001% relative for 18-decimal tokens at ~100k scale).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_fee_parity_rust_solidity() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    common::setup_sidecar_env();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(Duration::from_secs(600), async {
        // ── 1. Deploy full trade stack ───────────────────────────────────────
        eprintln!("\n[1/6] Deploying full trade stack on Anvil...");
        let anvil = Anvil::new().arg("--code-size-limit").arg("50000").try_spawn().context("Anvil spawn")?;
        let rpc_url = anvil.endpoint();

        let deployer_key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let deployer_addr = deployer_key.address();
        let deployer_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer_key))
            .connect_http(rpc_url.parse().unwrap());

        let operator_key: PrivateKeySigner = anvil.keys()[1].clone().into();
        let operator_addr = operator_key.address();

        let val_addrs: Vec<Address> = (3..6)
            .map(|i| {
                let k: PrivateKeySigner = anvil.keys()[i].clone().into();
                k.address()
            })
            .collect();

        let stack = contract_deployer::deploy_full_trade_stack(
            &deployer_provider,
            deployer_addr,
            operator_addr,
            val_addrs.clone(),
            2,
        )
        .await;
        eprintln!("        Vault:           {}", stack.vault);
        eprintln!("        FeeDistributor:  {}", stack.fee_distributor);
        eprintln!("        TokenA:          {}", stack.token_a);

        // ── 2. Read on-chain fee parameters ─────────────────────────────────
        eprintln!("[2/6] Reading on-chain fee parameters...");
        let (perf_bps_u256, mgmt_bps_u256, _val_share_bps_u256) =
            e2e_helpers::read_fee_params(&deployer_provider, stack.fee_distributor).await?;
        let perf_bps: u32 = perf_bps_u256.to::<u32>();
        let mgmt_bps: u32 = mgmt_bps_u256.to::<u32>();
        eprintln!("        performanceFeeBps = {perf_bps}");
        eprintln!("        managementFeeBps  = {mgmt_bps}");

        // ── 3. Deposit 100k tokenA and initialize HWM ──────────────────────
        eprintln!("[3/6] Depositing 100,000 tokenA and initializing HWM...");
        let deposit_amount = U256::from(100_000u64) * U256::from(10u64).pow(U256::from(18u64));

        let user_key: PrivateKeySigner = anvil.keys()[2].clone().into();
        let user_addr = user_key.address();
        let user_provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(user_key))
            .connect_http(rpc_url.parse().unwrap());

        e2e_helpers::mint_tokens(&deployer_provider, stack.token_a, user_addr, deposit_amount)
            .await?;
        e2e_helpers::approve_tokens(&user_provider, stack.token_a, stack.vault, deposit_amount)
            .await?;
        e2e_helpers::deposit_to_vault(&user_provider, stack.vault, deposit_amount, user_addr)
            .await?;

        // First settlement: initializes HWM and lastSettled timestamp.
        // On-chain, the first call sets lastSettled = block.timestamp and
        // HWM = currentAUM, then calculates zero fees (no gains, no elapsed time).
        let (init_perf, init_mgmt, init_hwm, _init_last_settled) =
            e2e_helpers::settle_fees_with_breakdown(
                &deployer_provider,
                stack.fee_distributor,
                stack.vault,
                stack.token_a,
            )
            .await?;
        eprintln!("        Initial settle: perf={init_perf}, mgmt={init_mgmt}, HWM={init_hwm}");
        assert_eq!(init_perf, U256::ZERO, "No perf fee on initial capital");
        assert_eq!(init_mgmt, U256::ZERO, "No mgmt fee on initial settle (zero elapsed)");
        assert_eq!(init_hwm, deposit_amount, "HWM should equal initial deposit");

        // ── 4. Mint 20k gains directly to vault ─────────────────────────────
        eprintln!("[4/6] Minting 20,000 tokenA gains to vault...");
        let gains_amount = U256::from(20_000u64) * U256::from(10u64).pow(U256::from(18u64));
        e2e_helpers::mint_tokens(&deployer_provider, stack.token_a, stack.vault, gains_amount)
            .await?;

        let aum_after_gains =
            e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;
        eprintln!("        Vault AUM after gains: {aum_after_gains}");

        // ── 5. Advance time and check parity at 3 checkpoints ──────────────
        eprintln!("[5/6] Fee parity checks at 30d, 90d, 365d checkpoints...");

        // Tolerance: 1e12 wei. For amounts around 100k * 1e18, this is ~0.0001% relative.
        // Solidity integer division truncates; Rust Decimal is arbitrary precision.
        // The mismatch comes from (a*b*c)/d in Solidity vs a*(b/d)*(c/d) in Rust.
        let tolerance = U256::from(10u64).pow(U256::from(12u64)); // 1e12

        // Checkpoint durations in seconds (cumulative advances).
        let checkpoints: &[(u64, &str)] = &[
            (30 * 86400, "30 days"),
            (60 * 86400, "90 days (cumulative)"),    // +60d = 90d total
            (275 * 86400, "365 days (cumulative)"),  // +275d = 365d total
        ];

        for (advance_secs, label) in checkpoints {
            eprintln!("\n        --- Checkpoint: {label} ---");

            // Read pre-settlement state
            let fd = contract_deployer::FeeDistributor::new(
                stack.fee_distributor,
                &deployer_provider,
            );
            let hwm_before = fd.highWaterMark(stack.vault).call().await.context("hwm")?;
            let last_settled_before = fd.lastSettled(stack.vault).call().await.context("lastSettled")?;

            // Advance time
            e2e_helpers::advance_anvil_time(&deployer_provider, *advance_secs).await?;

            // Read post-advance block timestamp to calculate elapsed
            let current_timestamp = e2e_helpers::get_block_timestamp(&deployer_provider).await?;
            let elapsed_secs = current_timestamp - last_settled_before.to::<u64>();

            // Current AUM (on-chain, after any previous fee deductions)
            let current_aum =
                e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;

            eprintln!("        AUM = {current_aum}");
            eprintln!("        HWM = {hwm_before}");
            eprintln!("        elapsed = {elapsed_secs}s");

            // ── Rust-side calculation ──────────────────────────────────
            let rust_aum = u256_to_decimal(current_aum);
            let rust_hwm = u256_to_decimal(hwm_before);

            let rust_perf_fee = trading_runtime::fees::calculate_performance_fee(
                rust_aum, rust_hwm, perf_bps,
            );
            let rust_mgmt_fee = trading_runtime::fees::calculate_management_fee(
                rust_aum, mgmt_bps, elapsed_secs,
            );

            let rust_perf_u256 = decimal_to_u256(rust_perf_fee);
            let rust_mgmt_u256 = decimal_to_u256(rust_mgmt_fee);

            eprintln!("        Rust perf fee: {rust_perf_u256}");
            eprintln!("        Rust mgmt fee: {rust_mgmt_u256}");

            // ── On-chain settlement ────────────────────────────────────
            let (sol_perf, sol_mgmt, new_hwm, _new_last_settled) =
                e2e_helpers::settle_fees_with_breakdown(
                    &deployer_provider,
                    stack.fee_distributor,
                    stack.vault,
                    stack.token_a,
                )
                .await?;

            eprintln!("        Sol  perf fee: {sol_perf}");
            eprintln!("        Sol  mgmt fee: {sol_mgmt}");
            eprintln!("        New HWM:       {new_hwm}");

            // ── Compare: performance fee ───────────────────────────────
            let perf_diff = if rust_perf_u256 > sol_perf {
                rust_perf_u256 - sol_perf
            } else {
                sol_perf - rust_perf_u256
            };
            eprintln!("        Perf fee diff: {perf_diff} (tolerance: {tolerance})");
            assert!(
                perf_diff <= tolerance,
                "Performance fee mismatch at {label}: Rust={rust_perf_u256}, Sol={sol_perf}, diff={perf_diff}"
            );

            // ── Compare: management fee ────────────────────────────────
            let mgmt_diff = if rust_mgmt_u256 > sol_mgmt {
                rust_mgmt_u256 - sol_mgmt
            } else {
                sol_mgmt - rust_mgmt_u256
            };
            eprintln!("        Mgmt fee diff: {mgmt_diff} (tolerance: {tolerance})");
            assert!(
                mgmt_diff <= tolerance,
                "Management fee mismatch at {label}: Rust={rust_mgmt_u256}, Sol={sol_mgmt}, diff={mgmt_diff}"
            );

            eprintln!("        PASS: Rust and Solidity agree within tolerance");
        }

        // ── 6. Final summary ────────────────────────────────────────────────
        eprintln!("\n[6/6] Final verification...");
        let final_aum =
            e2e_helpers::vault_total_assets(&deployer_provider, stack.vault).await?;
        let fd = contract_deployer::FeeDistributor::new(
            stack.fee_distributor,
            &deployer_provider,
        );
        let final_accumulated = fd.accumulatedFees(stack.token_a).call().await?;
        let final_hwm = fd.highWaterMark(stack.vault).call().await?;

        eprintln!("        Final vault AUM:       {final_aum}");
        eprintln!("        Final accumulated fees: {final_accumulated}");
        eprintln!("        Final HWM:             {final_hwm}");

        // Sanity: fees were extracted
        assert!(
            final_accumulated > U256::ZERO,
            "Some fees should have been accumulated across 3 checkpoints"
        );
        // Sanity: vault lost value to fees
        let total_deposited_and_gained = deposit_amount + gains_amount;
        assert!(
            final_aum < total_deposited_and_gained,
            "Vault AUM should be less than deposited + gains after fee extraction"
        );

        eprintln!("\n========================================");
        eprintln!("  FEE PARITY RUST vs SOLIDITY: PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test timed out")?
}
