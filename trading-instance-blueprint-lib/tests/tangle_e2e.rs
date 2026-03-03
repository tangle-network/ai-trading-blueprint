//! Tier 2 — Instance Blueprint Tangle E2E tests.
//!
//! Exercises the full BlueprintHarness → TangleLayer → Instance Router pipeline
//! for the instance (single-bot-per-service) variant.
//!
//! Gate: `SIDECAR_E2E=1` + Docker + TNT core artifacts + forge build artifacts.
//!
//! ```bash
//! SIDECAR_E2E=1 cargo test -p trading-instance-blueprint-lib --test tangle_e2e -- --nocapture
//! ```

mod common;

use alloy::node_bindings::Anvil;
use alloy::sol_types::SolValue;
use anyhow::{Context, Result};
use blueprint_sdk::alloy::primitives::Bytes;
use tokio::time::timeout;

use trading_instance_blueprint_lib::{
    JOB_CONFIGURE, JOB_START_TRADING, JOB_STATUS, JOB_STOP_TRADING, JsonResponse,
    TradingConfigureRequest, TradingControlRequest, TradingStatusResponse, clear_instance_bot_id,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_instance_tangle_lifecycle() -> Result<()> {
    if std::env::var("SIDECAR_E2E").ok().as_deref() != Some("1") {
        eprintln!("Skipping tangle_e2e: set SIDECAR_E2E=1 to run");
        return Ok(());
    }

    common::setup_log();
    let _state_dir = common::init_test_env();
    let guard = common::HARNESS_LOCK.lock().await;
    let _ = clear_instance_bot_id();

    let result = timeout(common::ANVIL_TEST_TIMEOUT, async {
        // ── 1. Start Anvil ──────────────────────────────────────────────
        eprintln!("[setup] Starting Anvil...");
        let anvil = Anvil::new()
            .arg("--code-size-limit")
            .arg("50000")
            .try_spawn()
            .context("Failed to spawn Anvil")?;
        let _rpc_url = anvil.endpoint();

        // ── 2. Set up sidecar env + spawn BlueprintHarness ──────────────
        unsafe {
            std::env::set_var("TRADING_API_URL", "http://127.0.0.1:9100");
        }
        common::setup_sidecar_env();

        let Some(harness) = spawn_instance_harness().await? else {
            eprintln!("Skipping: TNT artifacts not found");
            return Ok(());
        };
        eprintln!("[setup] Instance BlueprintHarness spawned");

        // ── 3. Seed singleton (instance lifecycle is operator API) ───────
        let (_bot_id, sandbox_id) = common::fixtures::seed_instance_bot("dex");
        eprintln!("[setup] Seeded singleton bot for job routing checks: {sandbox_id}");

        // ── 4. JOB_STATUS (4) — singleton lookup path ───────────────────
        eprintln!("[test] Submitting JOB_STATUS...");
        let status_payload = TradingControlRequest {
            sandbox_id: sandbox_id.clone(),
        }
        .abi_encode();
        let status_sub = harness
            .submit_job(JOB_STATUS, Bytes::from(status_payload))
            .await?;
        let status_output = harness
            .wait_for_job_result_with_deadline(status_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let status = TradingStatusResponse::abi_decode(&status_output)?;

        eprintln!(
            "        state={}, trading_active={}",
            status.state, status.trading_active
        );
        assert!(status.trading_active);
        assert_eq!(status.sandbox_id, sandbox_id);

        // ── 5. JOB_CONFIGURE (1) ────────────────────────────────────────
        eprintln!("[test] Submitting JOB_CONFIGURE...");
        let configure_payload = TradingConfigureRequest {
            sandbox_id: sandbox_id.clone(),
            strategy_config_json: r#"{"max_slippage":0.3}"#.to_string(),
            risk_params_json: r#"{"max_drawdown_pct":3.0}"#.to_string(),
        }
        .abi_encode();
        let config_sub = harness
            .submit_job(JOB_CONFIGURE, Bytes::from(configure_payload))
            .await?;
        let config_output = harness
            .wait_for_job_result_with_deadline(config_sub, common::JOB_RESULT_TIMEOUT)
            .await?;
        let config_receipt = JsonResponse::abi_decode(&config_output)?;
        eprintln!("        {}", config_receipt.json);
        assert!(config_receipt.json.contains("configured"));

        // ── 6. JOB_STOP_TRADING (3) ─────────────────────────────────────
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

        // ── 7. JOB_START_TRADING (2) ─────────────────────────────────────
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

        eprintln!("\n[done] Instance job routing checks completed successfully!");
        harness.shutdown().await;
        Ok(())
    })
    .await;

    let _ = clear_instance_bot_id();
    drop(guard);
    result.context("test_instance_tangle_lifecycle timed out")?
}

/// Spawn a `BlueprintHarness` for the instance blueprint router.
async fn spawn_instance_harness() -> Result<Option<blueprint_anvil_testing_utils::BlueprintHarness>>
{
    use blueprint_anvil_testing_utils::{BlueprintHarness, missing_tnt_core_artifacts};
    use std::time::Duration;

    match BlueprintHarness::builder(trading_instance_blueprint_lib::router())
        .poll_interval(Duration::from_millis(50))
        .spawn()
        .await
    {
        Ok(harness) => Ok(Some(harness)),
        Err(err) => {
            if missing_tnt_core_artifacts(&err) {
                eprintln!("Skipping test: TNT core artifacts not found: {err}");
                Ok(None)
            } else {
                Err(err)
            }
        }
    }
}
