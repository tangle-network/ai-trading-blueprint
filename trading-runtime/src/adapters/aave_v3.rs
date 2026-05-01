use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolCall;

use super::{
    ActionParams, DebtReductionPostcondition, EncodedAction, HealthFactorPostcondition,
    ProtocolAdapter, approval, validate_vault_address,
};
use crate::aave_v3_registry::{
    AaveMarket, AaveReserve, market_for_chain, reserve_by_a_token, reserve_by_underlying,
    supported_chain_ids,
};
use crate::error::TradingError;
use crate::types::Action;

sol! {
    interface IPool {
        function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
        function withdraw(address asset, uint256 amount, address to) external returns (uint256);
        function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
        function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    }
}

pub struct AaveV3Adapter {
    chain_id: u64,
    pool_address: Address,
    pool_addresses_provider: Address,
    protocol_data_provider: Address,
}

impl AaveV3Adapter {
    pub fn new() -> Self {
        Self::for_chain(1).expect("ethereum is a supported Aave V3 chain")
    }

    pub fn with_pool(pool_address: Address) -> Self {
        let market = market_for_chain(1).expect("ethereum market exists");
        Self {
            chain_id: 1,
            pool_address,
            pool_addresses_provider: parse_address(market.pool_addresses_provider),
            protocol_data_provider: parse_address(market.protocol_data_provider),
        }
    }

    pub fn for_chain(chain_id: u64) -> Result<Self, TradingError> {
        let market = market_for_chain(chain_id).ok_or_else(|| TradingError::AdapterError {
            protocol: "aave_v3".into(),
            message: format!("Unsupported chain_id for Aave V3: {chain_id}"),
        })?;
        Ok(Self {
            chain_id,
            pool_address: parse_address(market.pool),
            pool_addresses_provider: parse_address(market.pool_addresses_provider),
            protocol_data_provider: parse_address(market.protocol_data_provider),
        })
    }

    fn market(&self) -> &'static AaveMarket {
        market_for_chain(self.chain_id).expect("adapter constructed with supported chain")
    }

    fn reserve_for_underlying(
        &self,
        asset: Address,
        action: &str,
    ) -> Result<&'static AaveReserve, TradingError> {
        let asset = format!("{asset:#x}");
        reserve_by_underlying(self.chain_id, &asset).ok_or_else(|| TradingError::AdapterError {
            protocol: "aave_v3".into(),
            message: format!(
                "Unsupported Aave V3 {action} asset {asset} on {} ({})",
                self.market().name,
                self.chain_id
            ),
        })
    }

    fn reserve_for_withdraw_token(
        &self,
        asset: Address,
    ) -> Result<&'static AaveReserve, TradingError> {
        let asset = format!("{asset:#x}");
        reserve_by_underlying(self.chain_id, &asset)
            .or_else(|| reserve_by_a_token(self.chain_id, &asset))
            .ok_or_else(|| TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!(
                    "Unsupported Aave V3 withdraw token {asset} on {} ({})",
                    self.market().name,
                    self.chain_id
                ),
            })
    }

    fn reserve_for_borrow_token(
        &self,
        asset: Address,
    ) -> Result<&'static AaveReserve, TradingError> {
        let reserve = self.reserve_for_underlying(asset, "borrow")?;
        if !reserve.variable_borrow_enabled {
            return Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!(
                    "Aave V3 borrow is disabled for {} on {} ({})",
                    reserve.symbol,
                    self.market().name,
                    self.chain_id
                ),
            });
        }
        Ok(reserve)
    }

    fn validate_rate_mode(&self, reserve: &AaveReserve, rate_mode: u8) -> Result<u8, TradingError> {
        if rate_mode != 2 {
            return Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!(
                    "Aave V3 {} on {} only supports variable rate_mode 2",
                    reserve.symbol,
                    self.market().name
                ),
            });
        }
        Ok(rate_mode)
    }

    fn health_factor_postcondition(
        &self,
        params: &ActionParams,
    ) -> Result<HealthFactorPostcondition, TradingError> {
        let raw = params
            .extra
            .get("min_aave_health_factor_wad")
            .and_then(|value| value.as_str())
            .unwrap_or("1500000000000000000");
        let min_health_factor =
            U256::from_str_radix(raw, 10).map_err(|e| TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!("Invalid metadata.min_aave_health_factor_wad '{raw}': {e}"),
            })?;
        if min_health_factor == U256::ZERO {
            return Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: "Aave health factor threshold must not be zero".into(),
            });
        }
        Ok(HealthFactorPostcondition {
            pool: self.pool_address,
            account: params.vault_address,
            min_health_factor,
        })
    }

    /// Encode `supply(address,uint256,address,uint16)`.
    fn encode_supply(&self, asset: Address, amount: U256, vault: Address) -> Bytes {
        let call = IPool::supplyCall {
            asset,
            amount,
            onBehalfOf: vault,
            referralCode: 0,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `withdraw(address,uint256,address)`.
    fn encode_withdraw(&self, asset: Address, amount: U256, vault: Address) -> Bytes {
        let call = IPool::withdrawCall {
            asset,
            amount,
            to: vault,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `borrow(address,uint256,uint256,uint16,address)`.
    fn encode_borrow(&self, asset: Address, amount: U256, rate_mode: u8, vault: Address) -> Bytes {
        let call = IPool::borrowCall {
            asset,
            amount,
            interestRateMode: U256::from(rate_mode),
            referralCode: 0,
            onBehalfOf: vault,
        };
        Bytes::from(call.abi_encode())
    }

    /// Encode `repay(address,uint256,uint256,address)`.
    fn encode_repay(&self, asset: Address, amount: U256, rate_mode: u8, vault: Address) -> Bytes {
        let call = IPool::repayCall {
            asset,
            amount,
            interestRateMode: U256::from(rate_mode),
            onBehalfOf: vault,
        };
        Bytes::from(call.abi_encode())
    }

    fn debt_token_from_metadata(
        &self,
        reserve: &AaveReserve,
        params: &ActionParams,
    ) -> Result<Address, TradingError> {
        let raw = params
            .extra
            .get("debt_token")
            .or_else(|| params.extra.get("debtToken"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: "Aave repay requires metadata.debt_token".into(),
            })?;

        let debt_token = raw
            .parse::<Address>()
            .map_err(|e| TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!("Invalid Aave debt token address '{raw}': {e}"),
            })?;
        if debt_token == Address::ZERO {
            return Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: "Aave repay debt_token must not be zero".into(),
            });
        }
        if format!("{debt_token:#x}") != reserve.variable_debt_token.to_ascii_lowercase() {
            return Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!(
                    "Aave repay debt_token must match {} variable debt token on {}",
                    reserve.symbol,
                    self.market().name
                ),
            });
        }

        Ok(debt_token)
    }
}

