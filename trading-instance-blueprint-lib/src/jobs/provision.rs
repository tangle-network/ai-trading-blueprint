use blueprint_sdk::tangle::extract::{CallId, Caller, TangleArg, TangleResult};

use crate::{
    JsonResponse, TradingControlRequest, TradingProvisionOutput, TradingProvisionRequest,
    clear_instance_bot_id, get_instance_bot_id, require_instance_bot, set_instance_bot_id,
};

/// Provision a singleton trading bot instance (Tangle handler).
///
/// Fails if already provisioned (singleton check). Delegates to the cloud
/// variant's `provision_core` which stores the bot record in `bots()`, then
/// saves the bot_id in the lightweight singleton reference store.
pub async fn instance_provision(
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

    let service_id = crate::context::operator_context()
        .map(|c| c.service_id)
        .unwrap_or(0);
    let caller_addr = blueprint_sdk::alloy::primitives::Address::from(caller);
    let caller_str = format!("{caller_addr:#x}");

    // Delegate to cloud's provision_core (stores bot record in bots())
    let output = trading_blueprint_lib::jobs::provision_core(
        request, None, call_id, service_id, caller_str, None,
    )
    .await?;

    // Resolve the bot_id from the record stored by provision_core
    let bot = trading_blueprint_lib::state::find_bot_by_sandbox(&output.sandbox_id)?;
    set_instance_bot_id(bot.id.clone())?;

    tracing::info!(
        "Trading instance provisioned: bot={}, sandbox={}",
        bot.id,
        output.sandbox_id,
    );

    Ok(TangleResult(output))
}

/// Deprovision the singleton trading bot instance (Tangle handler).
///
/// Resolves the singleton bot, delegates to cloud's `deprovision_core` which
/// cleans up the bot record, workflow, and Docker container, then clears the
/// singleton reference.
pub async fn instance_deprovision(
    Caller(_caller): Caller,
    TangleArg(_request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    let bot = require_instance_bot()?;
    let response =
        trading_blueprint_lib::jobs::deprovision_core(&bot.sandbox_id, false, None).await?;
    clear_instance_bot_id()?;

    tracing::info!("Trading instance deprovisioned: bot={}", bot.id);

    Ok(TangleResult(response))
}
