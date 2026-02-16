//! Tier 3 — Full multi-blueprint pipeline test.
//!
//! Exercises both blueprints end-to-end with real infrastructure:
//!   - 3 real `ValidatorServer` instances with EIP-712 signers + AI scoring
//!   - Real `TradeValidator` contract on Anvil with 2-of-3 multisig
//!   - Real `Trading HTTP API` pointing at the real validators
//!   - `MultiHarness` running **both** the trading and validator blueprints
//!   - On-chain signature verification
//!
//! Gate: `SIDECAR_E2E=1` + `ZAI_API_KEY` + Docker + forge artifacts + TNT artifacts.
//!
//! ```bash
//! SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_full_pipeline -- --nocapture
//! ```

mod common;

use alloy::network::EthereumWallet;
use alloy::node_bindings::Anvil;
use alloy::primitives::{Address, U256};
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolValue;
use anyhow::{Context, Result};
use blueprint_sdk::alloy::primitives::Bytes;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use trading_validator_lib::risk_evaluator::AiProvider;

use common::contract_deployer;
use common::validators;

use trading_blueprint_lib::{
    JOB_PROVISION, JOB_STATUS, TradingControlRequest, TradingProvisionOutput,
    TradingProvisionRequest, TradingStatusResponse,
};

/// Extract raw key bytes from Anvil pre-funded accounts for validator indices.
fn validator_key_bytes(anvil: &alloy::node_bindings::AnvilInstance, indices: &[usize]) -> Vec<Vec<u8>> {
    indices.iter().map(|&i| anvil.keys()[i].to_bytes().to_vec()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_full_multi_blueprint_pipeline() -> Result<()> {
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

    common::setup_log();
    // Force the local sidecar image — .env may have the remote image
    unsafe {
        std::env::set_var("SIDECAR_IMAGE", "tangle-sidecar:local");
        std::env::set_var("SIDECAR_PULL_IMAGE", "false");
        std::env::set_var("SIDECAR_PUBLIC_HOST", "127.0.0.1");
        std::env::set_var("REQUEST_TIMEOUT_SECS", "60");
    }
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;

    let result = timeout(Duration::from_secs(900), async {
        // ╔══════════════════════════════════════════════════════════════╗
        // ║  1. Deploy on-chain infrastructure on Anvil                 ║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("\n[1/7] Deploying on-chain infrastructure...");
        let anvil = Anvil::new().try_spawn().context("Anvil")?;
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

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  2. Start 3 AI-powered validator servers (Validator Blueprint)║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("[2/7] Starting 3 AI-powered validator servers (GLM-4.7)...");
        let model = std::env::var("AI_MODEL").unwrap_or_else(|_| "glm-4.7".into());
        let endpoint = std::env::var("AI_API_ENDPOINT")
            .unwrap_or_else(|_| "https://api.z.ai/api/coding/paas/v4".into());

        let ai_provider = AiProvider::Zai {
            api_key: api_key.clone(),
            model: model.clone(),
            endpoint: endpoint.clone(),
        };

        let val_keys = validator_key_bytes(&anvil, &[3, 4, 5]);
        let cluster = validators::start_validator_cluster(
            &val_keys,
            tv_addr,
            vault_addr,
            Some(ai_provider),
        )
        .await;

        for (i, (ep, addr)) in cluster
            .endpoints
            .iter()
            .zip(cluster.validator_addresses.iter())
            .enumerate()
        {
            eprintln!("        Validator {} @ {} ({})", i + 1, ep, addr);
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  3. Start the Trading HTTP API with real ValidatorClient     ║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("[3/7] Starting Trading HTTP API...");
        let api_token = "e2e-test-token";

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
            api_token: api_token.to_string(),
            vault_address: format!("{vault_addr}"),
            validator_endpoints: cluster.endpoints.clone(),
            validation_deadline_secs: 3600,
            bot_id: "e2e-test-bot".to_string(),
            paper_trade: false,
            operator_address: String::new(),
            sidecar_url: String::new(),
            sidecar_token: String::new(),
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

        // Set env for the trading blueprint to find the API
        unsafe {
            std::env::set_var("TRADING_API_URL", &api_url);
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  4. Validate a trade through the full pipeline              ║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("[4/7] Validating a trade through the full pipeline...");

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;

        // Use real well-known mainnet token addresses so the AI can evaluate
        // the trade realistically (WETH → USDC swap on Uniswap V3)
        let weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
        let usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

        let validate_resp = http_client
            .post(format!("{api_url}/validate"))
            .header("Authorization", format!("Bearer {api_token}"))
            .json(&serde_json::json!({
                "strategy_id": "e2e-full",
                "action": "swap",
                "token_in": weth,
                "token_out": usdc,
                "amount_in": "1000",
                "min_amount_out": "950",
                "target_protocol": "uniswap_v3",
                "deadline_secs": 3600
            }))
            .send()
            .await
            .context("POST /validate")?;

        assert!(validate_resp.status().is_success(), "Validate should succeed");
        let validate_body: serde_json::Value = validate_resp.json().await?;

        eprintln!("        approved={}", validate_body["approved"]);
        eprintln!("        aggregate_score={}", validate_body["aggregate_score"]);

        let validator_responses = validate_body["validator_responses"]
            .as_array()
            .context("missing validator_responses")?;
        assert_eq!(validator_responses.len(), 3, "All 3 validators should respond");

        for (i, vr) in validator_responses.iter().enumerate() {
            eprintln!(
                "        Validator {}: score={}, reasoning={}",
                i + 1,
                vr["score"],
                vr["reasoning"].as_str().unwrap_or("?").chars().take(80).collect::<String>()
            );
            let sig = vr["signature"].as_str().unwrap_or("");
            let zero_sig = format!("0x{}", "00".repeat(65));
            assert_ne!(sig, zero_sig, "Signature should be real EIP-712");
        }

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  5. Verify 2-of-3 signatures on-chain                      ║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("[5/7] Verifying signatures on-chain...");

        let intent_hash = validate_body["intent_hash"]
            .as_str()
            .context("missing intent_hash")?;
        let ih_stripped = intent_hash.strip_prefix("0x").unwrap_or(intent_hash);
        let ih_bytes = hex::decode(ih_stripped)?;
        let mut ih_arr = [0u8; 32];
        ih_arr.copy_from_slice(&ih_bytes);

        let mut sigs = Vec::new();
        let mut scores = Vec::new();
        for vr in validator_responses.iter().take(2) {
            let sig_str = vr["signature"].as_str().unwrap_or("");
            let sig_hex = sig_str.strip_prefix("0x").unwrap_or(sig_str);
            sigs.push(alloy::primitives::Bytes::from(hex::decode(sig_hex)?));
            scores.push(U256::from(vr["score"].as_u64().unwrap_or(0)));
        }

        // Use the exact deadline that validators signed over (returned by the HTTP API)
        let signed_deadline = validate_body["deadline"]
            .as_u64()
            .context("missing deadline in response")?;
        eprintln!("        Using signed deadline: {signed_deadline}");

        let tv = contract_deployer::TradeValidator::new(tv_addr, &deployer_provider);
        let on_chain = tv
            .validateWithSignatures(
                alloy::primitives::FixedBytes::<32>::from(ih_arr),
                vault_addr,
                sigs,
                scores,
                U256::from(signed_deadline),
            )
            .call()
            .await?;

        eprintln!(
            "        On-chain: approved={}, validCount={}",
            on_chain.approved, on_chain.validCount
        );
        assert!(on_chain.approved, "On-chain should approve 2-of-3");
        assert_eq!(on_chain.validCount, U256::from(2));

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  6. Spawn MultiHarness with both blueprints                 ║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("[6/7] Spawning MultiHarness (trading + validator blueprints)...");

        let Some(multi) = common::spawn_multi_harness().await? else {
            eprintln!("        Skipping harness test: TNT artifacts not found");
            return Ok(());
        };

        let trading = multi.handle("trading").expect("trading handle");
        let validator = multi.handle("validator").expect("validator handle");

        eprintln!(
            "        Trading blueprint: service_id={}",
            trading.service_id()
        );
        eprintln!(
            "        Validator blueprint: service_id={}",
            validator.service_id()
        );

        // ╔══════════════════════════════════════════════════════════════╗
        // ║  7. Test trading bot provisioning via MultiHarness          ║
        // ╚══════════════════════════════════════════════════════════════╝
        eprintln!("[7/7] Testing trading bot provisioning via MultiHarness...");

        let provision_payload = TradingProvisionRequest {
            name: "full-pipeline-bot".to_string(),
            strategy_type: "dex".to_string(),
            strategy_config_json: r#"{"max_slippage":0.5}"#.to_string(),
            risk_params_json: r#"{"max_drawdown_pct":5.0}"#.to_string(),
            env_json: String::new(),
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
        }
        .abi_encode();

        let sub = trading
            .submit_job(JOB_PROVISION, Bytes::from(provision_payload))
            .await?;
        let output = trading
            .wait_for_job_result_with_deadline(sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let receipt = TradingProvisionOutput::abi_decode(&output)?;
        eprintln!(
            "        Provisioned: sandbox_id={}, workflow_id={}",
            receipt.sandbox_id, receipt.workflow_id
        );
        assert!(!receipt.sandbox_id.is_empty());

        // Check status via the trading handle
        let status_payload = TradingControlRequest {
            sandbox_id: receipt.sandbox_id.clone(),
        }
        .abi_encode();
        let status_sub = trading
            .submit_job(JOB_STATUS, Bytes::from(status_payload))
            .await?;
        let status_output = trading
            .wait_for_job_result_with_deadline(status_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let status_receipt = TradingStatusResponse::abi_decode(&status_output)?;
        eprintln!(
            "        Status: state={}, active={}",
            status_receipt.state, status_receipt.trading_active
        );
        assert!(status_receipt.trading_active);

        // Verify we can see both blueprint handles
        assert!(multi.handle("validator").is_some(), "Validator handle should exist");
        eprintln!("        Validator blueprint handle confirmed (service_id={})", validator.service_id());

        // NOTE: The seeded Tangle testnet only registers service 0. Submitting
        // jobs to service 1 (validator) reverts on-chain. The validator blueprint
        // is already tested in Tier 2 (tangle_e2e.rs). Here we verified that
        // MultiHarness correctly spawns both blueprints and routes trading jobs.

        multi.shutdown().await;

        eprintln!("\n========================================");
        eprintln!("  FULL MULTI-BLUEPRINT PIPELINE: PASSED  ");
        eprintln!("========================================");
        Ok(())
    })
    .await;

    drop(guard);
    result.context("test_full_multi_blueprint_pipeline timed out")?
}
