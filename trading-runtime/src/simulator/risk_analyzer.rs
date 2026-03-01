//! Risk analyzer — takes a `SimulationResult` and produces a `RiskAssessment`
//! with warnings and a numeric risk score.

use alloy::primitives::{Address, U256};
use serde::{Deserialize, Serialize};

use super::{SimulationResult, SimulationWarning};

/// Context about the trade being simulated, used to evaluate risk.
#[derive(Debug, Clone)]
pub struct TradeContext {
    /// The trading vault address
    pub vault_address: Address,
    /// Input token being spent
    pub token_in: Address,
    /// Output token being received
    pub token_out: Address,
    /// Amount of input token being spent
    pub amount_in: U256,
    /// Minimum acceptable output
    pub min_output: U256,
    /// Known protocol addresses (routers, pools, factories)
    pub known_protocol_addresses: Vec<Address>,
}

impl TradeContext {
    /// Check if an address is a known protocol contract.
    pub fn is_known_protocol_address(&self, addr: Address) -> bool {
        self.known_protocol_addresses.contains(&addr)
    }
}

/// Overall risk assessment from simulation analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskAssessment {
    /// 0 = safe, 100 = definitely malicious
    pub risk_score: u32,
    /// Detected risk warnings
    pub warnings: Vec<SimulationWarning>,
    /// Whether the transaction is considered safe to execute
    pub safe: bool,
}

