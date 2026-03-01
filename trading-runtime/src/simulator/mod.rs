//! Transaction simulation framework for detecting malicious payloads
//! before they hit the chain.
//!
//! Provides a pluggable `TransactionSimulator` trait with two backends:
//! - `EthCallSimulator` — free, uses `eth_call` (always available)
//! - `TenderlySimulator` — rich traces via Tenderly API (when configured)

pub mod eth_call;
pub mod risk_analyzer;
pub mod tenderly;

use alloy::primitives::{Address, Bytes, U256};
use serde::{Deserialize, Serialize};
use std::fmt;

use crate::error::TradingError;

/// Request to simulate a transaction.
#[derive(Debug, Clone)]
pub struct SimulationRequest {
    /// Address initiating the call (vault or operator)
    pub from: Address,
    /// Target contract address
    pub to: Address,
    /// ABI-encoded calldata
    pub data: Bytes,
    /// ETH value sent with the call
    pub value: U256,
    /// Optional block number to simulate at (latest if None)
    pub block_number: Option<u64>,
    /// Tokens to check balances for (best-effort by EthCallSimulator)
    pub token_addresses: Vec<Address>,
    /// Account to check balances on (typically the vault)
    pub balance_check_account: Option<Address>,
}

/// Result of a transaction simulation.
#[derive(Debug, Clone, Default)]
pub struct SimulationResult {
    /// Whether the simulated transaction succeeded
    pub success: bool,
    /// Raw return data from the call
    pub return_data: Bytes,
    /// Gas consumed by the simulation
    pub gas_used: u64,
    /// Token balance changes detected
    pub balance_changes: Vec<BalanceChange>,
    /// ERC20 approval changes detected
    pub approval_changes: Vec<ApprovalChange>,
    /// ERC20 Transfer events detected
    pub transfer_events: Vec<TransferEvent>,
    /// Risk warnings from analysis
    pub warnings: Vec<SimulationWarning>,
}

/// A token balance change for a specific account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceChange {
    pub token: Address,
    pub account: Address,
    pub before: U256,
    pub after: U256,
}

/// An ERC20 Approval event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalChange {
    pub token: Address,
    pub owner: Address,
    pub spender: Address,
    pub amount: U256,
}

/// An ERC20 Transfer event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferEvent {
    pub token: Address,
    pub from: Address,
    pub to: Address,
    pub amount: U256,
}

/// Warning types detected during simulation analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SimulationWarning {
    UnexpectedApproval {
        token: Address,
        spender: Address,
        amount: U256,
    },
    BalanceDecrease {
        token: Address,
        account: Address,
        lost: U256,
    },
    OutputBelowMinimum {
        expected: U256,
        simulated: U256,
    },
    TransferToUnknownAddress {
        token: Address,
        to: Address,
        amount: U256,
    },
    SimulationReverted {
        reason: String,
    },
}

impl fmt::Display for SimulationWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedApproval {
                token,
                spender,
                amount,
            } => write!(
                f,
                "UnexpectedApproval: token={token} spender={spender} amount={amount}"
            ),
            Self::BalanceDecrease {
                token,
                account,
                lost,
            } => write!(
                f,
                "BalanceDecrease: token={token} account={account} lost={lost}"
            ),
            Self::OutputBelowMinimum {
                expected,
                simulated,
            } => write!(
                f,
                "OutputBelowMinimum: expected={expected} simulated={simulated}"
            ),
            Self::TransferToUnknownAddress { token, to, amount } => write!(
                f,
                "TransferToUnknownAddress: token={token} to={to} amount={amount}"
            ),
            Self::SimulationReverted { reason } => {
                write!(f, "SimulationReverted: {reason}")
            }
        }
    }
}

/// Pluggable backend for transaction simulation.
#[async_trait::async_trait]
pub trait TransactionSimulator: Send + Sync {
    async fn simulate(&self, request: SimulationRequest) -> Result<SimulationResult, TradingError>;
}

/// Configuration for selecting a simulator backend.
#[derive(Debug, Clone, Default)]
pub struct SimulatorConfig {
    pub tenderly_api_key: Option<String>,
    pub tenderly_account: Option<String>,
    pub tenderly_project: Option<String>,
    /// Chain ID for the target network (defaults to 1 for mainnet)
    pub chain_id: Option<u64>,
}

impl SimulatorConfig {
    /// Load simulator config from environment variables.
    pub fn from_env() -> Self {
        Self {
            tenderly_api_key: std::env::var("TENDERLY_API_KEY").ok(),
            tenderly_account: std::env::var("TENDERLY_ACCOUNT").ok(),
            tenderly_project: std::env::var("TENDERLY_PROJECT").ok(),
            chain_id: std::env::var("CHAIN_ID")
                .ok()
                .and_then(|s| s.parse().ok()),
        }
    }
}

/// Create the best available simulator based on configuration.
pub fn create_simulator(
    rpc_url: String,
    config: &SimulatorConfig,
) -> Box<dyn TransactionSimulator> {
    if let (Some(key), Some(account), Some(project)) = (
        &config.tenderly_api_key,
        &config.tenderly_account,
        &config.tenderly_project,
    ) {
        tracing::info!("Using TenderlySimulator for transaction simulation");
        Box::new(tenderly::TenderlySimulator::new(
            key.clone(),
            account.clone(),
            project.clone(),
            rpc_url,
            config.chain_id.unwrap_or(1),
        ))
    } else {
        tracing::info!("Using EthCallSimulator for transaction simulation");
        Box::new(eth_call::EthCallSimulator::new(rpc_url))
    }
}

// ERC20 event topic constants (keccak256 of event signatures)
/// keccak256("Transfer(address,address,uint256)")
pub const TRANSFER_TOPIC: &str =
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/// keccak256("Approval(address,address,uint256)")
pub const APPROVAL_TOPIC: &str =
    "8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simulation_warning_display() {
        let w = SimulationWarning::SimulationReverted {
            reason: "out of gas".into(),
        };
        assert!(w.to_string().contains("SimulationReverted"));
        assert!(w.to_string().contains("out of gas"));
    }

    #[test]
    fn test_unexpected_approval_display() {
        let w = SimulationWarning::UnexpectedApproval {
            token: Address::ZERO,
            spender: Address::ZERO,
            amount: U256::from(100u64),
        };
        let s = w.to_string();
        assert!(s.contains("UnexpectedApproval"));
    }

    #[test]
    fn test_simulator_config_default() {
        let config = SimulatorConfig::default();
        assert!(config.tenderly_api_key.is_none());
        assert!(config.tenderly_project.is_none());
    }

    #[test]
    fn test_create_simulator_defaults_to_eth_call() {
        let config = SimulatorConfig::default();
        let _sim = create_simulator("http://localhost:8545".into(), &config);
        // Should not panic — creates EthCallSimulator
    }

    #[test]
    fn test_balance_change_serde() {
        let change = BalanceChange {
            token: Address::ZERO,
            account: Address::ZERO,
            before: U256::from(100u64),
            after: U256::from(50u64),
        };
        let json = serde_json::to_string(&change).unwrap();
        let _: BalanceChange = serde_json::from_str(&json).unwrap();
    }
}
