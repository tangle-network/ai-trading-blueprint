use trading_instance_blueprint_lib::tangle::extract::{CallId, Caller, TangleArg, TangleResult};
use trading_instance_blueprint_lib::{
    JsonResponse, TradingControlRequest, TradingProvisionOutput, TradingProvisionRequest,
    clear_instance_bot_id, require_instance_bot,
};

use crate::tee_backend;

/// On-chain TEE provision handler — deprecated for instance blueprints.
///
/// TEE instance provisioning now happens automatically via the operator API
/// (`POST /api/bot/provision`) after service creation. The shared provision
/// endpoint auto-detects TEE backend via `try_tee_backend()`.
///
/// This handler returns an error directing callers to the operator API.
pub async fn tee_provision(
    CallId(_call_id): CallId,
    Caller(_caller): Caller,
    TangleArg(_request): TangleArg<TradingProvisionRequest>,
) -> Result<TangleResult<TradingProvisionOutput>, String> {
    Err(
        "TEE instance provisioning is automatic. Use the operator API \
         (POST /api/bot/provision) after service creation instead."
            .to_string(),
    )
}

/// TEE-aware deprovision for the singleton trading bot instance.
///
/// Tears down the TEE enclave alongside the Docker container.
pub async fn tee_deprovision(
    Caller(_caller): Caller,
    TangleArg(_request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    let bot = require_instance_bot()?;
    let backend = tee_backend();
    let response = trading_blueprint_lib::jobs::deprovision_core(
        &bot.sandbox_id,
        false,
        Some(backend.as_ref()),
    )
    .await?;
    clear_instance_bot_id()?;

    tracing::info!("Trading TEE instance deprovisioned: bot={}", bot.id);

    Ok(TangleResult(response))
}