impl Default for AaveV3Adapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolAdapter for AaveV3Adapter {
    fn protocol_id(&self) -> &str {
        "aave_v3"
    }

    fn supported_chains(&self) -> Vec<u64> {
        supported_chain_ids()
    }

    fn known_addresses(&self) -> Vec<Address> {
        vec![
            self.pool_address,
            self.pool_addresses_provider,
            self.protocol_data_provider,
        ]
    }

    fn encode_action(&self, params: &ActionParams) -> Result<EncodedAction, TradingError> {
        validate_vault_address(params, "aave_v3")?;

        let rate_mode: u8 = params
            .extra
            .get("rate_mode")
            .and_then(|v| v.as_u64())
            .unwrap_or(2) as u8; // Default: variable rate

        match params.action {
            Action::Supply => {
                let reserve = self.reserve_for_underlying(params.token_in, "supply")?;
                let output_token = parse_address(reserve.a_token);
                let calldata =
                    self.encode_supply(params.token_in, params.amount, params.vault_address);
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token,
                    approvals: vec![approval(params.token_in, self.pool_address, params.amount)],
                    debt_reduction: None,
                    health_factor: None,
                })
            }
            Action::Withdraw => {
                let reserve = self.reserve_for_withdraw_token(params.token_in)?;
                let underlying = parse_address(reserve.underlying);
                let calldata =
                    self.encode_withdraw(underlying, params.amount, params.vault_address);
                let health_factor = self.health_factor_postcondition(params)?;
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.min_output,
                    output_token: underlying,
                    approvals: vec![],
                    debt_reduction: None,
                    health_factor: Some(health_factor),
                })
            }
            Action::Borrow => {
                let reserve = self.reserve_for_borrow_token(params.token_out)?;
                let rate_mode = self.validate_rate_mode(reserve, rate_mode)?;
                let calldata = self.encode_borrow(
                    params.token_out,
                    params.amount,
                    rate_mode,
                    params.vault_address,
                );
                let health_factor = self.health_factor_postcondition(params)?;
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: params.amount,
                    output_token: params.token_out,
                    approvals: vec![],
                    debt_reduction: None,
                    health_factor: Some(health_factor),
                })
            }
            Action::Repay => {
                let reserve = self.reserve_for_borrow_token(params.token_in)?;
                let rate_mode = self.validate_rate_mode(reserve, rate_mode)?;
                if params.min_output == U256::ZERO {
                    return Err(TradingError::AdapterError {
                        protocol: "aave_v3".into(),
                        message:
                            "Aave repay requires non-zero min_amount_out as minimum debt decrease"
                                .into(),
                    });
                }
                let debt_token = self.debt_token_from_metadata(reserve, params)?;
                let calldata = self.encode_repay(
                    params.token_in,
                    params.amount,
                    rate_mode,
                    params.vault_address,
                );
                Ok(EncodedAction {
                    target: self.pool_address,
                    calldata,
                    value: U256::ZERO,
                    min_output: U256::ZERO,
                    output_token: params.token_in,
                    approvals: vec![approval(params.token_in, self.pool_address, params.amount)],
                    debt_reduction: Some(DebtReductionPostcondition {
                        input_token: params.token_in,
                        max_input: params.amount,
                        debt_token,
                        min_debt_decrease: params.min_output,
                    }),
                    health_factor: None,
                })
            }
            _ => Err(TradingError::AdapterError {
                protocol: "aave_v3".into(),
                message: format!("Unsupported action: {:?}", params.action),
            }),
        }
    }
}

