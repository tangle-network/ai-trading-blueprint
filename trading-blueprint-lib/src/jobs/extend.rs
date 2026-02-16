use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox};
use crate::{JsonResponse, TradingExtendRequest};

/// Extend core logic, testable without Tangle extractors.
///
/// Increases a bot's lifetime by `additional_days`. Updates both the sandbox
/// record (`max_lifetime_seconds`) and the bot record (`max_lifetime_days`).
///
/// When `skip_docker` is true, only updates the bot record (no sandbox
/// record update) — used in unit tests without a real sandbox store.
pub async fn extend_core(
    sandbox_id: &str,
    additional_days: u64,
    skip_docker: bool,
) -> Result<JsonResponse, String> {
    if additional_days == 0 {
        return Err("additional_days must be > 0".to_string());
    }

    let bot = find_bot_by_sandbox(sandbox_id)?;
    let bot_id = bot.id.clone();
    let old_days = bot.max_lifetime_days;

    // Update sandbox record: extend max_lifetime_seconds
    if !skip_docker {
        let additional_seconds = additional_days * 86400;
        sandbox_runtime::runtime::sandboxes()
            .map_err(|e| e.to_string())?
            .update(sandbox_id, |r| {
                r.max_lifetime_seconds += additional_seconds;
            })
            .map_err(|e| format!("Failed to update sandbox: {e}"))?;
    }

    // Update bot record: extend max_lifetime_days
    let new_days = old_days + additional_days;
    crate::state::bots()?
        .update(&bot_key(&bot_id), |b| {
            b.max_lifetime_days += additional_days;
        })
        .map_err(|e| format!("Failed to update bot: {e}"))?;

    Ok(JsonResponse {
        json: json!({
            "status": "extended",
            "sandbox_id": sandbox_id,
            "bot_id": bot_id,
            "previous_lifetime_days": old_days,
            "additional_days": additional_days,
            "new_lifetime_days": new_days,
        })
        .to_string(),
    })
}

/// Extend a trading bot's lifetime (Tangle handler).
pub async fn extend(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingExtendRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    Ok(TangleResult(
        extend_core(&request.sandbox_id, request.additional_days, false).await?,
    ))
}
