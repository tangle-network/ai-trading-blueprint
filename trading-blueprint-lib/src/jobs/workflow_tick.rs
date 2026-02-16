//! Trading-aware workflow tick that intercepts the cron tick to detect
//! TTL wind-down conditions and swap the agent prompt accordingly.

use serde_json::Value;

use crate::state::{bot_key, bots};
use crate::wind_down::should_initiate_wind_down;
use crate::JsonResponse;

use ai_agent_sandbox_blueprint_lib::workflows::{workflow_key, workflows};
use blueprint_sdk::tangle::extract::TangleResult;

/// Trading-aware workflow tick.
///
/// Before running the standard workflow tick, checks all active bots for
/// TTL wind-down eligibility. For bots that should start winding down:
/// 1. Records `wind_down_started_at` timestamp
/// 2. Swaps the workflow prompt to the wind-down liquidation prompt
///
/// After the tick completes, runs fee settlement for winding-down bots.
pub async fn trading_workflow_tick() -> Result<TangleResult<JsonResponse>, String> {
    // 1. Check all active bots for wind-down eligibility
    let all_bots = bots()?.values().map_err(|e| e.to_string())?;

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
    let response = ai_agent_sandbox_blueprint_lib::workflows::workflow_tick().await?;

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
