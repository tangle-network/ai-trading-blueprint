//! Builds the right `ExecuteParams` / `HealthFactorParams` / `DebtReductionParams`
//! shape for envelope-mode execution, given an adapter-encoded action.
//!
//! Used by execute.rs auto-dispatch when `validation_trust=Envelope` and the
//! intent's protocol is vault-routed.

use alloy::primitives::{Address, B256, Bytes, FixedBytes, U256};

use crate::adapters::EncodedAction;
use crate::contracts::ITradingVault;
use crate::error::TradingError;
use crate::executor::EnvelopeExecShape;

/// Build the envelope execution shape from an adapter-encoded action.
///
/// Dispatch rules:
/// - `encoded.debt_reduction` set → `DebtReduction(DebtReductionParams)`  (Aave/Morpho repay)
/// - `encoded.health_factor` set  → `HealthFactor(HealthFactorParams)`   (Aave/Morpho borrow + withdraw)
/// - otherwise                    → `Trade(ExecuteParams)`               (swaps, supplies)
///
/// Caller supplies the canonical `intent_hash` (envelope-mode trades reuse
/// the same dedup keyspace as validator-signed trades) and `deadline`.
pub fn build_envelope_shape(
    encoded: &EncodedAction,
    intent_hash: B256,
    deadline: U256,
) -> Result<EnvelopeExecShape, TradingError> {
    if let Some(debt) = &encoded.debt_reduction {
        return Ok(EnvelopeExecShape::DebtReduction(
            ITradingVault::DebtReductionParams {
                target: encoded.target,
                data: encoded.calldata.clone(),
                value: encoded.value,
                inputToken: debt.input_token,
                maxInput: debt.max_input,
                debtToken: debt.debt_token,
                minDebtDecrease: debt.min_debt_decrease,
                intentHash: FixedBytes::from(<[u8; 32]>::from(intent_hash)),
                deadline,
            },
        ));
    }
    if let Some(hf) = &encoded.health_factor {
        return Ok(EnvelopeExecShape::HealthFactor(
            ITradingVault::HealthFactorParams {
                target: encoded.target,
                data: encoded.calldata.clone(),
                value: encoded.value,
                minOutput: encoded.min_output,
                outputToken: encoded.output_token,
                pool: hf.pool,
                account: hf.account,
                minHealthFactor: hf.min_health_factor,
                intentHash: FixedBytes::from(<[u8; 32]>::from(intent_hash)),
                deadline,
            },
        ));
    }
    Ok(EnvelopeExecShape::Trade(ITradingVault::ExecuteParams {
        target: encoded.target,
        data: encoded.calldata.clone(),
        value: encoded.value,
        minOutput: encoded.min_output,
        outputToken: encoded.output_token,
        intentHash: FixedBytes::from(<[u8; 32]>::from(intent_hash)),
        deadline,
    }))
}

/// Convenience: build EncodedAction-shaped output as raw `(target, calldata, ...)` for tests.
pub fn extract_target_data(encoded: &EncodedAction) -> (Address, Bytes) {
    (encoded.target, encoded.calldata.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{DebtReductionPostcondition, EncodedAction, HealthFactorPostcondition};

    fn dummy_encoded() -> EncodedAction {
        EncodedAction {
            target: Address::repeat_byte(1),
            calldata: Bytes::from(vec![0x12, 0x34]),
            value: U256::ZERO,
            min_output: U256::from(100u64),
            output_token: Address::repeat_byte(2),
            approvals: vec![],
            debt_reduction: None,
            health_factor: None,
        }
    }

    #[test]
    fn defaults_to_trade_shape() {
        let encoded = dummy_encoded();
        let shape = build_envelope_shape(&encoded, B256::ZERO, U256::from(0u64)).unwrap();
        assert!(matches!(shape, EnvelopeExecShape::Trade(_)));
    }

    #[test]
    fn debt_reduction_routes_to_debt_shape() {
        let mut encoded = dummy_encoded();
        encoded.debt_reduction = Some(DebtReductionPostcondition {
            input_token: Address::repeat_byte(3),
            max_input: U256::from(100u64),
            debt_token: Address::repeat_byte(4),
            min_debt_decrease: U256::from(50u64),
        });
        let shape = build_envelope_shape(&encoded, B256::ZERO, U256::ZERO).unwrap();
        assert!(matches!(shape, EnvelopeExecShape::DebtReduction(_)));
    }

    #[test]
    fn health_factor_routes_to_health_factor_shape() {
        let mut encoded = dummy_encoded();
        encoded.health_factor = Some(HealthFactorPostcondition {
            pool: Address::repeat_byte(3),
            account: Address::repeat_byte(4),
            min_health_factor: U256::from(1_000_000_000_000_000_000u128),
        });
        let shape = build_envelope_shape(&encoded, B256::ZERO, U256::ZERO).unwrap();
        assert!(matches!(shape, EnvelopeExecShape::HealthFactor(_)));
    }

    #[test]
    fn debt_reduction_takes_precedence_over_health_factor() {
        // If both happen to be set, debt-reduction wins — repay path.
        let mut encoded = dummy_encoded();
        encoded.debt_reduction = Some(DebtReductionPostcondition {
            input_token: Address::repeat_byte(3),
            max_input: U256::from(100u64),
            debt_token: Address::repeat_byte(4),
            min_debt_decrease: U256::from(50u64),
        });
        encoded.health_factor = Some(HealthFactorPostcondition {
            pool: Address::repeat_byte(5),
            account: Address::repeat_byte(6),
            min_health_factor: U256::from(1_000_000_000_000_000_000u128),
        });
        let shape = build_envelope_shape(&encoded, B256::ZERO, U256::ZERO).unwrap();
        assert!(matches!(shape, EnvelopeExecShape::DebtReduction(_)));
    }
}
