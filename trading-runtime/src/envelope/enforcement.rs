//! Per-protocol on-chain enforcement bindings.
//!
//! Each variant pins a SignedEnvelope to one specific (protocol, action) shape.
//! The struct_hash is mixed into the envelope digest and verified on-chain by
//! the corresponding `execute*Envelope` function in `TradingVault`. This is the
//! mechanism that lets a vault authorize a per-envelope trade without per-trade
//! validator signatures.
//!
//! When you add a new variant here, you must also add:
//!   - matching `struct` + `TYPEHASH` constant in `contracts/src/TradeValidator.sol`
//!   - matching `executeXxxEnvelope` in `contracts/src/TradingVault.sol`
//!   - matching `encode_execute_xxx_envelope` in `trading-runtime/src/vault_client.rs`
//!   - matching `execute_xxx_envelope_trade` in `trading-runtime/src/executor.rs`

use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::sol_types::SolValue;
use serde::{Deserialize, Serialize};

use super::error::EnvelopeError;

// ── EIP-712 type strings (canonical, alphabetical fields per EIP-712 spec) ──

pub(super) const UNISWAP_V3_SWAP_TYPE: &str = "UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut)";

pub(super) const AERODROME_SWAP_TYPE: &str = "AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut)";

pub(super) const AAVE_SUPPLY_TYPE: &str = "AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,address pool)";

pub(super) const AAVE_WITHDRAW_TYPE: &str = "AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 minHealthFactor,address pool)";

pub(super) const AAVE_BORROW_TYPE: &str = "AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 minHealthFactor,address pool)";

pub(super) const AAVE_REPAY_TYPE: &str = "AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,address pool)";

pub(super) const MORPHO_SUPPLY_TYPE: &str = "MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,address morpho)";

pub(super) const MORPHO_WITHDRAW_TYPE: &str = "MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,uint256 minCollateralRatio,address morpho)";

pub(super) const MORPHO_BORROW_TYPE: &str = "MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,uint256 minCollateralRatio,address morpho)";

pub(super) const MORPHO_REPAY_TYPE: &str = "MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,address morpho)";

