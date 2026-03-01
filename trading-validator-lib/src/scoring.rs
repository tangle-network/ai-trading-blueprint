use crate::risk_evaluator::AiProvider;
use crate::server::ExecutionContext;
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

/// Classified warning type for structured penalty computation.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WarningClass {
    UnexpectedApproval,
    TransferToUnknown,
    BalanceDecrease,
    OutputBelowMinimum,
    Reverted,
    Other,
}

/// Classify a warning string by matching the prefix format from `SimulationWarning::Display`.
fn classify_warning(s: &str) -> WarningClass {
    if s.starts_with("UnexpectedApproval:") {
        WarningClass::UnexpectedApproval
    } else if s.starts_with("TransferToUnknownAddress:") {
        WarningClass::TransferToUnknown
    } else if s.starts_with("BalanceDecrease:") {
        WarningClass::BalanceDecrease
    } else if s.starts_with("OutputBelowMinimum:") {
        WarningClass::OutputBelowMinimum
    } else if s.starts_with("SimulationReverted:") {
        WarningClass::Reverted
    } else {
        WarningClass::Other
    }
}

/// Compute simulation penalty from execution context.
///
/// Returns 0-100 penalty (higher = more suspicious).
fn simulation_score(ctx: &ExecutionContext) -> u32 {
    let mut penalty: u32 = 0;
    if let Some(ref sim) = ctx.simulation_result {
        if !sim.success {
            penalty = penalty.saturating_add(80);
        }
        penalty = penalty.saturating_add(sim.risk_score.min(100));
        for warning in &sim.warnings {
            match classify_warning(warning) {
                WarningClass::UnexpectedApproval => penalty = penalty.saturating_add(30),
                WarningClass::TransferToUnknown => penalty = penalty.saturating_add(20),
                WarningClass::BalanceDecrease => penalty = penalty.saturating_add(15),
                WarningClass::OutputBelowMinimum => penalty = penalty.saturating_add(25),
                WarningClass::Reverted => penalty = penalty.saturating_add(10),
                WarningClass::Other => penalty = penalty.saturating_add(5),
            }
        }
    }
    penalty.min(100)
}

