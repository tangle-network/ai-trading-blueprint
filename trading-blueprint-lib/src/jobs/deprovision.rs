use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox};
use crate::{JsonResponse, TradingControlRequest};

/// Deprovision core logic, testable without Tangle extractors.
///
/// When `skip_docker` is true, skips the `delete_sidecar` Docker call but
/// still cleans up bot record, workflow, sandbox store entries, and per-bot API.
pub async fn deprovision_core(
    sandbox_id: &str,
    skip_docker: bool,
) -> Result<JsonResponse, String> {
    let bot = find_bot_by_sandbox(sandbox_id)?;
    let bot_id = bot.id.clone();
    let workflow_id = bot.workflow_id;

    if !skip_docker {
        // Delete sidecar
        let record = sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id)
            .map_err(|e| format!("Sandbox not found: {e}"))?;
        sandbox_runtime::runtime::delete_sidecar(&record, None)
            .await
            .map_err(|e| format!("Failed to delete sidecar: {e}"))?;

        // Remove sandbox record
        sandbox_runtime::runtime::sandboxes()
            .map_err(|e| e.to_string())?
            .remove(sandbox_id)
            .map_err(|e| e.to_string())?;
    }

    // Remove workflow
    if let Some(wf_id) = workflow_id {
        let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
        let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()?
            .remove(&key);
    }

    // Remove bot record
    crate::state::bots()?
        .remove(&bot_key(&bot_id))
        .map_err(|e| format!("Failed to remove bot record: {e}"))?;

    Ok(JsonResponse {
        json: json!({
            "status": "deprovisioned",
            "sandbox_id": sandbox_id,
            "bot_id": bot_id,
        })
        .to_string(),
    })
}

/// Deprovision a trading bot (Tangle handler).
pub async fn deprovision(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    Ok(TangleResult(
        deprovision_core(&request.sandbox_id, false).await?,
    ))
}