// ── Per-protocol-per-action enforcement types ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UniswapV3SwapEnforcement {
    pub router: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub fee_tier: u32,
    pub max_single_amount_in: U256,
    pub max_total_amount_in: U256,
    /// Minimum output amount per 1e18 input units (anti-MEV / anti-bad-routing).
    pub min_output_per_input: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AerodromeSwapEnforcement {
    pub router: Address,
    pub token_in: Address,
    pub token_out: Address,
    /// Aerodrome Slipstream uses signed tickSpacing instead of fee tiers.
    pub tick_spacing: i32,
    pub max_single_amount_in: U256,
    pub max_total_amount_in: U256,
    pub min_output_per_input: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AaveSupplyEnforcement {
    pub pool: Address,
    pub asset: Address,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AaveWithdrawEnforcement {
    pub pool: Address,
    pub asset: Address,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
    /// Aave-style health factor (1e18-scaled). Trade reverts if post-withdraw HF < this.
    pub min_health_factor: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AaveBorrowEnforcement {
    pub pool: Address,
    pub asset: Address,
    /// 1 = stable rate, 2 = variable rate (Aave V3 convention).
    pub interest_rate_mode: u8,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
    pub min_health_factor: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AaveRepayEnforcement {
    pub pool: Address,
    pub asset: Address,
    /// Debt token address — bound on-chain to prevent paying down the wrong loan.
    pub debt_token: Address,
    pub interest_rate_mode: u8,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MorphoSupplyEnforcement {
    pub morpho: Address,
    pub market_id: B256,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MorphoWithdrawEnforcement {
    pub morpho: Address,
    pub market_id: B256,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
    /// Morpho collateral / borrow ratio (1e18-scaled).
    pub min_collateral_ratio: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MorphoBorrowEnforcement {
    pub morpho: Address,
    pub market_id: B256,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
    pub min_collateral_ratio: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MorphoRepayEnforcement {
    pub morpho: Address,
    pub market_id: B256,
    pub max_single_amount: U256,
    pub max_total_amount: U256,
}

/// On-chain enforcement binding. Pins an envelope to a specific (protocol, action)
/// trade shape with concrete amount caps and routing parameters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnvelopeEnforcement {
    UniswapV3Swap(UniswapV3SwapEnforcement),
    AerodromeSwap(AerodromeSwapEnforcement),
    AaveSupply(AaveSupplyEnforcement),
    AaveWithdraw(AaveWithdrawEnforcement),
    AaveBorrow(AaveBorrowEnforcement),
    AaveRepay(AaveRepayEnforcement),
    MorphoSupply(MorphoSupplyEnforcement),
    MorphoWithdraw(MorphoWithdrawEnforcement),
    MorphoBorrow(MorphoBorrowEnforcement),
    MorphoRepay(MorphoRepayEnforcement),
}

impl EnvelopeEnforcement {
    /// Compute the EIP-712 struct hash for this enforcement binding.
    /// Result must match the on-chain `_hashEnforcement` for the matching Solidity struct.
    pub fn struct_hash(&self) -> Result<B256, EnvelopeError> {
        Ok(match self {
            Self::UniswapV3Swap(e) => e.struct_hash(),
            Self::AerodromeSwap(e) => e.struct_hash(),
            Self::AaveSupply(e) => e.struct_hash(),
            Self::AaveWithdraw(e) => e.struct_hash(),
            Self::AaveBorrow(e) => e.struct_hash(),
            Self::AaveRepay(e) => e.struct_hash(),
            Self::MorphoSupply(e) => e.struct_hash(),
            Self::MorphoWithdraw(e) => e.struct_hash(),
            Self::MorphoBorrow(e) => e.struct_hash(),
            Self::MorphoRepay(e) => e.struct_hash(),
        })
    }

    /// String identifier matching the envelope's outer `protocol` field for routing.
    pub fn protocol_id(&self) -> &'static str {
        match self {
            Self::UniswapV3Swap(_) => "uniswap_v3",
            Self::AerodromeSwap(_) => "aerodrome",
            Self::AaveSupply(_)
            | Self::AaveWithdraw(_)
            | Self::AaveBorrow(_)
            | Self::AaveRepay(_) => "aave_v3",
            Self::MorphoSupply(_)
            | Self::MorphoWithdraw(_)
            | Self::MorphoBorrow(_)
            | Self::MorphoRepay(_) => "morpho",
        }
    }

    /// Action identifier (open/close/long/swap/etc).
    pub fn action(&self) -> &'static str {
        match self {
            Self::UniswapV3Swap(_) | Self::AerodromeSwap(_) => "swap",
            Self::AaveSupply(_) | Self::MorphoSupply(_) => "supply",
            Self::AaveWithdraw(_) | Self::MorphoWithdraw(_) => "withdraw",
            Self::AaveBorrow(_) | Self::MorphoBorrow(_) => "borrow",
            Self::AaveRepay(_) | Self::MorphoRepay(_) => "repay",
        }
    }

    /// Validate that internal amount caps are coherent.
    pub fn validate(&self) -> Result<(), EnvelopeError> {
        let (single, total) = match self {
            Self::UniswapV3Swap(e) => (e.max_single_amount_in, e.max_total_amount_in),
            Self::AerodromeSwap(e) => (e.max_single_amount_in, e.max_total_amount_in),
            Self::AaveSupply(e) => (e.max_single_amount, e.max_total_amount),
            Self::AaveWithdraw(e) => (e.max_single_amount, e.max_total_amount),
            Self::AaveBorrow(e) => (e.max_single_amount, e.max_total_amount),
            Self::AaveRepay(e) => (e.max_single_amount, e.max_total_amount),
            Self::MorphoSupply(e) => (e.max_single_amount, e.max_total_amount),
            Self::MorphoWithdraw(e) => (e.max_single_amount, e.max_total_amount),
            Self::MorphoBorrow(e) => (e.max_single_amount, e.max_total_amount),
            Self::MorphoRepay(e) => (e.max_single_amount, e.max_total_amount),
        };
        if single == U256::ZERO {
            return Err(EnvelopeError::InvalidEnforcementAmount {
                reason: "max_single_amount must be > 0".into(),
            });
        }
        if total == U256::ZERO {
            return Err(EnvelopeError::InvalidEnforcementAmount {
                reason: "max_total_amount must be > 0".into(),
            });
        }
        if single > total {
            return Err(EnvelopeError::InvalidEnforcementAmount {
                reason: "max_single_amount must be <= max_total_amount".into(),
            });
        }
        match self {
            Self::AaveBorrow(e) if e.interest_rate_mode != 1 && e.interest_rate_mode != 2 => {
                Err(EnvelopeError::InvalidEnforcementAmount {
                    reason: "Aave interest_rate_mode must be 1 or 2".into(),
                })
            }
            Self::AaveRepay(e) if e.interest_rate_mode != 1 && e.interest_rate_mode != 2 => {
                Err(EnvelopeError::InvalidEnforcementAmount {
                    reason: "Aave interest_rate_mode must be 1 or 2".into(),
                })
            }
            _ => Ok(()),
        }
    }
}

// ── Per-struct hash implementations ──

impl UniswapV3SwapEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(UNISWAP_V3_SWAP_TYPE.as_bytes()),
            U256::from(self.fee_tier),
            self.max_single_amount_in,
            self.max_total_amount_in,
            self.min_output_per_input,
            self.router,
            self.token_in,
            self.token_out,
        )))
    }
}

