//! Consolidated AI Trading Blueprint
//!
//! Uses `sandbox-runtime` for sidecar container management and
//! `ai-agent-sandbox-blueprint-lib` for workflow scheduling, prompt/task
//! execution, and sandbox lifecycle primitives.

pub mod context;
pub mod discovery;
pub mod fees;
pub mod graceful_consumer;
pub mod jobs;
pub mod on_chain;
pub mod polymarket_ws;
pub mod prompts;
pub mod providers;
pub mod registration;
pub mod state;
pub mod wind_down;

pub use providers::{EventContext, ProviderRegistry, TradingProvider, registry};

// Re-export sandbox-runtime modules so downstream crates can access them.
pub use sandbox_runtime::{
    CreateSandboxParams, DEFAULT_SIDECAR_IMAGE, SandboxError, SandboxRecord, SandboxState,
};
pub use sandbox_runtime::{auth, runtime, store};

use blueprint_sdk::Job;
use blueprint_sdk::Router;
use blueprint_sdk::alloy::sol;
use blueprint_sdk::tangle::TangleLayer;

// ─────────────────────────────────────────────────────────────────────────────
// Job IDs — must match TradingBlueprint.sol constants
// ─────────────────────────────────────────────────────────────────────────────

pub const JOB_PROVISION: u8 = 0;
pub const JOB_CONFIGURE: u8 = 1;
pub const JOB_START_TRADING: u8 = 2;
pub const JOB_STOP_TRADING: u8 = 3;
pub const JOB_STATUS: u8 = 4;
pub const JOB_DEPROVISION: u8 = 5;
pub const JOB_EXTEND: u8 = 6;
pub const JOB_PROMPT: u8 = 10;
pub const JOB_TASK: u8 = 11;
pub const JOB_EXEC: u8 = 12;
pub const JOB_WORKFLOW_TICK: u8 = 30;
pub const JOB_WEBHOOK_EVENT: u8 = 40;

// ─────────────────────────────────────────────────────────────────────────────
// ABI types — must match TradingBlueprint.sol structs
// ─────────────────────────────────────────────────────────────────────────────

sol! {
    struct TradingProvisionRequest {
        string name;
        string strategy_type;
        string strategy_config_json;
        string risk_params_json;
        address factory_address;
        address asset_token;
        address[] signers;
        uint256 required_signatures;
        uint256 chain_id;
        string rpc_url;
        string trading_loop_cron;
        uint64 cpu_cores;
        uint64 memory_mb;
        uint64 max_lifetime_days;
        uint64[] validator_service_ids;
    }

    struct TradingExtendRequest {
        string sandbox_id;
        uint64 additional_days;
    }

    struct TradingProvisionOutput {
        address vault_address;
        address share_token;
        string sandbox_id;
        uint64 workflow_id;
    }

    struct TradingConfigureRequest {
        string sandbox_id;
        string strategy_config_json;
        string risk_params_json;
    }

    struct TradingControlRequest {
        string sandbox_id;
    }

    struct TradingStatusResponse {
        string sandbox_id;
        string state;
        string portfolio_json;
        bool trading_active;
    }

    struct JsonResponse {
        string json;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

pub fn router() -> Router {
    Router::new()
        .route(JOB_PROVISION, jobs::provision.layer(TangleLayer))
        .route(JOB_CONFIGURE, jobs::configure.layer(TangleLayer))
        .route(JOB_START_TRADING, jobs::start.layer(TangleLayer))
        .route(JOB_STOP_TRADING, jobs::stop.layer(TangleLayer))
        .route(JOB_STATUS, jobs::status.layer(TangleLayer))
        .route(JOB_DEPROVISION, jobs::deprovision.layer(TangleLayer))
        .route(JOB_EXTEND, jobs::extend.layer(TangleLayer))
        .route(JOB_PROMPT, jobs::prompt.layer(TangleLayer))
        .route(JOB_TASK, jobs::task.layer(TangleLayer))
        .route(JOB_EXEC, jobs::exec.layer(TangleLayer))
        .route(JOB_WORKFLOW_TICK, jobs::workflow_tick)
        .route(JOB_WEBHOOK_EVENT, jobs::webhook_event)
}
