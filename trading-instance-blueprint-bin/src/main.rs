//! Binary runner for the AI trading instance blueprint.
//!
//! Simplified version of the cloud (fleet) binary — runs exactly ONE trading bot
//! per service instance. No webhook/polymarket/x402 producers, no GC.
//! Initializes operator context, spawns reaper + workflow cron + operator API.

use blueprint_producers_extra::cron::CronJob;
use blueprint_sdk::contexts::tangle::TangleClientContext;
use blueprint_sdk::runner::BlueprintRunner;
use blueprint_sdk::runner::config::BlueprintEnvironment;
use blueprint_sdk::runner::tangle::config::TangleConfig;
use blueprint_sdk::tangle::{TangleConsumer, TangleProducer};
use trading_blueprint_lib::graceful_consumer::GracefulConsumer;
use trading_instance_blueprint_lib::JOB_WORKFLOW_TICK;
use trading_blueprint_lib::context::TradingOperatorContext;

#[tokio::main]
#[allow(clippy::result_large_err)]
async fn main() -> Result<(), blueprint_sdk::Error> {
    dotenvy::dotenv().ok();
    setup_log();

    // ── 1. Load blueprint environment + connect to Tangle ────────────────
    let env = BlueprintEnvironment::load()?;

    // ── Registration mode: write payload and exit early ──────────────────
    if env.registration_mode() {
        let max_capacity = 1u32; // Instance = exactly 1 bot
        let api_endpoint = std::env::var("OPERATOR_API_ENDPOINT").unwrap_or_default();
        let strategies = std::env::var("SUPPORTED_STRATEGIES").unwrap_or_default();
        let payload = trading_blueprint_lib::registration::trading_registration_payload(
            max_capacity,
            &api_endpoint,
            &strategies,
        );
        let path = blueprint_sdk::registration::write_registration_inputs(&env, payload)
            .await
            .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?;
        tracing::info!(
            "Trading instance registration payload written to {}",
            path.display()
        );
        return Ok(());
    }

    let tangle_client = env
        .tangle_client()
        .await
        .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?;

    let service_id = env
        .protocol_settings
        .tangle()
        .map_err(|e| blueprint_sdk::Error::Other(e.to_string()))?
        .service_id
        .ok_or_else(|| blueprint_sdk::Error::Other("SERVICE_ID missing".into()))?;

    tracing::info!("Starting trading instance blueprint for service {service_id}");

    // ── 2. Initialize operator context ───────────────────────────────────
    let operator_address = std::env::var("OPERATOR_ADDRESS").unwrap_or_default();
    let private_key = std::env::var("PRIVATE_KEY").unwrap_or_default();

    let market_data_base_url = std::env::var("MARKET_DATA_BASE_URL")
        .unwrap_or_else(|_| "https://api.coingecko.com/api/v3".to_string());

    let validation_deadline_secs: u64 = std::env::var("VALIDATION_DEADLINE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600);

    let min_validator_score: u32 = std::env::var("VALIDATOR_MIN_SCORE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);

    let strategy_registry_address =
        std::env::var("STRATEGY_REGISTRY_ADDRESS").unwrap_or_default();
    let fee_distributor_address =
        std::env::var("FEE_DISTRIBUTOR_ADDRESS").unwrap_or_default();

    let ctx = TradingOperatorContext {
        operator_address,
        private_key,
        service_id,
        market_data_base_url,
        validation_deadline_secs,
        min_validator_score,
        strategy_registry_address,
        fee_distributor_address,
    };

    if let Err(e) = trading_blueprint_lib::context::init_operator_context(ctx) {
        tracing::error!("Failed to init operator context: {e}");
    }

    // ── 3. Bootstrap workflows from on-chain state ───────────────────────
    if let Err(err) =
        ai_agent_sandbox_blueprint_lib::bootstrap_workflows_from_chain(&tangle_client, service_id)
            .await
    {
        tracing::error!("Failed to load workflows from chain: {err}");
    }

    // ── 4. Reconcile sandbox state with Docker ───────────────────────────
    sandbox_runtime::reaper::reconcile_on_startup().await;

    // ── 5. Spawn reaper background task (no GC — single bot) ─────────────
    {
        let config = sandbox_runtime::runtime::SidecarRuntimeConfig::load();
        let reaper_interval = config.sandbox_reaper_interval;

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(reaper_interval));
            loop {
                interval.tick().await;
                sandbox_runtime::reaper::reaper_tick().await;
            }
        });
    }

    // ── 5b. Spawn periodic fee settlement ────────────────────────────────
    {
        let fee_interval: u64 = std::env::var("FEE_SETTLEMENT_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(fee_interval));
            loop {
                interval.tick().await;
                trading_blueprint_lib::fees::settle_all_fees().await;
            }
        });
    }

    // ── 6. Spawn operator API server ─────────────────────────────────────
    {
        let port: u16 = std::env::var("OPERATOR_API_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(9200);

        let router = trading_instance_blueprint_lib::operator_api::build_instance_router();
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
            .await
            .map_err(|e| blueprint_sdk::Error::Other(format!("Operator API bind failed: {e}")))?;
        tracing::info!("Instance operator API listening on 0.0.0.0:{port}");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                tracing::error!("Operator API server error: {e}");
            }
        });
    }

    // ── 7. Set up Tangle producer/consumer + cron workflow tick ───────────
    let tangle_producer = TangleProducer::new(tangle_client.clone(), service_id);
    let tangle_consumer = GracefulConsumer::new(TangleConsumer::new(tangle_client));

    let tangle_config = {
        let mut config = TangleConfig::default();
        let api_endpoint = std::env::var("OPERATOR_API_ENDPOINT").unwrap_or_default();
        let strategies = std::env::var("SUPPORTED_STRATEGIES").unwrap_or_default();
        let inputs = trading_blueprint_lib::registration::trading_registration_payload(
            1, // instance = single bot
            &api_endpoint,
            &strategies,
        );
        config = config.with_registration_inputs(inputs);
        config
    };

    let cron_schedule =
        std::env::var("WORKFLOW_CRON_SCHEDULE").unwrap_or_else(|_| "0 * * * * *".to_string());
    let workflow_cron = CronJob::new(JOB_WORKFLOW_TICK, cron_schedule.as_str())
        .await
        .map_err(|err| blueprint_sdk::Error::Other(format!("Invalid workflow cron: {err}")))?;

    // ── 8. Build and run the blueprint ───────────────────────────────────
    let result = BlueprintRunner::builder(tangle_config, env)
        .router(trading_instance_blueprint_lib::router())
        .producer(tangle_producer)
        .producer(workflow_cron)
        .consumer(tangle_consumer)
        .with_shutdown_handler(async {
            tracing::info!("Shutting down trading instance blueprint");
        })
        .run()
        .await;

    if let Err(e) = result {
        tracing::error!("Runner failed: {e:?}");
        tracing::info!("Runner exited but operator API server continues running");
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    }

    Ok(())
}

fn setup_log() {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{EnvFilter, fmt};
    if tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env())
        .try_init()
        .is_err()
    {}
}