impl AerodromeSwapEnforcement {
    pub fn struct_hash(&self) -> B256 {
        // i32 → I256 sign-extended via U256 two's complement
        let tick = if self.tick_spacing >= 0 {
            U256::from(self.tick_spacing as u64)
        } else {
            U256::ZERO.wrapping_sub(U256::from(self.tick_spacing.unsigned_abs() as u64))
        };
        keccak256(SolValue::abi_encode(&(
            keccak256(AERODROME_SWAP_TYPE.as_bytes()),
            self.max_single_amount_in,
            self.max_total_amount_in,
            self.min_output_per_input,
            self.router,
            tick,
            self.token_in,
            self.token_out,
        )))
    }
}

impl AaveSupplyEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(AAVE_SUPPLY_TYPE.as_bytes()),
            self.asset,
            self.max_single_amount,
            self.max_total_amount,
            self.pool,
        )))
    }
}

impl AaveWithdrawEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(AAVE_WITHDRAW_TYPE.as_bytes()),
            self.asset,
            self.max_single_amount,
            self.max_total_amount,
            self.min_health_factor,
            self.pool,
        )))
    }
}

impl AaveBorrowEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(AAVE_BORROW_TYPE.as_bytes()),
            self.asset,
            U256::from(self.interest_rate_mode),
            self.max_single_amount,
            self.max_total_amount,
            self.min_health_factor,
            self.pool,
        )))
    }
}

impl AaveRepayEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(AAVE_REPAY_TYPE.as_bytes()),
            self.asset,
            self.debt_token,
            U256::from(self.interest_rate_mode),
            self.max_single_amount,
            self.max_total_amount,
            self.pool,
        )))
    }
}

impl MorphoSupplyEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(MORPHO_SUPPLY_TYPE.as_bytes()),
            self.max_single_amount,
            self.max_total_amount,
            self.market_id,
            self.morpho,
        )))
    }
}

impl MorphoWithdrawEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(MORPHO_WITHDRAW_TYPE.as_bytes()),
            self.max_single_amount,
            self.max_total_amount,
            self.market_id,
            self.min_collateral_ratio,
            self.morpho,
        )))
    }
}

impl MorphoBorrowEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(MORPHO_BORROW_TYPE.as_bytes()),
            self.max_single_amount,
            self.max_total_amount,
            self.market_id,
            self.min_collateral_ratio,
            self.morpho,
        )))
    }
}

