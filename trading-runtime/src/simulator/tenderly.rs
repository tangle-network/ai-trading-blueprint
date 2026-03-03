//! TenderlySimulator — rich simulation via Tenderly Simulation API.
//!
//! When `TENDERLY_API_KEY`, `TENDERLY_ACCOUNT`, and `TENDERLY_PROJECT` are set,
//! this backend provides full execution traces, state diffs, and token transfer
//! detection. Falls back to EthCallSimulator on API failure.

use alloy::primitives::{Address, Bytes, U256};

use super::eth_call::EthCallSimulator;
use super::{
    APPROVAL_TOPIC, ApprovalChange, BalanceChange, SimulationRequest, SimulationResult,
    SimulationWarning, TRANSFER_TOPIC, TransactionSimulator, TransferEvent,
};
use crate::error::TradingError;

/// Simulator backend using the Tenderly Simulation API.
pub struct TenderlySimulator {
    api_key: String,
    account: String,
    project: String,
    chain_id: u64,
    client: reqwest::Client,
    fallback: EthCallSimulator,
}

impl TenderlySimulator {
    pub fn new(
        api_key: String,
        account: String,
        project: String,
        rpc_url: String,
        chain_id: u64,
    ) -> Self {
        Self {
            api_key,
            account,
            project,
            chain_id,
            client: reqwest::Client::new(),
            fallback: EthCallSimulator::new(rpc_url),
        }
    }

    fn api_url(&self) -> String {
        format!(
            "https://api.tenderly.co/api/v1/account/{}/project/{}/simulate",
            self.account, self.project
        )
    }

    async fn tenderly_simulate(
        &self,
        request: &SimulationRequest,
    ) -> Result<SimulationResult, TradingError> {
        let mut body = serde_json::json!({
            "network_id": format!("{}", self.chain_id),
            "from": format!("{}", request.from),
            "to": format!("{}", request.to),
            "input": format!("0x{}", hex::encode(&request.data)),
            "gas": 8_000_000,
            "gas_price": "0",
            "save": false,
            "save_if_fails": false,
            "simulation_type": "full",
            "generate_access_list": false,
        });

        if request.value > U256::ZERO {
            body["value"] = serde_json::Value::String(format!("{}", request.value));
        }

        if let Some(block) = request.block_number {
            body["block_number"] = serde_json::Value::Number(block.into());
        }

        let response = self
            .client
            .post(self.api_url())
            .header("X-Access-Key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| TradingError::HttpError(format!("Tenderly API call failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(TradingError::HttpError(format!(
                "Tenderly API returned {status}: {body}"
            )));
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TradingError::HttpError(format!("Tenderly response parse: {e}")))?;

        self.parse_tenderly_response(&result)
    }

    fn parse_tenderly_response(
        &self,
        response: &serde_json::Value,
    ) -> Result<SimulationResult, TradingError> {
        let transaction = &response["transaction"];
        let tx_info = &transaction["transaction_info"];

        let success = transaction["status"].as_bool().unwrap_or(false);

        let gas_used = tx_info["gas_used"].as_u64().unwrap_or(0);

        let return_data_hex = tx_info["call_trace"]["output"].as_str().unwrap_or("0x");
        let stripped = return_data_hex
            .strip_prefix("0x")
            .unwrap_or(return_data_hex);
        let return_data = hex::decode(stripped).map(Bytes::from).unwrap_or_default();

        let mut warnings = Vec::new();
        let mut balance_changes = Vec::new();
        let mut approval_changes = Vec::new();
        let mut transfer_events = Vec::new();

        if !success {
            let revert_reason = tx_info["call_trace"]["error"]
                .as_str()
                .unwrap_or("unknown revert");
            warnings.push(SimulationWarning::SimulationReverted {
                reason: revert_reason.to_string(),
            });
        }

        // Parse logs for Transfer and Approval events
        if let Some(logs) = tx_info["logs"].as_array() {
            for log in logs {
                let topics: Vec<&str> = log["raw"]["topics"]
                    .as_array()
                    .map(|arr| arr.iter().filter_map(|t| t.as_str()).collect())
                    .unwrap_or_default();

                if topics.is_empty() {
                    continue;
                }

                let topic0 = topics[0].strip_prefix("0x").unwrap_or(topics[0]);

                let log_address = log["raw"]["address"]
                    .as_str()
                    .and_then(|s| s.parse::<Address>().ok())
                    .unwrap_or(Address::ZERO);

                if topic0 == TRANSFER_TOPIC && topics.len() >= 3 {
                    let from = parse_topic_address(topics[1]);
                    let to = parse_topic_address(topics[2]);
                    let amount = parse_log_data_u256(log["raw"]["data"].as_str().unwrap_or("0x0"));
                    transfer_events.push(TransferEvent {
                        token: log_address,
                        from,
                        to,
                        amount,
                    });
                } else if topic0 == APPROVAL_TOPIC && topics.len() >= 3 {
                    let owner = parse_topic_address(topics[1]);
                    let spender = parse_topic_address(topics[2]);
                    let amount = parse_log_data_u256(log["raw"]["data"].as_str().unwrap_or("0x0"));
                    approval_changes.push(ApprovalChange {
                        token: log_address,
                        owner,
                        spender,
                        amount,
                    });
                }
            }
        }

        // Parse state diffs for balance changes
        if let Some(state_diffs) = tx_info["state_diff"].as_array() {
            for diff in state_diffs {
                let address = diff["address"]
                    .as_str()
                    .and_then(|s| s.parse::<Address>().ok());
                if let (Some(addr), Some(raw)) = (address, diff["raw"].as_array()) {
                    for entry in raw {
                        if let (Some(before), Some(after)) =
                            (entry["original"].as_str(), entry["dirty"].as_str())
                        {
                            let before_val = parse_hex_u256(before);
                            let after_val = parse_hex_u256(after);
                            if before_val != after_val {
                                balance_changes.push(BalanceChange {
                                    token: addr,
                                    account: Address::ZERO, // Tenderly state diffs don't directly map to accounts
                                    before: before_val,
                                    after: after_val,
                                });
                            }
                        }
                    }
                }
            }
        }

        Ok(SimulationResult {
            success,
            return_data,
            gas_used,
            balance_changes,
            approval_changes,
            transfer_events,
            warnings,
        })
    }
}

