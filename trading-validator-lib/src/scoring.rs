use crate::risk_evaluator::AiProvider;
use rust_decimal::Decimal;
use trading_runtime::TradeIntent;

#[derive(Debug, Clone)]
pub struct ScoringResult {
    pub score: u32, // 0-100
    pub reasoning: String,
}

/// Fast policy checks (sub-millisecond)
fn policy_score(intent: &TradeIntent) -> ScoringResult {
    let mut score: u32 = 100;
    let mut reasons = Vec::new();

    // Check deadline is in the future
    if intent.deadline < chrono::Utc::now() {
        score = score.saturating_sub(50);
        reasons.push("Intent has expired deadline");
    }

    // Check min_amount_out is set (slippage protection)
    if intent.min_amount_out == Decimal::ZERO {
        score = score.saturating_sub(20);
        reasons.push("No minimum output specified (slippage unprotected)");
    }

    // Check amount is positive
    if intent.amount_in == Decimal::ZERO {
        score = 0;
        reasons.push("Zero trade amount");
    }

    let reasoning = if reasons.is_empty() {
        "All policy checks passed".to_string()
    } else {
        reasons.join("; ")
    };

    ScoringResult { score, reasoning }
}

/// Compute composite score: policy (fast) + AI (optional, slower).
///
/// `strategy_context` is an optional one-liner injected into the AI prompt
/// to give the evaluator protocol-specific awareness.
///
/// Records metrics (latency, score, AI failures) for QoS tracking.
pub async fn compute_score(
    intent: &TradeIntent,
    ai_provider: Option<&AiProvider>,
    strategy_context: Option<&str>,
) -> Result<ScoringResult, String> {
    let start = std::time::Instant::now();
    let policy = policy_score(intent);

    // If policy score is 0, no need for AI evaluation
    if policy.score == 0 {
        record_metrics(policy.score, start.elapsed().as_millis() as u64, false);
        return Ok(policy);
    }

    // If AI provider is available, get AI score and blend
    let result = if let Some(provider) = ai_provider {
        match crate::risk_evaluator::evaluate_risk(intent, provider, strategy_context).await {
            Ok(ai_result) => {
                // Blend: 40% policy + 60% AI
                let blended_score = (policy.score * 40 + ai_result.score * 60) / 100;
                let reasoning = format!(
                    "Policy: {} (score: {}). AI[{}]: {} (score: {})",
                    policy.reasoning,
                    policy.score,
                    provider.model(),
                    ai_result.reasoning,
                    ai_result.score,
                );
                Ok(ScoringResult {
                    score: blended_score,
                    reasoning,
                })
            }
            Err(e) => {
                // Fall back to policy-only scoring
                tracing::warn!("AI scoring failed, using policy only: {e}");
                record_metrics(policy.score, start.elapsed().as_millis() as u64, true);
                Ok(ScoringResult {
                    score: policy.score,
                    reasoning: format!("{} (AI unavailable: {e})", policy.reasoning),
                })
            }
        }
    } else {
        // No AI provider, policy only
        Ok(policy)
    };

    if let Ok(ref r) = result {
        record_metrics(r.score, start.elapsed().as_millis() as u64, false);
    }

    result
}

/// Record validation metrics for the current operator.
fn record_metrics(score: u32, latency_ms: u64, ai_failed: bool) {
    let operator_addr = crate::context::operator_context()
        .map(|ctx| format!("{}", ctx.operator_address))
        .unwrap_or_else(|| "unknown".to_string());

    let _ = crate::update_validator_metrics(&operator_addr, |metrics| {
        metrics.record_validation(score, latency_ms);
        if ai_failed {
            metrics.record_ai_failure();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use trading_runtime::intent::TradeIntentBuilder;
    use trading_runtime::Action;

    #[tokio::test]
    async fn test_policy_score_all_pass() {
        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .min_amount_out(Decimal::new(95, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = compute_score(&intent, None, None).await.unwrap();
        assert_eq!(result.score, 100);
    }

    #[tokio::test]
    async fn test_policy_score_no_min_output() {
        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::new(100, 0))
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = compute_score(&intent, None, None).await.unwrap();
        assert_eq!(result.score, 80); // -20 for no min output
    }

    #[tokio::test]
    async fn test_policy_score_zero_amount() {
        let intent = TradeIntentBuilder::new()
            .strategy_id("test")
            .action(Action::Swap)
            .token_in("0xA")
            .token_out("0xB")
            .amount_in(Decimal::ZERO)
            .target_protocol("uniswap_v3")
            .build()
            .unwrap();

        let result = compute_score(&intent, None, None).await.unwrap();
        assert_eq!(result.score, 0);
    }
}