impl MorphoRepayEnforcement {
    pub fn struct_hash(&self) -> B256 {
        keccak256(SolValue::abi_encode(&(
            keccak256(MORPHO_REPAY_TYPE.as_bytes()),
            self.max_single_amount,
            self.max_total_amount,
            self.market_id,
            self.morpho,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn addr(s: &str) -> Address {
        Address::from_str(s).unwrap()
    }

    fn sample_uniswap() -> EnvelopeEnforcement {
        EnvelopeEnforcement::UniswapV3Swap(UniswapV3SwapEnforcement {
            router: addr("0xE592427A0AEce92De3Edee1F18E0157C05861564"),
            token_in: addr("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
            token_out: addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            fee_tier: 3000,
            max_single_amount_in: U256::from(1_000_000_000_000_000_000u128),
            max_total_amount_in: U256::from(10_000_000_000_000_000_000u128),
            min_output_per_input: U256::from(2_900_000_000u128),
        })
    }

    #[test]
    fn struct_hash_is_deterministic() {
        let e = sample_uniswap();
        assert_eq!(e.struct_hash().unwrap(), e.struct_hash().unwrap());
    }

    #[test]
    fn distinct_variants_produce_distinct_hashes() {
        let uni = sample_uniswap();
        let aero = EnvelopeEnforcement::AerodromeSwap(AerodromeSwapEnforcement {
            router: addr("0xE592427A0AEce92De3Edee1F18E0157C05861564"),
            token_in: addr("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
            token_out: addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            tick_spacing: 60,
            max_single_amount_in: U256::from(1_000_000_000_000_000_000u128),
            max_total_amount_in: U256::from(10_000_000_000_000_000_000u128),
            min_output_per_input: U256::from(2_900_000_000u128),
        });
        assert_ne!(uni.struct_hash().unwrap(), aero.struct_hash().unwrap());
    }

    #[test]
    fn protocol_id_matches_envelope_routing() {
        let uni = sample_uniswap();
        assert_eq!(uni.protocol_id(), "uniswap_v3");
        assert_eq!(uni.action(), "swap");

        let aave_supply = EnvelopeEnforcement::AaveSupply(AaveSupplyEnforcement {
            pool: addr("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"),
            asset: addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            max_single_amount: U256::from(1_000_000_000u128),
            max_total_amount: U256::from(10_000_000_000u128),
        });
        assert_eq!(aave_supply.protocol_id(), "aave_v3");
        assert_eq!(aave_supply.action(), "supply");

        let morpho_borrow = EnvelopeEnforcement::MorphoBorrow(MorphoBorrowEnforcement {
            morpho: addr("0xBBBBBBBBBB9cC5e90e3b3Af64bdAF62C37EEFFFb"),
            market_id: B256::ZERO,
            max_single_amount: U256::from(1u64),
            max_total_amount: U256::from(2u64),
            min_collateral_ratio: U256::from(0u64),
        });
        assert_eq!(morpho_borrow.protocol_id(), "morpho");
        assert_eq!(morpho_borrow.action(), "borrow");
    }

    #[test]
    fn validate_rejects_zero_single_amount() {
        let mut e = match sample_uniswap() {
            EnvelopeEnforcement::UniswapV3Swap(s) => s,
            _ => unreachable!(),
        };
        e.max_single_amount_in = U256::ZERO;
        let err = EnvelopeEnforcement::UniswapV3Swap(e)
            .validate()
            .unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::InvalidEnforcementAmount { .. }
        ));
    }

    #[test]
    fn validate_rejects_single_above_total() {
        let mut e = match sample_uniswap() {
            EnvelopeEnforcement::UniswapV3Swap(s) => s,
            _ => unreachable!(),
        };
        e.max_single_amount_in = U256::from(20_000_000_000_000_000_000u128);
        e.max_total_amount_in = U256::from(10_000_000_000_000_000_000u128);
        let err = EnvelopeEnforcement::UniswapV3Swap(e)
            .validate()
            .unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::InvalidEnforcementAmount { .. }
        ));
    }

    #[test]
    fn validate_rejects_invalid_aave_rate_mode() {
        let e = EnvelopeEnforcement::AaveBorrow(AaveBorrowEnforcement {
            pool: addr("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"),
            asset: addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            interest_rate_mode: 3,
            max_single_amount: U256::from(1u64),
            max_total_amount: U256::from(2u64),
            min_health_factor: U256::from(1_000_000_000_000_000_000u128),
        });
        let err = e.validate().unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::InvalidEnforcementAmount { .. }
        ));
    }

    #[test]
    fn aerodrome_negative_tick_spacing_round_trips() {
        let neg = AerodromeSwapEnforcement {
            router: addr("0xE592427A0AEce92De3Edee1F18E0157C05861564"),
            token_in: addr("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
            token_out: addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            tick_spacing: -100,
            max_single_amount_in: U256::from(1u64),
            max_total_amount_in: U256::from(2u64),
            min_output_per_input: U256::from(1u64),
        };
        let pos = AerodromeSwapEnforcement {
            tick_spacing: 100,
            ..neg.clone()
        };
        assert_ne!(neg.struct_hash(), pos.struct_hash());
    }

    #[test]
    fn each_field_change_alters_struct_hash() {
        let base = match sample_uniswap() {
            EnvelopeEnforcement::UniswapV3Swap(s) => s,
            _ => unreachable!(),
        };
        let h0 = base.struct_hash();

        let mut a = base.clone();
        a.fee_tier = 500;
        assert_ne!(h0, a.struct_hash());

        let mut b = base.clone();
        b.max_single_amount_in = U256::from(1u64);
        assert_ne!(h0, b.struct_hash());

        let mut c = base.clone();
        c.token_in = addr("0xdAC17F958D2ee523a2206206994597C13D831ec7");
        assert_ne!(h0, c.struct_hash());

        let mut d = base.clone();
        d.min_output_per_input = U256::from(1u64);
        assert_ne!(h0, d.struct_hash());
    }
}
