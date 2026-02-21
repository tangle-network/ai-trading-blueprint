use blueprint_sdk::tangle::extract::{CallId, Caller, TangleArg, TangleResult};

use crate::{
    JsonResponse, TradingControlRequest, TradingProvisionOutput, TradingProvisionRequest,
    clear_instance_bot_id, require_instance_bot,
};

/// On-chain provision handler — deprecated for instance blueprints.
///
/// Instance provisioning now happens automatically via the operator API
/// (`POST /api/bot/provision`) after service creation. The vault is created
/// on-chain in `onServiceInitialized` when `instanceMode=true`.
///
/// This handler returns an error directing callers to the operator API.
pub async fn instance_provision(
    CallId(_call_id): CallId,
    Caller(_caller): Caller,
    TangleArg(_request): TangleArg<TradingProvisionRequest>,
) -> Result<TangleResult<TradingProvisionOutput>, String> {
    Err(
        "Instance provisioning is automatic. Use the operator API \
         (POST /api/bot/provision) after service creation instead."
            .to_string(),
    )
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
