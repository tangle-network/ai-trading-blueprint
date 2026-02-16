//! Binary runner for the consolidated AI trading blueprint.
//!
//! Initializes the operator context, sandbox runtime (reaper, GC), and runs
//! the Blueprint SDK runner with Tangle producer/consumer for on-chain job
//! dispatch plus a cron producer for periodic workflow ticks.
//!
//! Vault deployment is handled by the Solidity `onServiceInitialized` hook.
//! The operator binary focuses on sidecar management and trading loop execution.

mod operator_api;

use blueprint_producers_extra::cron::CronJob;
use blueprint_sdk::contexts::tangle::TangleClientContext;
use blueprint_sdk::runner::BlueprintRunner;
use blueprint_sdk::runner::config::BlueprintEnvironment;
use blueprint_sdk::runner::tangle::config::TangleConfig;
use blueprint_sdk::tangle::{TangleConsumer, TangleProducer};
use trading_blueprint_lib::JOB_WORKFLOW_TICK;
use trading_blueprint_lib::context::TradingOperatorContext;

#[cfg(feature = "qos")]
use blueprint_qos::QoSServiceBuilder;
#[cfg(feature = "qos")]
use blueprint_qos::heartbeat::{HeartbeatConfig, HeartbeatConsumer};
#[cfg(feature = "qos")]
use blueprint_qos::metrics::MetricsConfig;
#[cfg(feature = "qos")]
use std::sync::Arc;

#[cfg(feature = "qos")]
#[derive(Clone)]
struct TradingHeartbeatConsumer;