/// Compute composite score: policy (fast) + AI (optional) + simulation (optional).
///
/// Blending weights:
/// - With AI + simulation: 30% policy + 50% AI + 20% simulation
/// - With AI only: 40% policy + 60% AI
/// - With simulation only: 70% policy + 30% simulation
/// - Policy only: 100% policy
///
/// Records metrics (latency, score, AI failures) for QoS tracking.
pub async fn compute_score(
    intent: &TradeIntent,
    ai_provider: Option<&AiProvider>,
    strategy_context: Option<&str>,
    execution_context: Option<&ExecutionContext>,
) -> Result<ScoringResult, String> {
    let start = std::time::Instant::now();
    let policy = policy_score(intent);

    // If policy score is 0, no need for further evaluation
    if policy.score == 0 {
        record_metrics(policy.score, start.elapsed().as_millis() as u64, false);
        return Ok(policy);
    }

    // Compute simulation penalty (0 if no execution context)
    let sim_penalty = execution_context.map(simulation_score).unwrap_or(0);
    let sim_score = 100u32.saturating_sub(sim_penalty);

    let has_sim = execution_context.is_some();

    // If AI provider is available, get AI score and blend
    let result = if let Some(provider) = ai_provider {
        match crate::risk_evaluator::evaluate_risk(
            intent,
            provider,
            strategy_context,
            execution_context,
        )
        .await
        {
            Ok(ai_result) => {
                let blended_score = if has_sim {
                    // 30% policy + 50% AI + 20% simulation
                    (policy.score * 30 + ai_result.score * 50 + sim_score * 20) / 100
                } else {
                    // 40% policy + 60% AI
                    (policy.score * 40 + ai_result.score * 60) / 100
                };

                let mut reasoning = format!(
                    "Policy: {} (score: {}). AI[{}]: {} (score: {})",
                    policy.reasoning,
                    policy.score,
                    provider.model(),
                    ai_result.reasoning,
                    ai_result.score,
                );
                if has_sim {
                    reasoning.push_str(&format!(
                        ". Simulation: penalty={sim_penalty}, score={sim_score}"
                    ));
                }

                Ok(ScoringResult {
                    score: blended_score,
                    reasoning,
                })
            }
            Err(e) => {
                // Fall back to policy + simulation scoring
                tracing::warn!("AI scoring failed, using policy + simulation: {e}");
                record_metrics(policy.score, start.elapsed().as_millis() as u64, true);
                let score = if has_sim {
                    (policy.score * 70 + sim_score * 30) / 100
                } else {
                    policy.score
                };
                Ok(ScoringResult {
                    score,
                    reasoning: format!("{} (AI unavailable: {e})", policy.reasoning),
                })
            }
        }
    } else if has_sim {
        // No AI provider, policy + simulation
        let score = (policy.score * 70 + sim_score * 30) / 100;
        Ok(ScoringResult {
            score,
            reasoning: format!(
                "{}. Simulation: penalty={sim_penalty}, score={sim_score}",
                policy.reasoning
            ),
        })
    } else {
        // No AI, no simulation — policy only
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
    use trading_runtime::Action;
    use trading_runtime::intent::TradeIntentBuilder;

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

        let result = compute_score(&intent, None, None, None).await.unwrap();
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

        let result = compute_score(&intent, None, None, None).await.unwrap();
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

        let result = compute_score(&intent, None, None, None).await.unwrap();
        assert_eq!(result.score, 0);
    }

    #[tokio::test]
    async fn test_simulation_penalty_reverted() {
        let ctx = ExecutionContext {
            target: "0x0000000000000000000000000000000000000001".into(),
            calldata: "0xdeadbeef".into(),
            calldata_decoded: "unknown()".into(),
            value: "0".into(),
            simulation_result: Some(crate::server::SimulationSummary {
                success: false,
                gas_used: 21000,
                output_amount: "0".into(),
                balance_changes: Vec::new(),
                warnings: Vec::new(),
                risk_score: 0,
            }),
        };
        let penalty = simulation_score(&ctx);
        assert!(penalty >= 80);
    }

    #[tokio::test]
    async fn test_simulation_penalty_with_warnings() {
        let ctx = ExecutionContext {
            target: "0x0000000000000000000000000000000000000001".into(),
            calldata: "0xdeadbeef".into(),
            calldata_decoded: "unknown()".into(),
            value: "0".into(),
            simulation_result: Some(crate::server::SimulationSummary {
                success: true,
                gas_used: 150000,
                output_amount: "1000".into(),
                balance_changes: Vec::new(),
                warnings: vec!["UnexpectedApproval: token=0x...".into()],
                risk_score: 60,
            }),
        };
        let penalty = simulation_score(&ctx);
        assert!(penalty >= 60);
    }

    #[tokio::test]
    async fn test_blended_score_with_simulation() {
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

        let ctx = ExecutionContext {
            target: "0xE592427A0AEce92De3Edee1F18E0157C05861564".into(),
            calldata: "0x414bf389".into(),
            calldata_decoded: "exactInputSingle(...)".into(),
            value: "0".into(),
            simulation_result: Some(crate::server::SimulationSummary {
                success: true,
                gas_used: 150000,
                output_amount: "2500000000".into(),
                balance_changes: Vec::new(),
                warnings: Vec::new(),
                risk_score: 0,
            }),
        };

        // Policy=100, sim_penalty=0, sim_score=100 → (100*70 + 100*30)/100 = 100
        let result = compute_score(&intent, None, None, Some(&ctx)).await.unwrap();
        assert_eq!(result.score, 100);
    }

    #[test]
    fn test_classify_warning_unexpected_approval() {
        assert_eq!(
            classify_warning("UnexpectedApproval: token=0xABC spender=0xDEF amount=999"),
            WarningClass::UnexpectedApproval
        );
    }

    #[test]
    fn test_classify_warning_transfer_to_unknown() {
        assert_eq!(
            classify_warning("TransferToUnknownAddress: token=0xABC to=0xDEF amount=100"),
            WarningClass::TransferToUnknown
        );
    }

    #[test]
    fn test_classify_warning_balance_decrease() {
        assert_eq!(
            classify_warning("BalanceDecrease: token=0xABC account=0xDEF lost=500"),
            WarningClass::BalanceDecrease
        );
    }

    #[test]
    fn test_classify_warning_output_below_minimum() {
        assert_eq!(
            classify_warning("OutputBelowMinimum: expected=1000 simulated=500"),
            WarningClass::OutputBelowMinimum
        );
    }

    #[test]
    fn test_classify_warning_reverted() {
        assert_eq!(
            classify_warning("SimulationReverted: out of gas"),
            WarningClass::Reverted
        );
    }

    #[test]
    fn test_classify_warning_other() {
        assert_eq!(classify_warning("some random warning"), WarningClass::Other);
    }

    #[test]
    fn test_simulation_penalty_per_class() {
        // Each warning class should produce a different penalty
        let make_ctx = |warning: &str| ExecutionContext {
            target: "0x0000000000000000000000000000000000000001".into(),
            calldata: "0xdeadbeef".into(),
            calldata_decoded: "unknown()".into(),
            value: "0".into(),
            simulation_result: Some(crate::server::SimulationSummary {
                success: true,
                gas_used: 100000,
                output_amount: "0".into(),
                balance_changes: Vec::new(),
                warnings: vec![warning.into()],
                risk_score: 0,
            }),
        };

        let approval_penalty = simulation_score(
            &make_ctx("UnexpectedApproval: token=0xA spender=0xB amount=100"),
        );
        let transfer_penalty = simulation_score(
            &make_ctx("TransferToUnknownAddress: token=0xA to=0xB amount=100"),
        );
        let balance_penalty =
            simulation_score(&make_ctx("BalanceDecrease: token=0xA account=0xB lost=100"));

        // Approval penalty (30) > transfer (20) > balance (15)
        assert!(approval_penalty > transfer_penalty);
        assert!(transfer_penalty > balance_penalty);
    }
}
