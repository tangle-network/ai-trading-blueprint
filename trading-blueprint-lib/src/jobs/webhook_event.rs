use serde_json::{Value, json};

use crate::prompts::packs;
use crate::state::{bots, TradingBotRecord};
use crate::JsonResponse;

/// Process a webhook event by routing it to matching bots' sidecars.
///
/// The webhook body JSON should have:
/// - `target`: `"all"`, `"strategy:<type>"`, or `"bot:<bot_id>"` (default: `"all"`)
/// - `event`: event type string (e.g. `"price_move"`, `"alert"`)
/// - `data`: arbitrary event data
///
/// This handler is triggered by both the webhook gateway (HTTP -> JobCall) and
/// the Polymarket WebSocket producer (price move -> JobCall).
pub async fn webhook_event_core(body: &[u8]) -> Result<JsonResponse, String> {
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| format!("Invalid webhook JSON: {e}"))?;

    let target = payload["target"].as_str().unwrap_or("all");
    let event_type = payload["event"].as_str().unwrap_or("alert");
    let data = &payload["data"];

    let matching_bots = find_target_bots(target)?;

    if matching_bots.is_empty() {
        tracing::warn!(target, event_type, "webhook event: no matching bots");
        return Ok(JsonResponse {
            json: json!({
                "status": "no_match",
                "target": target,
                "bots_triggered": 0,
            })
            .to_string(),
        });
    }

    let mut triggered = 0u32;
    for bot in &matching_bots {
        let prompt = build_event_prompt_for_bot(bot, event_type, data);

        if let Err(e) = run_task_in_bot(bot, &prompt).await {
            tracing::error!(
                bot_id = %bot.id,
                event_type,
                error = %e,
                "failed to dispatch webhook event to bot"
            );
        } else {
            triggered += 1;
        }
    }

    tracing::info!(
        event_type,
        target,
        triggered,
        total = matching_bots.len(),
        "webhook event dispatched"
    );

    Ok(JsonResponse {
        json: json!({
            "status": "dispatched",
            "event": event_type,
            "target": target,
            "bots_triggered": triggered,
        })
        .to_string(),
    })
}

/// Build a provider-aware event prompt for a bot.
///
/// 1. Try the bot's strategy pack providers for an event-specific prompt
/// 2. Fall back to a generic prompt with strategy context
pub(crate) fn build_event_prompt_for_bot(
    bot: &TradingBotRecord,
    event_type: &str,
    data: &Value,
) -> String {
    // Try provider-specific event prompt
    if let Some(pack) = packs::get_pack(&bot.strategy_type) {
        if let Some(prompt) = pack.build_event_prompt(event_type, data, bot) {
            return prompt;
        }
    }

    // Fallback: generic event prompt with strategy context
    format!(
        "ALERT: {event_type} event for {strategy} strategy.\n\
         Data: {data}\n\n\
         Analyze this event using your tools and strategy knowledge. \
         If trading action is warranted, follow the standard validate -> execute pipeline. \
         Check circuit breaker before any trade execution.",
        strategy = bot.strategy_type,
    )
}

/// Find bots matching a target specifier.
fn find_target_bots(target: &str) -> Result<Vec<TradingBotRecord>, String> {
    let all_bots = bots()?.values().map_err(|e| e.to_string())?;

    if target == "all" {
        return Ok(all_bots.into_iter().filter(|b| b.trading_active).collect());
    }

    if let Some(strategy) = target.strip_prefix("strategy:") {
        return Ok(all_bots
            .into_iter()
            .filter(|b| b.trading_active && b.strategy_type == strategy)
            .collect());
    }

    if let Some(bot_id) = target.strip_prefix("bot:") {
        return Ok(all_bots
            .into_iter()
            .filter(|b| b.id == bot_id)
            .collect());
    }

    Err(format!(
        "Invalid target: '{target}'. Expected 'all', 'strategy:<type>', or 'bot:<id>'"
    ))
}