fn parse_address(value: &str) -> Address {
    value.parse().expect("valid Aave V3 registry address")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aave_v3_registry::reserve_by_symbol;

    const VAULT: &str = "0x0000000000000000000000000000000000000099";

    fn reserve(chain_id: u64, symbol: &str) -> &'static AaveReserve {
        reserve_by_symbol(chain_id, symbol).expect("known Aave reserve")
    }

    #[test]
    fn test_protocol_id() {
        let adapter = AaveV3Adapter::new();
        assert_eq!(adapter.protocol_id(), "aave_v3");
    }

    #[test]
    fn test_encode_supply() {
        let adapter = AaveV3Adapter::new();
        let usdc = reserve(1, "USDC");
        let params = ActionParams {
            action: Action::Supply,
            token_in: usdc.underlying.parse().unwrap(),
            token_out: usdc.underlying.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(999_999u64),
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, adapter.pool_address);
        assert!(result.calldata.len() > 4);
        assert_eq!(result.approvals.len(), 1);
        assert_eq!(
            result.output_token,
            usdc.a_token.parse::<Address>().unwrap()
        );
        assert_eq!(result.min_output, U256::from(999_999u64));
    }

    #[test]
    fn test_encode_borrow() {
        let adapter = AaveV3Adapter::new();
        let weth = reserve(1, "WETH");
        let usdc = reserve(1, "USDC");
        let params = ActionParams {
            action: Action::Borrow,
            token_in: weth.underlying.parse().unwrap(),
            token_out: usdc.underlying.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(500_000u64),
            extra: serde_json::json!({"rate_mode": 2}),
            vault_address: VAULT.parse().unwrap(),
        };
        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(result.target, adapter.pool_address);
    }

    #[test]
    fn test_encode_repay_uses_debt_reduction_postcondition() {
        let adapter = AaveV3Adapter::new();
        let usdc = reserve(1, "USDC");
        let debt_token: Address = usdc.variable_debt_token.parse().unwrap();
        let params = ActionParams {
            action: Action::Repay,
            token_in: usdc.underlying.parse().unwrap(),
            token_out: usdc.underlying.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(499_000u64),
            extra: serde_json::json!({"rate_mode": 2, "debt_token": format!("{debt_token}")}),
            vault_address: VAULT.parse().unwrap(),
        };

        let result = adapter.encode_action(&params).unwrap();
        let debt_reduction = result
            .debt_reduction
            .expect("repay should use debt decrease postcondition");
        assert_eq!(result.min_output, U256::ZERO);
        assert_eq!(
            debt_reduction.input_token,
            usdc.underlying.parse::<Address>().unwrap()
        );
        assert_eq!(debt_reduction.max_input, U256::from(500_000u64));
        assert_eq!(debt_reduction.debt_token, debt_token);
        assert_eq!(debt_reduction.min_debt_decrease, U256::from(499_000u64));
    }

    #[test]
    fn test_encode_repay_requires_debt_token() {
        let adapter = AaveV3Adapter::new();
        let usdc = reserve(1, "USDC");
        let params = ActionParams {
            action: Action::Repay,
            token_in: usdc.underlying.parse().unwrap(),
            token_out: usdc.underlying.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(499_000u64),
            extra: serde_json::json!({"rate_mode": 2}),
            vault_address: VAULT.parse().unwrap(),
        };

        let err = adapter.encode_action(&params).unwrap_err();
        assert!(
            err.to_string().contains("metadata.debt_token"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn test_for_chain_uses_ethereum_pool() {
        let adapter = AaveV3Adapter::for_chain(1).unwrap();
        assert_eq!(adapter.known_addresses()[0], adapter.pool_address);
    }

    #[test]
    fn test_for_chain_uses_shared_l2_pool() {
        let adapter = AaveV3Adapter::for_chain(42161).unwrap();
        assert_eq!(
            adapter.known_addresses()[0],
            "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
                .parse::<Address>()
                .unwrap()
        );
    }

    #[test]
    fn test_for_chain_uses_base_pool() {
        let adapter = AaveV3Adapter::for_chain(8453).unwrap();
        assert_eq!(
            adapter.known_addresses()[0],
            "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"
                .parse::<Address>()
                .unwrap()
        );
    }

    #[test]
    fn test_encode_supply_on_all_supported_chains() {
        for chain_id in [1, 8453, 42161, 137, 10, 43114] {
            let adapter = AaveV3Adapter::for_chain(chain_id).unwrap();
            let reserve = reserve_by_symbol(chain_id, "USDC")
                .or_else(|| reserve_by_symbol(chain_id, "WAVAX"))
                .expect("chain has a supported reserve");
            let params = ActionParams {
                action: Action::Supply,
                token_in: reserve.underlying.parse().unwrap(),
                token_out: reserve.underlying.parse().unwrap(),
                amount: U256::from(1_000_000u64),
                min_output: U256::from(1u64),
                extra: serde_json::Value::Null,
                vault_address: VAULT.parse().unwrap(),
            };

            let result = adapter.encode_action(&params).unwrap();
            assert_eq!(
                result.output_token,
                reserve.a_token.parse::<Address>().unwrap()
            );
        }
    }

    #[test]
    fn test_supply_rejects_wrong_chain_asset() {
        let adapter = AaveV3Adapter::for_chain(8453).unwrap();
        let mainnet_usdc = reserve(1, "USDC");
        let params = ActionParams {
            action: Action::Supply,
            token_in: mainnet_usdc.underlying.parse().unwrap(),
            token_out: mainnet_usdc.underlying.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(1u64),
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };

        let err = adapter.encode_action(&params).unwrap_err();
        assert!(err.to_string().contains("Unsupported Aave V3 supply asset"));
    }

    #[test]
    fn test_withdraw_accepts_a_token_and_outputs_underlying() {
        let adapter = AaveV3Adapter::for_chain(8453).unwrap();
        let usdc = reserve(8453, "USDC");
        let params = ActionParams {
            action: Action::Withdraw,
            token_in: usdc.a_token.parse().unwrap(),
            token_out: usdc.underlying.parse().unwrap(),
            amount: U256::from(1_000_000u64),
            min_output: U256::from(1u64),
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };

        let result = adapter.encode_action(&params).unwrap();
        assert_eq!(
            result.output_token,
            usdc.underlying.parse::<Address>().unwrap()
        );
    }

    #[test]
    fn test_repay_rejects_mismatched_debt_token() {
        let adapter = AaveV3Adapter::new();
        let usdc = reserve(1, "USDC");
        let weth = reserve(1, "WETH");
        let params = ActionParams {
            action: Action::Repay,
            token_in: usdc.underlying.parse().unwrap(),
            token_out: usdc.underlying.parse().unwrap(),
            amount: U256::from(500_000u64),
            min_output: U256::from(499_000u64),
            extra: serde_json::json!({"rate_mode": 2, "debt_token": weth.variable_debt_token}),
            vault_address: VAULT.parse().unwrap(),
        };

        let err = adapter.encode_action(&params).unwrap_err();
        assert!(err.to_string().contains("debt_token must match"));
    }

    #[test]
    fn test_for_chain_rejects_unknown_chain() {
        let err = AaveV3Adapter::for_chain(31337)
            .err()
            .expect("should reject unsupported chain");
        assert!(err.to_string().contains("Unsupported chain_id"), "{err}");
    }

    #[test]
    fn test_for_chain_rejects_synthetic_fork_chain() {
        let err = AaveV3Adapter::for_chain(31339)
            .err()
            .expect("synthetic fork ids should be normalized before adapter lookup");
        assert!(err.to_string().contains("Unsupported chain_id"), "{err}");
    }

    #[test]
    fn test_unsupported_action() {
        let adapter = AaveV3Adapter::new();
        let usdc = reserve(1, "USDC");
        let weth = reserve(1, "WETH");
        let params = ActionParams {
            action: Action::Swap,
            token_in: usdc.underlying.parse().unwrap(),
            token_out: weth.underlying.parse().unwrap(),
            amount: U256::from(100u64),
            min_output: U256::ZERO,
            extra: serde_json::Value::Null,
            vault_address: VAULT.parse().unwrap(),
        };
        assert!(adapter.encode_action(&params).is_err());
    }
}
