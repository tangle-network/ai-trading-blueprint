use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox};
use crate::{JsonResponse, TradingConfigureRequest};

/// Configure core logic, testable without Tangle extractors.
pub async fn configure_core(
    sandbox_id: &str,
    strategy_config_json: &str,
    risk_params_json: &str,
) -> Result<JsonResponse, String> {
    let bot = find_bot_by_sandbox(sandbox_id)?;
    let bot_id = bot.id.clone();

    let new_strategy_config = strategy_config_json.to_string();
    let new_risk_params = risk_params_json.to_string();

    crate::state::bots()?
        .update(&bot_key(&bot_id), |b| {
            if !new_strategy_config.trim().is_empty() {
                if let Ok(config) = serde_json::from_str::<serde_json::Value>(&new_strategy_config) {
                    // Check for paper_trade toggle in strategy config
                    if let Some(paper_val) = config.get("paper_trade").and_then(|v| v.as_bool()) {
                        b.paper_trade = paper_val;
                    }
                    b.strategy_config = config;
                }
            }
            if !new_risk_params.trim().is_empty() {
                b.risk_params =
                    serde_json::from_str(&new_risk_params).unwrap_or_default();
            }
        })
        .map_err(|e| format!("Failed to update bot: {e}"))?;

    Ok(JsonResponse {
        json: json!({
            "status": "configured",
            "sandbox_id": sandbox_id,
        })
        .to_string(),
    })
}

/// Update strategy configuration and/or risk parameters for an existing bot.
pub async fn configure(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingConfigureRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    Ok(TangleResult(
        configure_core(
            &request.sandbox_id,
            &request.strategy_config_json,
            &request.risk_params_json,
        )
        .await?,
    ))
}
