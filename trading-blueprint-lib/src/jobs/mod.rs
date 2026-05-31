mod activate;
mod configure;
mod deprovision;
mod exec;
mod extend;
pub mod promotion_conductor;
mod prompt;
mod provision;
pub mod self_improvement_cadence;
mod start;
mod status;
mod stop;
mod task;
pub mod tick_artifacts;
mod webhook_event;
mod workflow_tick;

pub use activate::{activate_bot_with_secrets, wipe_bot_secrets};
pub use configure::configure;
pub use configure::configure_core;
pub use deprovision::deprovision;
pub use deprovision::deprovision_core;
pub use exec::exec;
pub use extend::extend;
pub use extend::extend_core;
pub use prompt::prompt;
pub use provision::provision;
pub use provision::provision_core;
pub use provision::recreate_bot_sandbox;
pub use start::start;
pub use start::start_core;
pub use status::status;
pub use status::status_core;
pub use stop::stop;
pub use stop::stop_core;
pub use task::task;
pub use webhook_event::webhook_event;
pub use webhook_event::webhook_event_core;
pub use workflow_tick::trading_workflow_tick as workflow_tick;

/// Run a standalone cron loop for workflow ticks when the full Blueprint
/// runner isn't available (e.g., local dev without proper Tangle registration).
pub async fn run_standalone_cron(service_id: u64) {
    let schedule =
        std::env::var("WORKFLOW_CRON_SCHEDULE").unwrap_or_else(|_| "0 * * * * *".to_string());
    tracing::info!(
        "Starting standalone workflow cron (service {service_id}, schedule: {schedule})"
    );

    let _ = schedule; // Used for logging, actual interval is fixed
    loop {
        // Simple fixed-interval tick (every 60s) — good enough for local dev.
        // The real cron scheduling happens via the BlueprintRunner's CronJob producer.
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        match workflow_tick::trading_workflow_tick().await {
            Ok(_result) => {}
            Err(e) => tracing::error!("Standalone workflow tick failed: {e}"),
        }
    }
}
