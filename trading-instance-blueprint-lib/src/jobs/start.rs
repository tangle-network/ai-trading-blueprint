use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use crate::{JsonResponse, TradingControlRequest, require_instance_bot};

/// Resume the singleton trading bot.
///
/// The `sandbox_id` field in the request is ignored — resolved from singleton.
pub async fn instance_start(
    Caller(_caller): Caller,
    TangleArg(_request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    let bot = require_instance_bot()?;
    Ok(TangleResult(
        trading_blueprint_lib::jobs::start_core(&bot.sandbox_id, false).await?,
    ))
}