fn parse_topic_address(topic: &str) -> Address {
    let stripped = topic.strip_prefix("0x").unwrap_or(topic);
    // Topics are 32 bytes; address is last 20 bytes
    if stripped.len() >= 40 {
        let addr_hex = &stripped[stripped.len() - 40..];
        addr_hex.parse().unwrap_or(Address::ZERO)
    } else {
        Address::ZERO
    }
}

fn parse_log_data_u256(data: &str) -> U256 {
    let stripped = data.strip_prefix("0x").unwrap_or(data);
    U256::from_str_radix(stripped, 16).unwrap_or(U256::ZERO)
}

fn parse_hex_u256(s: &str) -> U256 {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    U256::from_str_radix(stripped, 16).unwrap_or(U256::ZERO)
}

#[async_trait::async_trait]
impl TransactionSimulator for TenderlySimulator {
    async fn simulate(&self, request: SimulationRequest) -> Result<SimulationResult, TradingError> {
        match self.tenderly_simulate(&request).await {
            Ok(result) => Ok(result),
            Err(e) => {
                tracing::warn!("Tenderly simulation failed, falling back to eth_call: {e}");
                self.fallback.simulate(request).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_topic_address() {
        let topic = "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678";
        let addr = parse_topic_address(topic);
        assert_ne!(addr, Address::ZERO);
    }

    #[test]
    fn test_parse_topic_address_short() {
        let addr = parse_topic_address("0x0");
        assert_eq!(addr, Address::ZERO);
    }

    #[test]
    fn test_parse_log_data_u256() {
        let data = "0x0000000000000000000000000000000000000000000000000000000000000064";
        let amount = parse_log_data_u256(data);
        assert_eq!(amount, U256::from(100u64));
    }

    #[test]
    fn test_parse_hex_u256() {
        assert_eq!(parse_hex_u256("0x64"), U256::from(100u64));
        assert_eq!(parse_hex_u256("0x0"), U256::ZERO);
    }

    #[test]
    fn test_tenderly_simulator_api_url() {
        let sim = TenderlySimulator::new(
            "key".into(),
            "myaccount".into(),
            "myproject".into(),
            "http://localhost:8545".into(),
            1,
        );
        assert_eq!(
            sim.api_url(),
            "https://api.tenderly.co/api/v1/account/myaccount/project/myproject/simulate"
        );
    }

    #[test]
    fn test_parse_tenderly_success_response() {
        let sim = TenderlySimulator::new(
            "key".into(),
            "acc".into(),
            "proj".into(),
            "http://localhost:8545".into(),
            1,
        );
        let response = serde_json::json!({
            "transaction": {
                "status": true,
                "transaction_info": {
                    "gas_used": 50000,
                    "call_trace": {
                        "output": "0xabcd",
                        "error": null
                    },
                    "logs": [],
                    "state_diff": []
                }
            }
        });

        let result = sim.parse_tenderly_response(&response).unwrap();
        assert!(result.success);
        assert_eq!(result.gas_used, 50000);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_parse_tenderly_revert_response() {
        let sim = TenderlySimulator::new(
            "key".into(),
            "acc".into(),
            "proj".into(),
            "http://localhost:8545".into(),
            1,
        );
        let response = serde_json::json!({
            "transaction": {
                "status": false,
                "transaction_info": {
                    "gas_used": 21000,
                    "call_trace": {
                        "output": "0x",
                        "error": "execution reverted"
                    },
                    "logs": [],
                    "state_diff": []
                }
            }
        });

        let result = sim.parse_tenderly_response(&response).unwrap();
        assert!(!result.success);
        assert_eq!(result.warnings.len(), 1);
        assert!(
            matches!(&result.warnings[0], SimulationWarning::SimulationReverted { reason } if reason == "execution reverted")
        );
    }

    #[test]
    fn test_parse_tenderly_with_transfer_log() {
        let sim = TenderlySimulator::new(
            "key".into(),
            "acc".into(),
            "proj".into(),
            "http://localhost:8545".into(),
            1,
        );
        let response = serde_json::json!({
            "transaction": {
                "status": true,
                "transaction_info": {
                    "gas_used": 100000,
                    "call_trace": { "output": "0x" },
                    "logs": [
                        {
                            "raw": {
                                "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                                "topics": [
                                    format!("0x{}", super::TRANSFER_TOPIC),
                                    "0x0000000000000000000000001111111111111111111111111111111111111111",
                                    "0x0000000000000000000000002222222222222222222222222222222222222222"
                                ],
                                "data": "0x0000000000000000000000000000000000000000000000000000000000000064"
                            }
                        }
                    ],
                    "state_diff": []
                }
            }
        });

        let result = sim.parse_tenderly_response(&response).unwrap();
        assert!(result.success);
        assert_eq!(result.transfer_events.len(), 1);
        assert_eq!(result.transfer_events[0].amount, U256::from(100u64));
    }
}