/// Analyze a simulation result against the expected trade context.
///
/// Returns a `RiskAssessment` with a risk score (0-100) and warnings.
/// A score below 20 is considered safe.
pub fn analyze_simulation(
    result: &SimulationResult,
    context: &TradeContext,
) -> RiskAssessment {
    let mut warnings = Vec::new();
    let mut risk_score: u32 = 0;

    // Check 1: Did the simulation revert?
    if !result.success {
        risk_score = risk_score.saturating_add(80);
        // Carry over existing revert warnings
        for w in &result.warnings {
            if matches!(w, SimulationWarning::SimulationReverted { .. }) {
                warnings.push(w.clone());
            }
        }
        if !warnings.iter().any(|w| matches!(w, SimulationWarning::SimulationReverted { .. })) {
            warnings.push(SimulationWarning::SimulationReverted {
                reason: "Transaction reverted during simulation".into(),
            });
        }
    }

    // Check 2: Any approvals to unknown spenders?
    for approval in &result.approval_changes {
        if !context.is_known_protocol_address(approval.spender) {
            risk_score = risk_score.saturating_add(60);
            warnings.push(SimulationWarning::UnexpectedApproval {
                token: approval.token,
                spender: approval.spender,
                amount: approval.amount,
            });
        }
    }

    // Check 3: Vault lost tokens beyond expected input?
    for change in &result.balance_changes {
        if change.account == context.vault_address && change.after < change.before {
            let lost = change.before - change.after;
            // Only flag if the loss is for a token/amount we didn't expect
            if change.token != context.token_in || lost > context.amount_in {
                risk_score = risk_score.saturating_add(40);
                warnings.push(SimulationWarning::BalanceDecrease {
                    token: change.token,
                    account: change.account,
                    lost,
                });
            }
        }
    }

    // Check 4: Transfers to unknown addresses?
    for transfer in &result.transfer_events {
        if transfer.to != context.vault_address
            && !context.is_known_protocol_address(transfer.to)
            && transfer.to != Address::ZERO // burn
        {
            risk_score = risk_score.saturating_add(30);
            warnings.push(SimulationWarning::TransferToUnknownAddress {
                token: transfer.token,
                to: transfer.to,
                amount: transfer.amount,
            });
        }
    }

    // Check 5: Simulated output below minimum?
    // Infer output from transfer events directed to the vault
    let simulated_output: U256 = result
        .transfer_events
        .iter()
        .filter(|t| t.to == context.vault_address && t.token == context.token_out)
        .map(|t| t.amount)
        .fold(U256::ZERO, |acc, a| acc + a);

    if context.min_output > U256::ZERO
        && simulated_output > U256::ZERO
        && simulated_output < context.min_output
    {
        risk_score = risk_score.saturating_add(50);
        warnings.push(SimulationWarning::OutputBelowMinimum {
            expected: context.min_output,
            simulated: simulated_output,
        });
    }

    // Cap risk_score at 100
    risk_score = risk_score.min(100);

    RiskAssessment {
        risk_score,
        warnings,
        safe: risk_score < 20,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::{
        ApprovalChange, BalanceChange, SimulationResult, TransferEvent,
    };
    use alloy::primitives::Bytes;

    fn test_context() -> TradeContext {
        TradeContext {
            vault_address: "0x0000000000000000000000000000000000000099"
                .parse()
                .unwrap(),
            token_in: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
                .parse()
                .unwrap(),
            token_out: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
                .parse()
                .unwrap(),
            amount_in: U256::from(1_000_000_000_000_000_000u128), // 1 WETH
            min_output: U256::from(2_500_000_000u64),              // 2500 USDC
            known_protocol_addresses: vec![
                "0xE592427A0AEce92De3Edee1F18E0157C05861564"
                    .parse()
                    .unwrap(), // Uniswap router
            ],
        }
    }

    #[test]
    fn test_clean_simulation_is_safe() {
        let result = SimulationResult {
            success: true,
            return_data: Bytes::new(),
            gas_used: 150_000,
            balance_changes: Vec::new(),
            approval_changes: Vec::new(),
            transfer_events: Vec::new(),
            warnings: Vec::new(),
        };

        let assessment = analyze_simulation(&result, &test_context());
        assert!(assessment.safe);
        assert_eq!(assessment.risk_score, 0);
        assert!(assessment.warnings.is_empty());
    }

    #[test]
    fn test_reverted_simulation_is_unsafe() {
        let result = SimulationResult {
            success: false,
            return_data: Bytes::new(),
            gas_used: 21_000,
            warnings: vec![SimulationWarning::SimulationReverted {
                reason: "out of gas".into(),
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &test_context());
        assert!(!assessment.safe);
        assert!(assessment.risk_score >= 80);
        assert!(assessment.warnings.iter().any(
            |w| matches!(w, SimulationWarning::SimulationReverted { .. })
        ));
    }

    #[test]
    fn test_unexpected_approval_is_risky() {
        let unknown_spender: Address = "0x0000000000000000000000000000000000000bad"
            .parse()
            .unwrap();

        let result = SimulationResult {
            success: true,
            approval_changes: vec![ApprovalChange {
                token: test_context().token_in,
                owner: test_context().vault_address,
                spender: unknown_spender,
                amount: U256::MAX,
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &test_context());
        assert!(!assessment.safe);
        assert!(assessment.risk_score >= 60);
        assert!(assessment.warnings.iter().any(
            |w| matches!(w, SimulationWarning::UnexpectedApproval { .. })
        ));
    }

    #[test]
    fn test_known_protocol_approval_is_safe() {
        let ctx = test_context();
        let router = ctx.known_protocol_addresses[0];

        let result = SimulationResult {
            success: true,
            approval_changes: vec![ApprovalChange {
                token: ctx.token_in,
                owner: ctx.vault_address,
                spender: router,
                amount: ctx.amount_in,
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(assessment.safe);
        assert_eq!(assessment.risk_score, 0);
    }

    #[test]
    fn test_unexpected_balance_decrease() {
        let ctx = test_context();
        let unknown_token: Address = "0x0000000000000000000000000000000000000bad"
            .parse()
            .unwrap();

        let result = SimulationResult {
            success: true,
            balance_changes: vec![BalanceChange {
                token: unknown_token,
                account: ctx.vault_address,
                before: U256::from(1000u64),
                after: U256::from(500u64),
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(!assessment.safe);
        assert!(assessment.risk_score >= 40);
    }

    #[test]
    fn test_expected_token_in_decrease_is_ok() {
        let ctx = test_context();

        let result = SimulationResult {
            success: true,
            balance_changes: vec![BalanceChange {
                token: ctx.token_in,
                account: ctx.vault_address,
                before: U256::from(2_000_000_000_000_000_000u128),
                after: U256::from(1_000_000_000_000_000_000u128),
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(assessment.safe);
        assert_eq!(assessment.risk_score, 0);
    }

    #[test]
    fn test_transfer_to_unknown_address() {
        let ctx = test_context();
        let attacker: Address = "0x0000000000000000000000000000000000000bad"
            .parse()
            .unwrap();

        let result = SimulationResult {
            success: true,
            transfer_events: vec![TransferEvent {
                token: ctx.token_in,
                from: ctx.vault_address,
                to: attacker,
                amount: U256::from(500_000u64),
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(!assessment.safe);
        assert!(assessment.risk_score >= 30);
    }

    #[test]
    fn test_transfer_to_known_protocol_is_ok() {
        let ctx = test_context();
        let router = ctx.known_protocol_addresses[0];

        let result = SimulationResult {
            success: true,
            transfer_events: vec![TransferEvent {
                token: ctx.token_in,
                from: ctx.vault_address,
                to: router,
                amount: ctx.amount_in,
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(assessment.safe);
    }

    #[test]
    fn test_output_below_minimum() {
        let ctx = test_context();

        let result = SimulationResult {
            success: true,
            transfer_events: vec![TransferEvent {
                token: ctx.token_out,
                from: "0xE592427A0AEce92De3Edee1F18E0157C05861564"
                    .parse()
                    .unwrap(),
                to: ctx.vault_address,
                amount: U256::from(1_000_000_000u64), // 1000 USDC < 2500 min
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(!assessment.safe);
        assert!(assessment.warnings.iter().any(
            |w| matches!(w, SimulationWarning::OutputBelowMinimum { .. })
        ));
    }

    #[test]
    fn test_risk_score_capped_at_100() {
        let ctx = test_context();
        let attacker: Address = "0x0000000000000000000000000000000000000bad"
            .parse()
            .unwrap();

        // Everything bad at once: reverted + approval + transfer + balance decrease
        let result = SimulationResult {
            success: false,
            balance_changes: vec![BalanceChange {
                token: "0x0000000000000000000000000000000000000bad"
                    .parse()
                    .unwrap(),
                account: ctx.vault_address,
                before: U256::from(1000u64),
                after: U256::ZERO,
            }],
            approval_changes: vec![ApprovalChange {
                token: ctx.token_in,
                owner: ctx.vault_address,
                spender: attacker,
                amount: U256::MAX,
            }],
            transfer_events: vec![TransferEvent {
                token: ctx.token_in,
                from: ctx.vault_address,
                to: attacker,
                amount: U256::from(999u64),
            }],
            warnings: vec![SimulationWarning::SimulationReverted {
                reason: "revert".into(),
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert_eq!(assessment.risk_score, 100);
        assert!(!assessment.safe);
    }

    #[test]
    fn test_burn_transfer_not_flagged() {
        let ctx = test_context();

        let result = SimulationResult {
            success: true,
            transfer_events: vec![TransferEvent {
                token: ctx.token_in,
                from: ctx.vault_address,
                to: Address::ZERO, // burn
                amount: U256::from(100u64),
            }],
            ..Default::default()
        };

        let assessment = analyze_simulation(&result, &ctx);
        assert!(assessment.safe);
    }
}
