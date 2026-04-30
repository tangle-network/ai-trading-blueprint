//! Trading-aware workflow tick that intercepts the cron tick to detect
//! TTL wind-down conditions and swap the agent prompt accordingly.

use serde_json::Value;

use crate::JsonResponse;
use crate::state::{bot_key, bots};
use crate::wind_down::should_initiate_wind_down;

use ai_agent_sandbox_blueprint_lib::workflows::{workflow_key, workflows};
use blueprint_sdk::tangle::extract::TangleResult;

fn workflow_group_ids(workflow_id: u64) -> [u64; 3] {
    [
        workflow_id,
        workflow_id.saturating_add(1),
        workflow_id.saturating_add(2),
    ]
}

fn workflow_name_belongs_to_bot(name: &str, bot_id: &str) -> bool {
    [
        format!("fast-tick-{bot_id}"),
        format!("research-tick-{bot_id}"),
        format!("conversation-tick-{bot_id}"),
        format!("trading-loop-{bot_id}"),
    ]
    .iter()
    .any(|expected| name == expected)
}

fn disable_stopped_bot_workflows(
    all_bots: &[crate::state::TradingBotRecord],
) -> Result<(), String> {
    let store = workflows()?;
    let all_workflows = store.values().map_err(|e| e.to_string())?;

    for bot in all_bots.iter().filter(|bot| !bot.trading_active) {
        let group_ids = bot.workflow_id.map(workflow_group_ids);
        for workflow in &all_workflows {
            let belongs_to_bot = group_ids.is_some_and(|ids| ids.contains(&workflow.id))
                || workflow_name_belongs_to_bot(&workflow.name, &bot.id);

            if !belongs_to_bot || (!workflow.active && workflow.next_run_at.is_none()) {
                continue;
            }

            let key = workflow_key(workflow.id);
            store
                .update(&key, |entry| {
                    entry.active = false;
                    entry.next_run_at = None;
                })
                .map_err(|e| {
                    format!(
                        "Failed to disable workflow {} for stopped bot {}: {e}",
                        workflow.id, bot.id
                    )
                })?;
            tracing::info!(
                workflow_id = workflow.id,
                bot_id = %bot.id,
                "Disabled workflow for stopped bot before scheduler tick"
            );
        }
    }

    Ok(())
}

/// Trading-aware workflow tick.
///
/// Before running the standard workflow tick, checks all active bots for
/// TTL wind-down eligibility. For bots that should start winding down:
/// 1. Records `wind_down_started_at` timestamp
/// 2. Swaps the workflow prompt to the wind-down liquidation prompt
///
/// After the tick completes, runs fee settlement for winding-down bots.
pub async fn trading_workflow_tick() -> Result<TangleResult<JsonResponse>, String> {
    tracing::info!("=== WORKFLOW TICK HANDLER ENTERED ===");

    // 1. Check all active bots for wind-down eligibility
    let all_bots = bots()?.values().map_err(|e| e.to_string())?;
    tracing::info!("Found {} bots", all_bots.len());

    disable_stopped_bot_workflows(&all_bots)?;

    for bot in &all_bots {
        if !should_initiate_wind_down(bot) {
            continue;
        }

        let Some(workflow_id) = bot.workflow_id else {
            continue;
        };

        tracing::info!(
            "Initiating wind-down for bot {} (vault={}, strategy={})",
            bot.id,
            bot.vault_address,
            bot.strategy_type,
        );

        // Build the wind-down prompt
        let wind_down_prompt = crate::prompts::build_wind_down_prompt(bot);

        // Swap the workflow prompt
        let wf_key = workflow_key(workflow_id);
        let updated = workflows()?
            .update(&wf_key, |entry| {
                if let Ok(mut wf) = serde_json::from_str::<Value>(&entry.workflow_json) {
                    wf["prompt"] = Value::String(wind_down_prompt.clone());
                    if let Ok(json_str) = serde_json::to_string(&wf) {
                        entry.workflow_json = json_str;
                    }
                }
            })
            .map_err(|e| format!("Failed to update workflow prompt: {e}"))?;

        if !updated {
            tracing::warn!(
                "Workflow {} not found for bot {} during wind-down",
                workflow_id,
                bot.id,
            );
            continue;
        }

        // Mark the bot as winding down
        let bot_k = bot_key(&bot.id);
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        bots()?
            .update(&bot_k, |b| {
                b.wind_down_started_at = Some(now);
            })
            .map_err(|e| format!("Failed to mark bot wind-down: {e}"))?;

        tracing::info!("Wind-down initiated for bot {}", bot.id);
    }

    // 2. Run the normal workflow tick
    tracing::info!("Running inner workflow_tick()...");
    let response = match ai_agent_sandbox_blueprint_lib::workflows::workflow_tick().await {
        Ok(v) => {
            tracing::info!("workflow_tick() returned: {}", v);
            v
        }
        Err(e) => {
            tracing::error!("workflow_tick() failed (non-fatal): {e}");
            serde_json::json!({"error": e, "count": 0, "executed": []})
        }
    };

    // 3. Run fee settlement for winding-down bots
    let winding_down: Vec<_> = bots()?
        .values()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|b| b.wind_down_started_at.is_some())
        .collect();

    for bot in &winding_down {
        tracing::info!("Running post-wind-down fee settlement for bot {}", bot.id);
    }

    if !winding_down.is_empty() {
        crate::fees::settle_all_fees().await;
    }

    Ok(TangleResult(JsonResponse {
        json: response.to_string(),
    }))
}