/// Run a task in a bot's sidecar with the bot's full agent profile and shared
/// session (same session_id as the cron trading loop).
async fn run_task_in_bot(bot: &TradingBotRecord, prompt: &str) -> Result<(), String> {
    let sandbox = sandbox_runtime::runtime::sandboxes()
        .map_err(|e| e.to_string())?
        .get(&bot.sandbox_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Sandbox {} not found for bot {}", bot.sandbox_id, bot.id))?;

    // Build the full agent profile — same as the cron path uses
    let backend_profile = if let Some(pack) = packs::get_pack(&bot.strategy_type) {
        Some(crate::prompts::build_pack_agent_profile(&pack, bot))
    } else {
        Some(packs::build_generic_agent_profile(&bot.strategy_type, bot))
    };

    let task_req = ai_agent_sandbox_blueprint_lib::SandboxTaskRequest {
        sidecar_url: sandbox.sidecar_url.clone(),
        prompt: prompt.to_string(),
        // Same session as cron ticks — agent sees its existing tools, DB, and phase state
        session_id: format!("trading-{}", bot.id),
        max_turns: 10,
        model: String::new(),
        context_json: String::new(),
        timeout_ms: 120_000,
        sidecar_token: sandbox.token.clone(),
    };

    match ai_agent_sandbox_blueprint_lib::run_task_request_with_profile(
        &task_req,
        backend_profile.as_ref(),
    )
    .await
    {
        Ok(resp) => {
            if resp.success {
                tracing::info!(bot_id = %bot.id, "webhook task completed");
            } else {
                tracing::warn!(
                    bot_id = %bot.id,
                    error = %resp.error,
                    "webhook task returned error"
                );
            }
            Ok(())
        }
        Err(e) => {
            tracing::warn!(bot_id = %bot.id, "task API failed: {e}");
            // Fall back to exec with a simple echo
            let exec_req = ai_agent_sandbox_blueprint_lib::SandboxExecRequest {
                sidecar_url: sandbox.sidecar_url.clone(),
                command: format!(
                    "echo '{}' >> /home/agent/logs/webhook-events.jsonl",
                    serde_json::to_string(&json!({
                        "prompt": prompt,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }))
                    .unwrap_or_default()
                    .replace('\'', "'\\''")
                ),
                cwd: String::new(),
                env_json: String::new(),
                timeout_ms: 30_000,
                sidecar_token: sandbox.token.clone(),
            };
            ai_agent_sandbox_blueprint_lib::run_exec_request(&exec_req)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

/// Webhook event job handler — receives raw body bytes from webhook/WS producers.
///
/// Returns a `TangleResult` for compatibility with the router's `IntoJobResult` trait.
/// For webhook-originated calls (no on-chain call_id), the consumer will simply
/// discard the result.
pub async fn webhook_event(
    body: bytes::Bytes,
) -> Result<blueprint_sdk::tangle::extract::TangleResult<JsonResponse>, String> {
    let response = webhook_event_core(&body).await?;
    Ok(blueprint_sdk::tangle::extract::TangleResult(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_bot(strategy_type: &str) -> TradingBotRecord {
        TradingBotRecord {
            id: "test-bot-1".to_string(),
            sandbox_id: "sb".to_string(),
            vault_address: "0xVAULT".to_string(),
            share_token: String::new(),
            strategy_type: strategy_type.to_string(),
            strategy_config: json!({}),
            risk_params: json!({"max_drawdown_pct": 5}),
            chain_id: 31337,
            rpc_url: "http://localhost:8545".to_string(),
            trading_api_url: "http://test-api:9100".to_string(),
            trading_api_token: "test-token".to_string(),
            workflow_id: None,
            trading_active: true,
            created_at: 0,
            operator_address: String::new(),
            validator_service_ids: vec![],
            max_lifetime_days: 30,
            paper_trade: true,
            wind_down_started_at: None,
        }
    }

    #[test]
    fn test_build_event_prompt_uses_provider() {
        let bot = test_bot("prediction");
        let prompt = build_event_prompt_for_bot(
            &bot,
            "price_move",
            &json!({"market": "ETH > $5000?", "price": 0.35}),
        );
        // Should get polymarket-specific prompt
        assert!(
            prompt.contains("POLYMARKET"),
            "prediction bot price_move should get polymarket-specific prompt"
        );
        assert!(prompt.contains("CLOB"));
    }

    #[test]
    fn test_build_event_prompt_fallback() {
        let bot = test_bot("prediction");
        let prompt = build_event_prompt_for_bot(
            &bot,
            "completely_unknown_event_type_xyz",
            &json!({"info": "test"}),
        );
        // Should get generic fallback
        assert!(
            prompt.contains("ALERT"),
            "unknown event should get generic ALERT prompt"
        );
        assert!(prompt.contains("prediction"));
        assert!(prompt.contains("validate -> execute"));
    }

    #[test]
    fn test_build_event_prompt_includes_market_data() {
        let bot = test_bot("prediction");
        let data = json!({"market_id": "abc123", "price": 0.65});
        let prompt = build_event_prompt_for_bot(&bot, "price_move", &data);
        assert!(
            prompt.contains("abc123"),
            "event prompt should include market data"
        );
    }

    #[test]
    fn test_build_event_prompt_perp_funding() {
        let bot = test_bot("perp");
        let prompt = build_event_prompt_for_bot(
            &bot,
            "funding_rate",
            &json!({"rate": 0.001}),
        );
        // perp pack has gmx_v2, hyperliquid, vertex — all handle funding_rate
        assert!(prompt.contains("FUNDING RATE"));
    }

    #[test]
    fn test_build_event_prompt_unknown_strategy() {
        let bot = test_bot("custom_strategy");
        let prompt = build_event_prompt_for_bot(&bot, "alert", &json!({"msg": "test"}));
        // No pack for "custom_strategy" → generic fallback
        assert!(prompt.contains("ALERT"));
        assert!(prompt.contains("custom_strategy"));
    }
}