#[cfg(feature = "qos")]
impl HeartbeatConsumer for TradingHeartbeatConsumer {
    fn send_heartbeat(
        &self,
        status: &blueprint_qos::heartbeat::HeartbeatStatus,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = blueprint_qos::error::Result<()>> + Send + 'static>,
    > {
        let service_id = status.service_id;
        let status_code = status.status_code;
        let ts = status.timestamp;
        Box::pin(async move {
            tracing::info!("Trading heartbeat: service={service_id} status={status_code} ts={ts}");
            Ok(())
        })
    }
}

#[tokio::main]
#[allow(clippy::result_large_err)]
async fn main() -> Result<(), blueprint_sdk::Error> {
    setup_log();

    // ── 1. QoS service (heartbeat + metrics) ─────────────────────────────────
    #[cfg(feature = "qos")]
    {
        let qos_enabled = std::env::var("QOS_ENABLED")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        if qos_enabled {
            let metrics_interval = std::env::var("QOS_METRICS_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60);

            let dry_run = std::env::var("QOS_DRY_RUN")
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(true);

            let heartbeat_config = build_heartbeat_config();

            let mut builder = QoSServiceBuilder::<TradingHeartbeatConsumer>::new()
                .with_metrics_config(MetricsConfig::default())
                .with_dry_run(dry_run);

            if let Some(hb_config) = heartbeat_config {
                let rpc_endpoint = std::env::var("HTTP_RPC_ENDPOINT")
                    .or_else(|_| std::env::var("RPC_URL"))
                    .unwrap_or_else(|_| "http://localhost:9944".to_string());

                let keystore_uri = std::env::var("KEYSTORE_URI")
                    .unwrap_or_else(|_| "file:///tmp/keystore".to_string());

                let registry_address = hb_config.status_registry_address;

                tracing::info!(
                    "Trading QoS heartbeat: service_id={}, blueprint_id={}, interval={}s",
                    hb_config.service_id, hb_config.blueprint_id, hb_config.interval_secs,
                );

                builder = builder
                    .with_heartbeat_config(hb_config)
                    .with_heartbeat_consumer(Arc::new(TradingHeartbeatConsumer))
                    .with_http_rpc_endpoint(rpc_endpoint)
                    .with_keystore_uri(keystore_uri)
                    .with_status_registry_address(registry_address);
            }

            match builder.build().await {
                Ok(qos_service) => {
                    tracing::info!(
                        "Trading QoS initialized (interval={metrics_interval}s, dry_run={dry_run})"
                    );

                    if let Some(hb) = qos_service.heartbeat_service() {
                        match hb.start_heartbeat().await {
                            Ok(()) => tracing::info!("Trading heartbeat started"),
                            Err(e) => tracing::error!("Failed to start heartbeat: {e}"),
                        }
                    }

                    // Push trading-specific metrics to QoS provider
                    if let Some(provider) = qos_service.provider() {
                        tokio::spawn(async move {
                            use blueprint_qos::metrics::types::MetricsProvider;

                            let mut interval = tokio::time::interval(
                                std::time::Duration::from_secs(metrics_interval),
                            );
                            loop {
                                interval.tick().await;
                                let bot_count = trading_blueprint_lib::state::bots()
                                    .map(|s| s.values().map(|v| v.len()).unwrap_or(0))
                                    .unwrap_or(0);
                                provider
                                    .add_on_chain_metric(
                                        "active_trading_bots".to_string(),
                                        bot_count as u64,
                                    )
                                    .await;
                            }
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("Trading QoS init failed: {e} — continuing without QoS");
                }
            }
        }
    }

    // ── 2. Load blueprint environment + connect to Tangle ────────────────────
    let env = BlueprintEnvironment::load()?;

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

    tracing::info!("Starting trading blueprint for service {service_id}");

    // ── 3. Initialize operator context ───────────────────────────────────────
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

    // ── 4. Bootstrap workflows from on-chain state ───────────────────────────
    if let Err(err) =
        ai_agent_sandbox_blueprint_lib::bootstrap_workflows_from_chain(&tangle_client, service_id)
            .await
    {
        tracing::error!("Failed to load workflows from chain: {err}");
    }

    // ── 5. Reconcile sandbox state with Docker ───────────────────────────────
    sandbox_runtime::reaper::reconcile_on_startup().await;

    // ── 6. Spawn reaper + GC background tasks ────────────────────────────────
    {
        let config = sandbox_runtime::runtime::SidecarRuntimeConfig::load();
        let reaper_interval = config.sandbox_reaper_interval;
        let gc_interval = config.sandbox_gc_interval;

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(reaper_interval));
            loop {
                interval.tick().await;
                sandbox_runtime::reaper::reaper_tick().await;
            }
        });

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(gc_interval));
            loop {
                interval.tick().await;
                sandbox_runtime::reaper::gc_tick().await;
            }
        });
    }

    // ── 6b. Spawn periodic fee settlement ─────────────────────────────────────
    {
        let fee_interval: u64 = std::env::var("FEE_SETTLEMENT_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600); // Default: every hour

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(fee_interval));
            loop {
                interval.tick().await;
                trading_blueprint_lib::fees::settle_all_fees().await;
            }
        });
    }

    // ── 6c. Spawn operator API server ─────────────────────────────────────
    {
        let port: u16 = std::env::var("OPERATOR_API_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(9200);

        let router = operator_api::build_operator_router();
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
            .await
            .map_err(|e| blueprint_sdk::Error::Other(format!("Operator API bind failed: {e}")))?;
        tracing::info!("Operator API listening on 0.0.0.0:{port}");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                tracing::error!("Operator API server error: {e}");
            }
        });
    }

    // ── 7. Set up Tangle producer/consumer + cron workflow tick ───────────────
    let tangle_producer = TangleProducer::new(tangle_client.clone(), service_id);
    let tangle_consumer = TangleConsumer::new(tangle_client);

    let tangle_config = {
        let mut config = TangleConfig::default();
        if let Ok(cap_str) = std::env::var("OPERATOR_MAX_CAPACITY") {
            if let Ok(capacity) = cap_str.parse::<u32>() {
                tracing::info!("Registering with OPERATOR_MAX_CAPACITY={capacity}");
                let mut inputs = vec![0u8; 32];
                inputs[28..32].copy_from_slice(&capacity.to_be_bytes());
                config = config.with_registration_inputs(inputs);
            }
        }
        config
    };

    let cron_schedule =
        std::env::var("WORKFLOW_CRON_SCHEDULE").unwrap_or_else(|_| "0 * * * * *".to_string());
    let workflow_cron = CronJob::new(JOB_WORKFLOW_TICK, cron_schedule.as_str())
        .await
        .map_err(|err| blueprint_sdk::Error::Other(format!("Invalid workflow cron: {err}")))?;

    // ── 8. x402 payment gateway (cross-chain stablecoin payments) ───────────
    #[cfg(feature = "x402")]
    let x402_producer = {
        use blueprint_sdk::x402::{X402Config, X402Gateway};

        let x402_config_path = std::env::var("X402_CONFIG_PATH")
            .unwrap_or_else(|_| "config/x402.toml".to_string());

        if std::path::Path::new(&x402_config_path).exists() {
            match X402Config::from_toml(&x402_config_path) {
                Ok(config) => {
                    let pricing_toml = std::env::var("JOB_PRICING_CONFIG_PATH")
                        .unwrap_or_else(|_| "config/job_pricing.toml".to_string());

                    let job_pricing = match std::fs::read_to_string(&pricing_toml) {
                        Ok(content) => load_job_pricing(&content).unwrap_or_else(|e| {
                            tracing::warn!("Failed to parse job pricing: {e}");
                            std::collections::HashMap::new()
                        }),
                        Err(_) => {
                            tracing::warn!("No job_pricing.toml found — x402 jobs will be free");
                            std::collections::HashMap::new()
                        }
                    };

                    match X402Gateway::new(config, job_pricing) {
                        Ok((gateway, producer)) => {
                            tracing::info!("x402 payment gateway initialized");
                            Some((gateway, producer))
                        }
                        Err(e) => {
                            tracing::error!("Failed to create x402 gateway: {e} — continuing without x402");
                            None
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to parse x402 config: {e} — continuing without x402");
                    None
                }
            }
        } else {
            tracing::info!("No x402 config at {x402_config_path} — x402 gateway disabled");
            None
        }
    };

    // ── 8b. Webhook gateway (optional — only if config exists) ──────────────
    let webhook_producer = {
        let webhook_config_path = std::env::var("WEBHOOK_CONFIG")
            .unwrap_or_else(|_| "webhooks.toml".into());

        if std::path::Path::new(&webhook_config_path).exists() {
            match blueprint_webhooks::WebhookConfig::from_toml(&webhook_config_path) {
                Ok(mut wh_config) => {
                    wh_config.service_id = service_id;
                    match blueprint_webhooks::WebhookGateway::new(wh_config) {
                        Ok((gateway, producer)) => {
                            tracing::info!("Webhook gateway initialized from {webhook_config_path}");
                            Some((gateway, producer))
                        }
                        Err(e) => {
                            tracing::error!("Failed to create webhook gateway: {e} — continuing without webhooks");
                            None
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to parse webhook config: {e} — continuing without webhooks");
                    None
                }
            }
        } else {
            tracing::info!("No webhook config at {webhook_config_path} — webhook gateway disabled");
            None
        }
    };

    // ── 8c. Polymarket WebSocket producer (optional) ─────────────────────────
    let polymarket_producer = {
        if let Ok(markets_str) = std::env::var("POLYMARKET_MARKETS") {
            let market_ids: Vec<String> = markets_str
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            if !market_ids.is_empty() {
                let threshold = std::env::var("POLYMARKET_THRESHOLD_PCT")
                    .ok()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(5.0);

                tracing::info!(
                    markets = market_ids.len(),
                    threshold_pct = threshold,
                    "Starting Polymarket WebSocket producer"
                );

                Some(trading_blueprint_lib::polymarket_ws::PolymarketProducer::new(
                    market_ids,
                    threshold,
                    service_id,
                ))
            } else {
                None
            }
        } else {
            None
        }
    };

    // ── 9. Build and run the blueprint ───────────────────────────────────────
    let mut runner = BlueprintRunner::builder(tangle_config, env)
        .router(trading_blueprint_lib::router())
        .producer(tangle_producer)
        .producer(workflow_cron)
        .consumer(tangle_consumer);

    if let Some((gateway, producer)) = webhook_producer {
        runner = runner.producer(producer).background_service(gateway);
    }

    if let Some(pm_producer) = polymarket_producer {
        runner = runner.producer(pm_producer);
    }

    #[cfg(feature = "x402")]
    if let Some((gateway, producer)) = x402_producer {
        runner = runner.producer(producer).background_service(gateway);
    }

    let result = runner
        .with_shutdown_handler(async {
            tracing::info!("Shutting down trading blueprint");
        })
        .run()
        .await;

    if let Err(e) = result {
        tracing::error!("Runner failed: {e:?}");
    }

    Ok(())
}

#[cfg(feature = "qos")]
fn build_heartbeat_config() -> Option<HeartbeatConfig> {
    use std::str::FromStr;

    let service_id: u64 = std::env::var("SERVICE_ID")
        .or_else(|_| std::env::var("TANGLE_SERVICE_ID"))
        .ok()
        .and_then(|v| v.parse().ok())?;

    let blueprint_id: u64 = std::env::var("BLUEPRINT_ID")
        .or_else(|_| std::env::var("TANGLE_BLUEPRINT_ID"))
        .ok()
        .and_then(|v| v.parse().ok())?;

    let registry_addr_str = std::env::var("STATUS_REGISTRY_ADDRESS").ok()?;
    let status_registry_address =
        blueprint_sdk::alloy::primitives::Address::from_str(&registry_addr_str).ok()?;

    let interval_secs: u64 = std::env::var("HEARTBEAT_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);

    let max_missed: u32 = std::env::var("HEARTBEAT_MAX_MISSED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);

    Some(HeartbeatConfig {
        interval_secs,
        jitter_percent: 10,
        service_id,
        blueprint_id,
        max_missed_heartbeats: max_missed,
        status_registry_address,
    })
}

/// Load job pricing from TOML content.
///
/// Format: `[service_id]\njob_index = "price_in_wei"`
#[cfg(feature = "x402")]
fn load_job_pricing(
    content: &str,
) -> Result<std::collections::HashMap<(u64, u32), alloy_primitives::U256>, String> {
    use alloy_primitives::U256;

    let parsed: toml::Value = toml::from_str(content).map_err(|e| e.to_string())?;
    let table = parsed
        .as_table()
        .ok_or_else(|| "job pricing TOML must be a table".to_string())?;

    let mut config = std::collections::HashMap::new();

    for (service_key, jobs) in table {
        // Skip comment-only sections
        let service_id: u64 = match service_key.parse() {
            Ok(id) => id,
            Err(_) => continue,
        };

        let jobs_table = match jobs.as_table() {
            Some(t) => t,
            None => continue,
        };

        for (job_key, price_val) in jobs_table {
            let job_index: u32 = match job_key.parse() {
                Ok(idx) => idx,
                Err(_) => continue,
            };

            if let Some(price_str) = price_val.as_str() {
                if let Ok(price) = U256::from_str_radix(price_str, 10) {
                    config.insert((service_id, job_index), price);
                }
            }
        }
    }

    Ok(config)
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
