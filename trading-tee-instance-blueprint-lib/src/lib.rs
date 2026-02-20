//! AI Trading TEE Instance Blueprint
//!
//! TEE-backed variant of the trading instance blueprint. Reuses all handlers
//! from the base instance blueprint except provision/deprovision, which route
//! through a `TeeBackend` for hardware-isolated execution.

pub mod jobs;

// Re-export from base instance blueprint.
pub use trading_instance_blueprint_lib::{
    // Job IDs
    JOB_CONFIGURE,
    JOB_DEPROVISION,
    JOB_EXEC,
    JOB_PROMPT,
    JOB_PROVISION,
    JOB_START_TRADING,
    JOB_STATUS,
    JOB_STOP_TRADING,
    JOB_TASK,
    JOB_WORKFLOW_TICK,
    // ABI types
    InstanceExecRequest,
    InstanceExecResponse,
    InstancePromptRequest,
    InstancePromptResponse,
    InstanceTaskRequest,
    InstanceTaskResponse,
    JsonResponse,
    TradingConfigureRequest,
    TradingControlRequest,
    TradingProvisionOutput,
    TradingProvisionRequest,
    TradingStatusResponse,
    // Types
    TradingBotRecord,
    // Modules
    auth,
    context,
    reaper,
    runtime,
    store,
    tangle,
    tee,
    // Instance state
    clear_instance_bot_id,
    get_instance_bot_id,
    instance_store,
    require_instance_bot,
    set_instance_bot_id,
    // Reused job handlers
    instance_configure,
    instance_exec,
    instance_prompt,
    instance_start,
    instance_status,
    instance_stop,
    instance_task,
};

use blueprint_sdk::Job;
use blueprint_sdk::Router;
use blueprint_sdk::tangle::TangleLayer;

// Re-export TEE backend singleton from sandbox-runtime.
pub use sandbox_runtime::tee::{init_tee_backend, tee_backend};

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/// Build the TEE instance blueprint router.
///
/// Uses TEE-aware provision/deprovision handlers; all other handlers are
/// reused from the base instance blueprint.
pub fn tee_router() -> Router {
    use jobs::provision::{tee_deprovision, tee_provision};

    Router::new()
        .route(JOB_PROVISION, tee_provision.layer(TangleLayer))
        .route(JOB_CONFIGURE, instance_configure.layer(TangleLayer))
        .route(JOB_START_TRADING, instance_start.layer(TangleLayer))
        .route(JOB_STOP_TRADING, instance_stop.layer(TangleLayer))
        .route(JOB_STATUS, instance_status.layer(TangleLayer))
        .route(JOB_DEPROVISION, tee_deprovision.layer(TangleLayer))
        .route(JOB_PROMPT, instance_prompt.layer(TangleLayer))
        .route(JOB_TASK, instance_task.layer(TangleLayer))
        .route(JOB_EXEC, instance_exec.layer(TangleLayer))
        .route(
            JOB_WORKFLOW_TICK,
            trading_blueprint_lib::jobs::workflow_tick,
        )
}
