//! Vault client for interacting with on-chain trading vaults.
//!
//! Uses alloy contract bindings from `crate::contracts` to generate
//! properly ABI-encoded transaction data.

use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::sol_types::SolCall;

use crate::contracts::ITradingVault;
use crate::error::TradingError;
use serde::{Deserialize, Serialize};

/// Represents a vault on-chain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultClient {
    pub vault_address: String,
    pub rpc_url: String,
    pub chain_id: u64,
}

/// Encoded transaction data ready for submission
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodedTransaction {
    pub to: String,
    pub data: Vec<u8>,
    pub value: String,
}

impl VaultClient {
    pub fn new(vault_address: String, rpc_url: String, chain_id: u64) -> Self {
        Self {
            vault_address,
            rpc_url,
            chain_id,
        }
    }

    /// Parse a hex address string into an alloy Address.
    fn parse_address(addr: &str) -> Result<Address, TradingError> {
        addr.parse::<Address>()
            .map_err(|e| TradingError::VaultError(format!("Invalid address '{addr}': {e}")))
    }

    /// Parse a decimal string into a U256.
    fn parse_u256(amount: &str) -> Result<U256, TradingError> {
        U256::from_str_radix(amount, 10)
            .map_err(|e| TradingError::VaultError(format!("Invalid amount '{amount}': {e}")))
    }

    /// Encode a deposit call: `deposit(uint256 assets, address receiver)`
    pub fn encode_deposit(
        &self,
        amount: &str,
        receiver: &str,
    ) -> Result<EncodedTransaction, TradingError> {
        let assets = Self::parse_u256(amount)?;
        let receiver_addr = Self::parse_address(receiver)?;

        let call = ITradingVault::depositCall {
            assets,
            receiver: receiver_addr,
        };

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }

    /// Encode a withdraw call: `withdraw(uint256 assets, address receiver, address owner)`
    pub fn encode_withdraw(
        &self,
        amount: &str,
        receiver: &str,
        owner: &str,
    ) -> Result<EncodedTransaction, TradingError> {
        let assets = Self::parse_u256(amount)?;
        let receiver_addr = Self::parse_address(receiver)?;
        let owner_addr = Self::parse_address(owner)?;

        let call = ITradingVault::withdrawCall {
            assets,
            receiver: receiver_addr,
            owner: owner_addr,
        };

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }

    /// Encode a redeem call: `redeem(uint256 shares, address receiver, address owner)`
    pub fn encode_redeem(
        &self,
        shares: &str,
        receiver: &str,
        owner: &str,
    ) -> Result<EncodedTransaction, TradingError> {
        let shares_amount = Self::parse_u256(shares)?;
        let receiver_addr = Self::parse_address(receiver)?;
        let owner_addr = Self::parse_address(owner)?;

        let call = ITradingVault::redeemCall {
            shares: shares_amount,
            receiver: receiver_addr,
            owner: owner_addr,
        };

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }

