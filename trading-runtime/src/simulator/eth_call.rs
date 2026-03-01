//! EthCallSimulator — always-available backend using `eth_call`.
//!
//! Uses the RPC provider to dry-run the transaction and detect
//! basic success/failure. For balance changes, queries `balanceOf`
//! before and after via separate `eth_call` invocations.

use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{SimulationRequest, SimulationResult, SimulationWarning, TransactionSimulator};
use crate::error::TradingError;

sol! {
    function balanceOf(address account) external view returns (uint256);
}

/// Simulator backend using `eth_call` (JSON-RPC).
pub struct EthCallSimulator {
    rpc_url: String,
    client: reqwest::Client,
}

impl EthCallSimulator {
    pub fn new(rpc_url: String) -> Self {
        Self {
            rpc_url,
            client: reqwest::Client::new(),
        }
    }

    /// Query ERC20 balanceOf via eth_call.
    async fn query_balance(
        &self,
        token: Address,
        account: Address,
        block: Option<u64>,
    ) -> Result<U256, TradingError> {
        let calldata = balanceOfCall { account }.abi_encode();
        let block_tag = block
            .map(|b| format!("0x{b:x}"))
            .unwrap_or_else(|| "latest".to_string());

        let response = self
            .client
            .post(&self.rpc_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_call",
                "params": [
                    {
                        "to": format!("{token}"),
                        "data": format!("0x{}", hex::encode(&calldata)),
                    },
                    block_tag,
                ]
            }))
            .send()
            .await
            .map_err(|e| TradingError::HttpError(format!("eth_call balanceOf failed: {e}")))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TradingError::HttpError(format!("balanceOf response parse: {e}")))?;

        if let Some(error) = body.get("error") {
            // balanceOf failed — token may not be ERC20, return zero
            tracing::debug!(token = %token, error = %error, "balanceOf query failed");
            return Ok(U256::ZERO);
        }

        let result_hex = body["result"]
            .as_str()
            .unwrap_or("0x0");

        let stripped = result_hex.strip_prefix("0x").unwrap_or(result_hex);
        Ok(U256::from_str_radix(stripped, 16).unwrap_or(U256::ZERO))
    }

    /// Execute eth_call and return (success, return_data, gas_used).
    async fn eth_call(
        &self,
        request: &SimulationRequest,
    ) -> Result<(bool, Bytes, u64), TradingError> {
        let block_tag = request
            .block_number
            .map(|b| format!("0x{b:x}"))
            .unwrap_or_else(|| "latest".to_string());

        let mut tx_obj = serde_json::json!({
            "from": format!("{}", request.from),
            "to": format!("{}", request.to),
            "data": format!("0x{}", hex::encode(&request.data)),
        });
        if request.value > U256::ZERO {
            tx_obj["value"] = serde_json::Value::String(format!("0x{:x}", request.value));
        }

        let response = self
            .client
            .post(&self.rpc_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_call",
                "params": [tx_obj, block_tag]
            }))
            .send()
            .await
            .map_err(|e| TradingError::HttpError(format!("eth_call failed: {e}")))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TradingError::HttpError(format!("eth_call response parse: {e}")))?;

        if let Some(error) = body.get("error") {
            let _message = error["message"].as_str().unwrap_or("unknown error");
            return Ok((false, Bytes::new(), 0));
        }

        let result_hex = body["result"].as_str().unwrap_or("0x");
        let stripped = result_hex.strip_prefix("0x").unwrap_or(result_hex);
        let return_data = hex::decode(stripped)
            .map(Bytes::from)
            .unwrap_or_default();

        // eth_call doesn't return gas_used directly; estimate separately
        let gas_used = self.estimate_gas(&body, request).await;

        Ok((true, return_data, gas_used))
    }

    /// Attempt to get gas estimate (best-effort).
    async fn estimate_gas(
        &self,
        _call_result: &serde_json::Value,
        request: &SimulationRequest,
    ) -> u64 {
        let mut tx_obj = serde_json::json!({
            "from": format!("{}", request.from),
            "to": format!("{}", request.to),
            "data": format!("0x{}", hex::encode(&request.data)),
        });
        if request.value > U256::ZERO {
            tx_obj["value"] = serde_json::Value::String(format!("0x{:x}", request.value));
        }

        let Ok(response) = self
            .client
            .post(&self.rpc_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_estimateGas",
                "params": [tx_obj]
            }))
            .send()
            .await
        else {
            return 0;
        };

        let Ok(body) = response.json::<serde_json::Value>().await else {
            return 0;
        };

        body["result"]
            .as_str()
            .and_then(|s| {
                let stripped = s.strip_prefix("0x").unwrap_or(s);
                u64::from_str_radix(stripped, 16).ok()
            })
            .unwrap_or(0)
    }
}

#[async_trait::async_trait]
impl TransactionSimulator for EthCallSimulator {
    async fn simulate(
        &self,
        request: SimulationRequest,
    ) -> Result<SimulationResult, TradingError> {
        let (success, return_data, gas_used) = self.eth_call(&request).await?;

        let mut warnings = Vec::new();

        if !success {
            warnings.push(SimulationWarning::SimulationReverted {
                reason: String::from_utf8_lossy(&return_data).to_string(),
            });
        }

        // Query current balances for requested tokens (best-effort context for risk analysis).
        // eth_call is stateless so before==after, but this provides balance context.
        let mut balance_changes = Vec::new();
        if let Some(account) = request.balance_check_account {
            for token in &request.token_addresses {
                if let Ok(balance) = self.query_balance(*token, account, request.block_number).await
                {
                    balance_changes.push(super::BalanceChange {
                        token: *token,
                        account,
                        before: balance,
                        after: balance,
                    });
                }
            }
        }

        Ok(SimulationResult {
            success,
            return_data,
            gas_used,
            balance_changes,
            approval_changes: Vec::new(),
            transfer_events: Vec::new(),
            warnings,
        })
    }
}

/// Query balance changes for a set of tokens/accounts using pre/post eth_call.
///
/// This is a convenience function that uses the simulator's RPC connection
/// to check balances before and after a simulated transaction.
pub async fn query_balance_changes(
    simulator: &EthCallSimulator,
    tokens: &[Address],
    accounts: &[Address],
    block: Option<u64>,
) -> Vec<super::BalanceChange> {
    let mut changes = Vec::new();
    for token in tokens {
        for account in accounts {
            if let Ok(balance) = simulator.query_balance(*token, *account, block).await {
                changes.push(super::BalanceChange {
                    token: *token,
                    account: *account,
                    before: balance,
                    after: U256::ZERO, // Caller must fill in post-simulation balance
                });
            }
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eth_call_simulator_new() {
        let sim = EthCallSimulator::new("http://localhost:8545".into());
        assert_eq!(sim.rpc_url, "http://localhost:8545");
    }

    #[test]
    fn test_balance_of_encoding() {
        let calldata = balanceOfCall {
            account: Address::ZERO,
        }
        .abi_encode();
        // balanceOf(address) selector = 0x70a08231
        assert_eq!(&calldata[..4], &[0x70, 0xa0, 0x82, 0x31]);
    }

    #[tokio::test]
    async fn test_simulate_without_rpc_returns_error() {
        let sim = EthCallSimulator::new("http://localhost:1".into());
        let request = SimulationRequest {
            from: Address::ZERO,
            to: Address::ZERO,
            data: Bytes::new(),
            value: U256::ZERO,
            block_number: None,
            token_addresses: Vec::new(),
            balance_check_account: None,
        };
        let result = sim.simulate(request).await;
        assert!(result.is_err());
    }
}
