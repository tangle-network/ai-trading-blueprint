use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};

use crate::state::find_bot_by_sandbox;
use crate::{TradingControlRequest, TradingStatusResponse};

/// Status core logic, testable without Tangle extractors.
///
/// When `skip_docker` is true, reports sandbox state as "test" instead of
/// querying the Docker runtime.
pub async fn status_core(
    sandbox_id: &str,
    skip_docker: bool,
) -> Result<TradingStatusResponse, String> {
    let bot = find_bot_by_sandbox(sandbox_id)?;

    // Read sandbox state
    let sandbox_state = if skip_docker {
        "test".to_string()
    } else {
        match sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id) {
            Ok(record) => format!("{:?}", record.state),
            Err(_) => "unknown".to_string(),
        }
    };

    let portfolio = serde_json::json!({
        "vault_address": bot.vault_address,
        "chain_id": bot.chain_id,
        "strategy_type": bot.strategy_type,
        "strategy_config": bot.strategy_config,
        "risk_params": bot.risk_params,
        "workflow_id": bot.workflow_id,
    });

    Ok(TradingStatusResponse {
        sandbox_id: bot.sandbox_id.clone(),
        state: sandbox_state,
        portfolio_json: portfolio.to_string(),
        trading_active: bot.trading_active,
    })
}

/// Return the current status of a trading bot (Tangle handler).
pub async fn status(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<TradingStatusResponse>, String> {
    Ok(TangleResult(status_core(&request.sandbox_id, false).await?))
}
