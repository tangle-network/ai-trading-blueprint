use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox};
use crate::{JsonResponse, TradingControlRequest};

/// Stop core logic, testable without Tangle extractors.
///
/// When `skip_docker` is true, skips the `stop_sidecar` Docker call but
/// still updates bot state and deactivates the workflow.
pub async fn stop_core(sandbox_id: &str, skip_docker: bool) -> Result<JsonResponse, String> {
    let bot = find_bot_by_sandbox(sandbox_id)?;
    let bot_id = bot.id.clone();
    let workflow_id = bot.workflow_id;

    if !skip_docker {
        // Stop sidecar container
        let record = sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id)
            .map_err(|e| format!("Sandbox not found: {e}"))?;
        sandbox_runtime::runtime::stop_sidecar(&record)
            .await
            .map_err(|e| format!("Failed to stop sidecar: {e}"))?;
    }

    // Deactivate workflow
    if let Some(wf_id) = workflow_id {
        let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
        let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()?
            .update(&key, |e| {
                e.active = false;
                e.next_run_at = None;
            });
    }

    // Set trading_active = false
    crate::state::bots()?
        .update(&bot_key(&bot_id), |b| {
            b.trading_active = false;
        })
        .map_err(|e| format!("Failed to update bot: {e}"))?;

    Ok(JsonResponse {
        json: json!({
            "status": "stopped",
            "sandbox_id": sandbox_id,
        })
        .to_string(),
    })
}

/// Stop a running trading bot (Tangle handler).
pub async fn stop(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    Ok(TangleResult(stop_core(&request.sandbox_id, false).await?))
}