    /// Encode an execute call (trade through the vault with multisig validation).
    ///
    /// Uses the `ExecuteParams` struct matching the on-chain TradingVault contract.
    pub fn encode_execute(
        &self,
        target: &str,
        calldata: &[u8],
        value: &str,
        min_output: &str,
        output_token: &str,
        intent_hash: [u8; 32],
        signatures: Vec<Vec<u8>>,
        scores: Vec<U256>,
        deadline: U256,
    ) -> Result<EncodedTransaction, TradingError> {
        let target_addr = Self::parse_address(target)?;
        let tx_value = Self::parse_u256(value)?;
        let min_output_amount = Self::parse_u256(min_output)?;
        let output_token_addr = Self::parse_address(output_token)?;

        let sig_bytes: Vec<Bytes> = signatures.into_iter().map(Bytes::from).collect();

        let params = ITradingVault::ExecuteParams {
            target: target_addr,
            data: Bytes::from(calldata.to_vec()),
            value: tx_value,
            minOutput: min_output_amount,
            outputToken: output_token_addr,
            intentHash: FixedBytes::from(intent_hash),
            deadline,
        };

        let call = ITradingVault::executeCall {
            params,
            signatures: sig_bytes,
            scores,
        };

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: value.into(),
        })
    }

    /// Encode an emergency withdraw call: `emergencyWithdraw(address token, address to)`
    pub fn encode_emergency_withdraw(
        &self,
        token: &str,
        to: &str,
    ) -> Result<EncodedTransaction, TradingError> {
        let token_addr = Self::parse_address(token)?;
        let to_addr = Self::parse_address(to)?;

        let call = ITradingVault::emergencyWithdrawCall {
            token: token_addr,
            to: to_addr,
        };

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }

    /// Encode a getBalance call: `getBalance(address token)`
    pub fn encode_get_balance(
        &self,
        token: &str,
    ) -> Result<EncodedTransaction, TradingError> {
        let token_addr = Self::parse_address(token)?;

        let call = ITradingVault::getBalanceCall {
            token: token_addr,
        };

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }

    /// Encode a pause call.
    pub fn encode_pause(&self) -> Result<EncodedTransaction, TradingError> {
        let call = ITradingVault::pauseCall {};

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }

    /// Encode an unpause call.
    pub fn encode_unpause(&self) -> Result<EncodedTransaction, TradingError> {
        let call = ITradingVault::unpauseCall {};

        Ok(EncodedTransaction {
            to: self.vault_address.clone(),
            data: call.abi_encode(),
            value: "0".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_VAULT: &str = "0x0000000000000000000000000000000000000001";
    const TEST_TOKEN: &str = "0x0000000000000000000000000000000000000002";
    const TEST_RECEIVER: &str = "0x0000000000000000000000000000000000000003";

    #[test]
    fn test_encode_deposit() {
        let client = VaultClient::new(TEST_VAULT.into(), "http://localhost:8545".into(), 42161);
        let tx = client.encode_deposit("1000000", TEST_RECEIVER).unwrap();
        assert_eq!(tx.to, TEST_VAULT);
        // Deposit selector: keccak256("deposit(uint256,address)")[:4]
        assert!(tx.data.len() >= 4);
        assert_eq!(tx.value, "0");
    }

    #[test]
    fn test_encode_withdraw() {
        let client = VaultClient::new(TEST_VAULT.into(), "http://localhost:8545".into(), 42161);
        let tx = client
            .encode_withdraw("1000000", TEST_RECEIVER, TEST_RECEIVER)
            .unwrap();
        assert_eq!(tx.to, TEST_VAULT);
        assert!(tx.data.len() >= 4);
    }

    #[test]
    fn test_encode_emergency_withdraw() {
        let client = VaultClient::new(TEST_VAULT.into(), "http://localhost:8545".into(), 42161);
        let tx = client
            .encode_emergency_withdraw(TEST_TOKEN, TEST_RECEIVER)
            .unwrap();
        assert_eq!(tx.to, TEST_VAULT);
        assert!(tx.data.len() >= 4);
    }

    #[test]
    fn test_encode_pause_unpause() {
        let client = VaultClient::new(TEST_VAULT.into(), "http://localhost:8545".into(), 42161);
        let pause_tx = client.encode_pause().unwrap();
        let unpause_tx = client.encode_unpause().unwrap();
        assert_ne!(pause_tx.data, unpause_tx.data);
    }

    #[test]
    fn test_invalid_address() {
        let client = VaultClient::new(TEST_VAULT.into(), "http://localhost:8545".into(), 42161);
        let result = client.encode_deposit("1000000", "not-an-address");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_amount() {
        let client = VaultClient::new(TEST_VAULT.into(), "http://localhost:8545".into(), 42161);
        let result = client.encode_deposit("not-a-number", TEST_RECEIVER);
        assert!(result.is_err());
    }
}
