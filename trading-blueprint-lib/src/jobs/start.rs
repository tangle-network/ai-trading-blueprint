use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox};
use crate::{JsonResponse, TradingControlRequest};

/// Start core logic, testable without Tangle extractors.
///
/// When `skip_docker` is true, skips the `resume_sidecar` Docker call but
/// still updates bot state and workflow activation.
pub async fn start_core(sandbox_id: &str, skip_docker: bool) -> Result<JsonResponse, String> {
    let bot = find_bot_by_sandbox(sandbox_id)?;
    let bot_id = bot.id.clone();
    let workflow_id = bot.workflow_id;

    if !skip_docker {
        // Resume sidecar container (best-effort: container may not exist in mock/test)
        match sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id) {
            Ok(record) => {
                if let Err(e) = sandbox_runtime::runtime::resume_sidecar(&record).await {
                    tracing::warn!("Could not resume sidecar (may be mock): {e}");
                }
            }
            Err(e) => {
                tracing::warn!("Sandbox record not found for start (may be mock): {e}");
            }
        }
    }

    // Activate workflow
    if let Some(wf_id) = workflow_id {
        let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(wf_id);
        let _ = ai_agent_sandbox_blueprint_lib::workflows::workflows()?
            .update(&key, |e| {
                e.active = true;
            });
    }

    // Set trading_active
    crate::state::bots()?
        .update(&bot_key(&bot_id), |b| {
            b.trading_active = true;
        })
        .map_err(|e| format!("Failed to update bot: {e}"))?;

    Ok(JsonResponse {
        json: json!({
            "status": "started",
            "sandbox_id": sandbox_id,
        })
        .to_string(),
    })
}

/// Resume a stopped trading bot (Tangle handler).
pub async fn start(
    Caller(_caller): Caller,
    TangleArg(request): TangleArg<TradingControlRequest>,
) -> Result<TangleResult<JsonResponse>, String> {
    Ok(TangleResult(start_core(&request.sandbox_id, false).await?))
}
