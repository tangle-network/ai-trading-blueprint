use blueprint_sdk::contexts::tangle::TangleClientContext;
use blueprint_sdk::runner::BlueprintRunner;
use blueprint_sdk::runner::config::BlueprintEnvironment;
use blueprint_sdk::runner::tangle::config::TangleConfig;
use blueprint_sdk::tangle::{TangleConsumer, TangleProducer};
use trading_validator_lib::router;

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
struct ValidatorHeartbeatConsumer;

#[cfg(feature = "qos")]
impl HeartbeatConsumer for ValidatorHeartbeatConsumer {
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
            tracing::info!("Validator heartbeat: service={service_id} status={status_code} ts={ts}");
            Ok(())
        })
    }
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

            let mut builder = QoSServiceBuilder::<ValidatorHeartbeatConsumer>::new()
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
                    "Validator QoS heartbeat: service_id={}, blueprint_id={}, interval={}s",
                    hb_config.service_id, hb_config.blueprint_id, hb_config.interval_secs,
                );

                builder = builder
                    .with_heartbeat_config(hb_config)
                    .with_heartbeat_consumer(Arc::new(ValidatorHeartbeatConsumer))
                    .with_http_rpc_endpoint(rpc_endpoint)
                    .with_keystore_uri(keystore_uri)
                    .with_status_registry_address(registry_address);
            }

            match builder.build().await {
                Ok(qos_service) => {
                    tracing::info!(
                        "Validator QoS initialized (interval={metrics_interval}s, dry_run={dry_run})"
                    );

                    if let Some(hb) = qos_service.heartbeat_service() {
                        match hb.start_heartbeat().await {
                            Ok(()) => tracing::info!("Validator heartbeat started"),
                            Err(e) => tracing::error!("Failed to start heartbeat: {e}"),
                        }
                    }

                    // Push validator-specific metrics to QoS provider
                    if let Some(provider) = qos_service.provider() {
                        tokio::spawn(async move {
                            use blueprint_qos::metrics::types::MetricsProvider;

                            let mut interval = tokio::time::interval(
                                std::time::Duration::from_secs(metrics_interval),
                            );
                            loop {
                                interval.tick().await;
                                // Get metrics for the local operator
                                let operator_addr = trading_validator_lib::context::operator_context()
                                    .map(|ctx| format!("{}", ctx.operator_address))
                                    .unwrap_or_else(|| "unknown".to_string());

                                if let Ok(metrics) =
                                    trading_validator_lib::get_validator_metrics(&operator_addr)
                                {
                                    provider
                                        .add_on_chain_metric(
                                            "validations_completed".to_string(),
                                            metrics.validations_completed,
                                        )
                                        .await;
                                    provider
                                        .add_on_chain_metric(
                                            "avg_validation_score".to_string(),
                                            metrics.average_score as u64,
                                        )
                                        .await;
                                    provider
                                        .add_on_chain_metric(
                                            "validation_latency_ms".to_string(),
                                            metrics.average_latency_ms,
                                        )
                                        .await;
                                    provider
                                        .add_on_chain_metric(
                                            "ai_scoring_failures".to_string(),
                                            metrics.ai_scoring_failures,
                                        )
                                        .await;
                                }
                            }
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("Validator QoS init failed: {e} — continuing without QoS");
                }
            }
        }
    }

    // ── 2. Load blueprint environment ────────────────────────────────────────
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

    tracing::info!("Starting trading-validator for service {service_id}");

    // ── 3. Initialize operator context ───────────────────────────────────────
    let operator_address = std::env::var("OPERATOR_ADDRESS")
        .unwrap_or_default()
        .parse()
        .unwrap_or(blueprint_sdk::alloy::primitives::Address::ZERO);

    let signing_key_hex = std::env::var("PRIVATE_KEY").unwrap_or_default();

    let blueprint_id: u64 = std::env::var("BLUEPRINT_ID")
        .or_else(|_| std::env::var("TANGLE_BLUEPRINT_ID"))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let chain_id: u64 = std::env::var("CHAIN_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);

    let verifying_contract = std::env::var("VERIFYING_CONTRACT")
        .unwrap_or_default()
        .parse()
        .unwrap_or(blueprint_sdk::alloy::primitives::Address::ZERO);

    let val_ctx = trading_validator_lib::context::ValidatorOperatorContext {
        operator_address,
        signing_key_hex,
        service_id,
        blueprint_id,
        chain_id,
        verifying_contract,
    };

    if let Err(e) = trading_validator_lib::context::init_operator_context(val_ctx) {
        tracing::error!("Failed to init validator operator context: {e}");
    }

    // ── 4. Start HTTP validation server ──────────────────────────────────────
    let http_port: u16 = std::env::var("VALIDATOR_HTTP_PORT")
        .unwrap_or_else(|_| "9090".into())
        .parse()
        .unwrap_or(9090);

    let server = trading_validator_lib::server::ValidatorServer::new(http_port);
    let http_router = server.router();

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{http_port}"))
        .await
        .map_err(|e| blueprint_sdk::Error::Other(format!("Failed to bind validator HTTP: {e}")))?;

    tracing::info!("Validator HTTP server listening on port {http_port}");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, http_router).await {
            tracing::error!("Validator HTTP server error: {e}");
        }
    });

    // ── 5. Build and run the blueprint ───────────────────────────────────────
    let tangle_producer = TangleProducer::new(tangle_client.clone(), service_id);
    let tangle_consumer = TangleConsumer::new(tangle_client);
    let tangle_config = TangleConfig::default();

    let result = BlueprintRunner::builder(tangle_config, env)
        .router(router())
        .producer(tangle_producer)
        .consumer(tangle_consumer)
        .with_shutdown_handler(async {
            tracing::info!("Trading validator shutting down...");
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
