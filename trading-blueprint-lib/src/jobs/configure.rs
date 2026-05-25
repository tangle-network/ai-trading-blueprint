use blueprint_sdk::tangle::extract::{Caller, TangleArg, TangleResult};
use serde_json::json;

use crate::state::{bot_key, find_bot_by_sandbox, get_bot};
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
    let parsed_strategy_config = if !new_strategy_config.trim().is_empty() {
        serde_json::from_str::<serde_json::Value>(&new_strategy_config).ok()
    } else {
        None
    };
    let next_harness_json = if let Some(config) = parsed_strategy_config.as_ref() {
        if let Some(obj) = config.as_object() {
            let harness = super::provision::harness_for_strategy_config(obj)?;
            serde_json::to_value(harness).ok()
        } else {
            None
        }
    } else {
        None
    };

    crate::state::bots()?
        .update(&bot_key(&bot_id), |b| {
            if !new_strategy_config.trim().is_empty()
                && let Some(config) = parsed_strategy_config.as_ref()
            {
                // Check for paper_trade toggle in strategy config
                if let Some(paper_val) = config.get("paper_trade").and_then(|v| v.as_bool()) {
                    b.paper_trade = paper_val;
                }
                b.strategy_config = config.clone();
            }
            if let Some(harness_json) = &next_harness_json {
                b.harness_json = harness_json.clone();
            }
            if !new_risk_params.trim().is_empty() {
                b.risk_params = serde_json::from_str(&new_risk_params).unwrap_or_default();
            }
        })
        .map_err(|e| format!("Failed to update bot: {e}"))?;

    // Rebuild the workflow's backend_profile_json so changes propagate to the
    // running agent on the next cron tick.
    if let Ok(Some(updated_bot)) = get_bot(&bot_id) {
        if let Some(workflow_id) = updated_bot.workflow_id {
            rebuild_workflow_profile(&updated_bot, workflow_id);
            if let Err(err) =
                super::activate::refresh_split_workflow_schedules(&updated_bot, workflow_id)
            {
                tracing::warn!(
                    "Failed to refresh split workflow schedules for bot {} after configure: {err}",
                    updated_bot.id
                );
            }
        }
        if let Ok(record) = sandbox_runtime::runtime::get_sandbox_by_id(&updated_bot.sandbox_id) {
            let sidecar_bot = super::activate::build_sidecar_bot_config(&updated_bot);
            if let Err(err) =
                super::activate::ensure_sidecar_runtime_dirs(&record.sidecar_url, &record.token)
                    .await
            {
                tracing::warn!(
                    "Failed to refresh sidecar runtime directories for bot {} after configure: {err}",
                    updated_bot.id
                );
            }
            if let Err(err) = super::activate::write_prebuilt_tools(
                &record.sidecar_url,
                &record.token,
                &updated_bot.id,
                updated_bot.chain_id,
                &updated_bot.strategy_type,
                &sidecar_bot.trading_api_url,
                &sidecar_bot.rpc_url,
                &updated_bot.vault_address,
                &updated_bot.trading_api_token,
                &updated_bot.operator_address,
                &updated_bot.strategy_config,
                &updated_bot.harness_json,
            )
            .await
            {
                tracing::warn!(
                    "Failed to refresh sidecar tools/config for bot {} after configure: {err}",
                    updated_bot.id
                );
            }
            if let Err(err) = super::activate::sync_profile_instructions(
                &record.sidecar_url,
                &record.token,
                &sidecar_bot,
            )
            .await
            {
                tracing::warn!(
                    "Failed to refresh OpenCode instructions for bot {} after configure: {err}",
                    updated_bot.id
                );
            }
        }
    }

    Ok(JsonResponse {
        json: json!({
            "status": "configured",
            "sandbox_id": sandbox_id,
        })
        .to_string(),
    })
}

/// Rebuild the workflow prompt/profile in a workflow entry from the current bot state.
fn rebuild_workflow_profile(bot: &crate::state::TradingBotRecord, workflow_id: u64) {
    let pack = crate::prompts::packs::get_pack(&bot.strategy_type);
    let (prompt, profile, max_turns, timeout_ms) = match &pack {
        Some(p) => (
            crate::prompts::build_pack_loop_prompt(p, bot, bot.validation_trust),
            crate::prompts::build_pack_agent_profile(p, bot),
            p.max_turns,
            p.timeout_ms,
        ),
        None => (
            crate::prompts::build_loop_prompt(&bot.strategy_type, bot.validation_trust),
            crate::prompts::packs::build_generic_agent_profile(&bot.strategy_type, bot),
            10,
            600_000,
        ),
    };
    let profile_json = serde_json::to_string(&profile).unwrap_or_default();

    let wf_key = ai_agent_sandbox_blueprint_lib::workflows::workflow_key(workflow_id);
    let updated = ai_agent_sandbox_blueprint_lib::workflows::workflows().and_then(|store| {
        store
            .update(&wf_key, |entry| {
                if let Ok(mut wf) = serde_json::from_str::<serde_json::Value>(&entry.workflow_json)
                {
                    wf["prompt"] = serde_json::Value::String(prompt.clone());
                    wf["backend_profile_json"] = serde_json::Value::String(profile_json.clone());
                    if max_turns > 0 {
                        wf["max_turns"] = serde_json::Value::from(max_turns);
                    }
                    if timeout_ms > 0 {
                        wf["timeout_ms"] = serde_json::Value::from(timeout_ms);
                    }
                    if let Ok(json_str) = serde_json::to_string(&wf) {
                        entry.workflow_json = json_str;
                    }
                }
            })
            .map_err(|e| e.to_string())
    });

    match updated {
        Ok(true) => {
            tracing::info!(
                "Rebuilt workflow profile for bot {} (workflow {})",
                bot.id,
                workflow_id
            );
        }
        Ok(false) => {
            tracing::warn!(
                "Workflow {} not found for bot {} during profile rebuild",
                workflow_id,
                bot.id
            );
        }
        Err(e) => {
            tracing::warn!("Failed to rebuild workflow profile for bot {}: {e}", bot.id);
        }
    }
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
