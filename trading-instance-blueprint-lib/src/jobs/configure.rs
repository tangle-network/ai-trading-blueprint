use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use crate::{JsonResponse, TradingConfigureRequest, require_instance_bot};

/// Update strategy configuration and/or risk parameters for the singleton bot.
///
/// The `sandbox_id` field in the request is ignored — we resolve it
/// automatically from the singleton.
pub async fn instance_configure(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingConfigureRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    let bot = require_instance_bot()?;
    Ok(TangleResult(
        trading_blueprint_lib::jobs::configure_core(
            &bot.sandbox_id,
            &request.strategy_config_json,
            &request.risk_params_json,
        )
        .await?,
    ))
}
