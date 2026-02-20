use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use crate::{TradingControlRequest, TradingStatusResponse, require_instance_bot};

/// Return the current status of the singleton trading bot.
///
/// The `sandbox_id` field in the request is ignored — resolved from singleton.
pub async fn instance_status(
    Caller(_caller): Caller,
    TangleArg(_request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<TradingStatusResponse>, String> {
    let bot = require_instance_bot()?;
    Ok(TangleResult(
        trading_blueprint_lib::jobs::status_core(&bot.sandbox_id, false).await?,
    ))
}
