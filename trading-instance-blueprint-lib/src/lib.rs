//! AI Trading Instance Blueprint
//!
//! Subscription-based: each service instance runs exactly ONE trading bot.
//! Instance-scoped: jobs don't take sandbox_id — the handler looks up the
//! singleton automatically via the bot_id stored in a lightweight reference
//! store. The actual `TradingBotRecord` lives in the cloud variant's `bots()`
//! store, so all existing `_core` functions work unchanged.

pub mod jobs;
pub mod operator_api;
pub use operator_api::build_instance_router;

// Re-export ABI types from cloud variant (shared on-chain structs).
pub use trading_blueprint_lib::{
    JsonResponse, TradingConfigureRequest, TradingControlRequest, TradingProvisionOutput,
    TradingProvisionRequest, TradingStatusResponse,
};

// Re-export cloud modules needed by downstream.
pub use trading_blueprint_lib::context;
pub use trading_blueprint_lib::state::TradingBotRecord;

// Re-export sandbox-runtime modules.
pub use sandbox_runtime::{auth, reaper, runtime, store, tee};
pub use sandbox_runtime::instance_types::{
    InstanceExecRequest, InstanceExecResponse, InstancePromptRequest, InstancePromptResponse,
    InstanceTaskRequest, InstanceTaskResponse,
};

use blueprint_sdk::Job;
use blueprint_sdk::Router;
use blueprint_sdk::tangle::TangleLayer;
use once_cell::sync::OnceCell;

pub use blueprint_sdk::tangle;

// Re-export job handlers.
pub use jobs::configure::instance_configure;
pub use jobs::exec::instance_exec;
pub use jobs::prompt::instance_prompt;
pub use jobs::provision::{instance_deprovision, instance_provision};
pub use jobs::start::instance_start;
pub use jobs::status::instance_status;
pub use jobs::stop::instance_stop;
pub use jobs::task::instance_task;

// ─────────────────────────────────────────────────────────────────────────────
// Job IDs — match cloud variant where possible
// ─────────────────────────────────────────────────────────────────────────────

pub const JOB_PROVISION: u8 = 0;
pub const JOB_CONFIGURE: u8 = 1;
pub const JOB_START_TRADING: u8 = 2;
pub const JOB_STOP_TRADING: u8 = 3;
pub const JOB_STATUS: u8 = 4;
pub const JOB_DEPROVISION: u8 = 5;
pub const JOB_PROMPT: u8 = 10;
pub const JOB_TASK: u8 = 11;
pub const JOB_EXEC: u8 = 12;
pub const JOB_WORKFLOW_TICK: u8 = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Instance state — lightweight bot_id reference for singleton lookup
// ─────────────────────────────────────────────────────────────────────────────

static INSTANCE_STORE: OnceCell<store::PersistentStore<String>> = OnceCell::new();

const INSTANCE_KEY: &str = "instance";

/// Access the instance reference store (stores only the bot_id string).
pub fn instance_store() -> Result<&'static store::PersistentStore<String>, String> {
    INSTANCE_STORE
        .get_or_try_init(|| {
            let path = store::state_dir().join("trading-instance-ref.json");
            store::PersistentStore::open(path).map_err(|e| e.to_string())
        })
        .map_err(|e: String| e)
}

/// Store the singleton bot_id reference.
pub fn set_instance_bot_id(bot_id: String) -> Result<(), String> {
    instance_store()?
        .insert(INSTANCE_KEY.to_string(), bot_id)
        .map_err(|e| e.to_string())
}

/// Get the singleton bot_id, if provisioned.
pub fn get_instance_bot_id() -> Result<Option<String>, String> {
    instance_store()?.get(INSTANCE_KEY).map_err(|e| e.to_string())
}

/// Clear the singleton reference.
pub fn clear_instance_bot_id() -> Result<(), String> {
    instance_store()?.remove(INSTANCE_KEY).map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the provisioned bot record or error if not provisioned.
///
/// Resolves the bot_id from the singleton store, then looks up the full
/// `TradingBotRecord` from `trading_blueprint_lib::state::bots()`.
pub fn require_instance_bot() -> Result<TradingBotRecord, String> {
    let bot_id = get_instance_bot_id()?.ok_or_else(|| {
        "Instance not provisioned — call JOB_PROVISION first".to_string()
    })?;
    trading_blueprint_lib::state::get_bot(&bot_id)?
        .ok_or_else(|| format!("Instance bot record {bot_id} not found in store"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

pub fn router() -> Router {
    Router::new()
        .route(JOB_PROVISION, instance_provision.layer(TangleLayer))
        .route(JOB_CONFIGURE, instance_configure.layer(TangleLayer))
        .route(JOB_START_TRADING, instance_start.layer(TangleLayer))
        .route(JOB_STOP_TRADING, instance_stop.layer(TangleLayer))
        .route(JOB_STATUS, instance_status.layer(TangleLayer))
        .route(JOB_DEPROVISION, instance_deprovision.layer(TangleLayer))
        .route(JOB_PROMPT, instance_prompt.layer(TangleLayer))
        .route(JOB_TASK, instance_task.layer(TangleLayer))
        .route(JOB_EXEC, instance_exec.layer(TangleLayer))
        .route(
            JOB_WORKFLOW_TICK,
            trading_blueprint_lib::jobs::workflow_tick,
        )
}
