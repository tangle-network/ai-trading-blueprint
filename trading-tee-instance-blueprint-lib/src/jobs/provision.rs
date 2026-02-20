use trading_instance_blueprint_lib::tangle::extract::{CallId, Caller, TangleArg, TangleResult};
use trading_instance_blueprint_lib::{
    JsonResponse, TradingControlRequest, TradingProvisionOutput, TradingProvisionRequest,
    clear_instance_bot_id, get_instance_bot_id, require_instance_bot, set_instance_bot_id,
};

use crate::tee_backend;

/// TEE-aware provision for the singleton trading bot instance.
///
/// Same flow as the base instance provision, but passes the TEE backend
/// to `create_sidecar` for hardware-isolated execution.
pub async fn tee_provision(
    CallId(call_id): CallId,
    Caller(caller): Caller,
    TangleArg(request): TangleArg<TradingProvisionRequest>,
) -> Result<TangleResult<TradingProvisionOutput>, String> {
    // Singleton check
    if get_instance_bot_id()?.is_some() {
        return Err(
            "Instance already provisioned — deprovision first to replace".to_string(),
        );
    }

    let service_id = trading_instance_blueprint_lib::context::operator_context()
        .map(|c| c.service_id)
        .unwrap_or(0);
    let caller_addr = blueprint_sdk::alloy::primitives::Address::from(caller);
    let caller_str = format!("{caller_addr:#x}");

    let backend = tee_backend();
    let output = trading_blueprint_lib::jobs::provision_core(
        request,
        None,
        call_id,
        service_id,
        caller_str,
        Some(backend.as_ref()),
    )
    .await?;

    let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&output.sandbox_id)?;
    set_instance_bot_id(bot.id.clone())?;

    tracing::info!(
        "Trading TEE instance provisioned: bot={}, sandbox={}",
        bot.id,
        output.sandbox_id,
    );

    Ok(TangleResult(output))
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
