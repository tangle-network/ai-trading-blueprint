use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox};
use crate::{JsonResponse, TradingControlRequest};

fn workflow_group_ids(workflow_id: u64) -> [u64; 3] {
    [
        workflow_id,
        workflow_id.saturating_add(1),
        workflow_id.saturating_add(2),
    ]
}

fn sync_workflow_target(
    workflow_id: u64,
    record: Option<&sandbox_runtime::SandboxRecord>,
) -> Result<(), String> {
    let key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    ai_agent_sandbox_blueprint_lib::workflows::workflows()?
        .update(&key, |entry| {
            entry.active = true;
            if entry.next_run_at.is_none() {
                entry.next_run_at = ai_agent_sandbox_blueprint_lib::workflows::resolve_next_run(
                    &entry.trigger_type,
                    &entry.trigger_config,
                    None,
                )
                .unwrap_or(None);
            }
            if let Some(record) = record {
                entry.target_kind =
                    ai_agent_sandbox_blueprint_lib::workflows::WORKFLOW_TARGET_SANDBOX;
                entry.target_sandbox_id = record.id.clone();

                if let Ok(mut workflow_json) =
                    serde_json::from_str::<serde_json::Value>(&entry.workflow_json)
                {
                    workflow_json["sidecar_url"] =
                        serde_json::Value::String(record.sidecar_url.clone());
                    workflow_json["sidecar_token"] =
                        serde_json::Value::String(record.token.clone());
                    if let Ok(updated) = serde_json::to_string(&workflow_json) {
                        entry.workflow_json = updated;
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to update workflow target: {e}"))?;
    Ok(())
}

/// Start core logic, testable without Tangle extractors.
///
/// When `skip_docker` is true, skips the `resume_sidecar` Docker call but
/// still updates bot state and workflow activation.
pub async fn start_core(sandbox_id: &str, skip_docker: bool) -> Result<JsonResponse, String> {
    let bot = find_bot_by_sandbox(sandbox_id)?;
    let bot_id = bot.id.clone();
    let workflow_id = bot.workflow_id;
    let mut latest_record = sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id).ok();

    if !skip_docker {
        // Resume sidecar container (best-effort: container may not exist in mock/test)
        match sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id) {
            Ok(record) => {
                if let Err(e) = sandbox_runtime::runtime::resume_sidecar(&record).await {
                    tracing::warn!("Could not resume sidecar (may be mock): {e}");
                }
                latest_record = sandbox_runtime::runtime::get_sandbox_by_id(sandbox_id).ok();
            }
            Err(e) => {
                tracing::warn!("Sandbox record not found for start (may be mock): {e}");
            }
        }
    }

    // Activate workflow
    if let Some(wf_id) = workflow_id {
        for id in workflow_group_ids(wf_id) {
            sync_workflow_target(id, latest_record.as_ref())?;
        }
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
