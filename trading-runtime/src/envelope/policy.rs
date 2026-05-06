use alloy::primitives::{B256, U256, keccak256};
use alloy::sol_types::SolValue;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};

use super::error::EnvelopeError;

// EIP-712 type strings — reference hash commits this API forever.
// Sub-policy type strings must be included (in alphabetical order) when used in a type referencing them.
pub(super) const TRADING_POLICY_TYPE: &str = "TradingPolicy(uint256 canOpenPositions,bytes32 clobPolicy,uint256 maxDrawdownBps,uint256 maxTotalExposureCents,uint256 maxTradeSizeCents,bytes32 perpsPolicy,bytes32 vaultPolicy)";
pub(super) const PERPS_POLICY_TYPE: &str = "PerpsPolicy(bytes32 allowedAssetsHash,uint256 maxLeverage,uint256 maxStopLossDistanceBps,uint256 minStopLossDistanceBps,uint256 requireStopLoss)";
pub(super) const VAULT_POLICY_TYPE: &str = "VaultPolicy(bytes32 allowedProtocolsHash,bytes32 allowedTokensInHash,bytes32 allowedTokensOutHash,uint256 maxSlippageBps)";
pub(super) const CLOB_POLICY_TYPE: &str =
    "ClobPolicy(bytes32 allowedMarketIdsHash,uint256 maxPositionSizeCents)";

/// Universal trading risk bounds applied to every trade regardless of protocol.
/// Sub-policies add protocol-specific constraints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TradingPolicy {
    /// Maximum per-trade notional in USD
    pub max_trade_size_usd: Decimal,
    /// Maximum sum of all open-position notionals in USD
    pub max_total_exposure_usd: Decimal,
    /// Portfolio drawdown ceiling (0–100). Circuit-breaker blocks new trades above this.
    pub max_drawdown_pct: Decimal,
    /// When false the bot may only reduce existing positions.
    pub can_open_positions: bool,

    /// Required when `protocol` family is perpetuals (hyperliquid, gmx_v2, vertex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perps: Option<PerpsPolicy>,

    /// Required when `protocol` family is vault-backed DeFi (uniswap_v3, aave_v3, morpho, aerodrome, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault: Option<VaultPolicy>,

    /// Required when `protocol` is polymarket_clob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clob: Option<ClobPolicy>,
}

/// Perpetual-futures specific risk limits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PerpsPolicy {
    /// Case-insensitive ticker symbols (e.g. `["ETH", "BTC"]`).
    pub allowed_assets: Vec<String>,
    pub max_leverage: u32,
    /// Maximum distance from entry at which the stop-loss may be placed (fraction of entry, e.g. 0.05 = 5%).
    pub max_stop_loss_distance: Decimal,
    pub min_stop_loss_distance: Decimal,
    /// When true, every new position open MUST supply `stop_loss_distance` metadata or be rejected.
    pub require_stop_loss: bool,
}

/// Vault-backed DeFi swap/lend/borrow risk limits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultPolicy {
    /// Allowed protocol identifiers (e.g. `["uniswap_v3", "aave_v3"]`). Empty = all.
    pub allowed_protocols: Vec<String>,
    /// Allowed input token addresses. Empty = all.
    pub allowed_tokens_in: Vec<String>,
    /// Allowed output token addresses. Empty = all.
    pub allowed_tokens_out: Vec<String>,
    /// Maximum tolerated slippage in basis points.
    pub max_slippage_bps: u32,
}

/// Prediction-market (Polymarket CLOB) risk limits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClobPolicy {
    /// Allowed Polymarket condition IDs. Empty = all markets.
    pub allowed_market_ids: Vec<String>,
    pub max_position_size_usd: Decimal,
}

// ── Canonical ABI-encoded hashing ────────────────────────────────────────────

fn decimal_to_cents(d: Decimal) -> Result<u64, EnvelopeError> {
    (d * Decimal::from(100))
        .to_u64()
        .ok_or_else(|| EnvelopeError::HashEncodingFailed {
            reason: format!("decimal {d} out of u64 range after scaling to cents"),
        })
}

fn decimal_pct_to_bps(pct: Decimal) -> Result<u32, EnvelopeError> {
    // pct is 0-100; bps is 0-10000
    (pct * Decimal::from(100))
        .to_u32()
        .ok_or_else(|| EnvelopeError::HashEncodingFailed {
            reason: format!("percentage {pct} out of u32 range after scaling to bps"),
        })
}

fn decimal_fraction_to_bps(frac: Decimal) -> Result<u32, EnvelopeError> {
    // frac is 0-1; bps is 0-10000
    (frac * Decimal::from(10_000))
        .to_u32()
        .ok_or_else(|| EnvelopeError::HashEncodingFailed {
            reason: format!("fraction {frac} out of u32 range after scaling to bps"),
        })
}

fn hash_sorted_strings(values: &[String]) -> B256 {
    let mut sorted = values.to_vec();
    sorted.sort();
    sorted.dedup();
    let encoded: Vec<u8> = sorted
        .iter()
        .flat_map(|s| keccak256(s.as_bytes()).to_vec())
        .collect();
    keccak256(encoded)
}

impl TradingPolicy {
    pub fn struct_hash(&self) -> Result<B256, EnvelopeError> {
        let max_trade_cents = decimal_to_cents(self.max_trade_size_usd)?;
        let max_exposure_cents = decimal_to_cents(self.max_total_exposure_usd)?;
        let max_drawdown_bps = decimal_pct_to_bps(self.max_drawdown_pct)?;
        let perps_hash = self
            .perps
            .as_ref()
            .map(PerpsPolicy::struct_hash)
            .transpose()?
            .unwrap_or(B256::ZERO);
        let vault_hash = self
            .vault
            .as_ref()
            .map(VaultPolicy::struct_hash)
            .transpose()?
            .unwrap_or(B256::ZERO);
        let clob_hash = self
            .clob
            .as_ref()
            .map(ClobPolicy::struct_hash)
            .transpose()?
            .unwrap_or(B256::ZERO);

        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(TRADING_POLICY_TYPE.as_bytes()),
            U256::from(self.can_open_positions as u8),
            clob_hash,
            U256::from(max_drawdown_bps),
            U256::from(max_exposure_cents),
            U256::from(max_trade_cents),
            perps_hash,
            vault_hash,
        ))))
    }

    pub fn validate(&self) -> Result<(), EnvelopeError> {
        if self.max_trade_size_usd <= Decimal::ZERO {
            return Err(EnvelopeError::InvalidTradeSize);
        }
        if self.max_total_exposure_usd <= Decimal::ZERO {
            return Err(EnvelopeError::InvalidTotalExposure);
        }
        if self.max_drawdown_pct <= Decimal::ZERO || self.max_drawdown_pct > Decimal::from(100) {
            return Err(EnvelopeError::InvalidDrawdownPct {
                got: self.max_drawdown_pct.to_string(),
            });
        }
        if let Some(ref p) = self.perps {
            p.validate()?;
        }
        Ok(())
    }
}

impl PerpsPolicy {
    pub fn struct_hash(&self) -> Result<B256, EnvelopeError> {
        let max_sl_bps = decimal_fraction_to_bps(self.max_stop_loss_distance)?;
        let min_sl_bps = decimal_fraction_to_bps(self.min_stop_loss_distance)?;
        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(PERPS_POLICY_TYPE.as_bytes()),
            hash_sorted_strings(&self.allowed_assets),
            U256::from(self.max_leverage),
            U256::from(max_sl_bps),
            U256::from(min_sl_bps),
            U256::from(self.require_stop_loss as u8),
        ))))
    }

    pub fn validate(&self) -> Result<(), EnvelopeError> {
        if self.max_leverage < 1 {
            return Err(EnvelopeError::InvalidLeverage);
        }
        if self.min_stop_loss_distance >= self.max_stop_loss_distance {
            return Err(EnvelopeError::InvalidStopLossRange);
        }
        Ok(())
    }
}

impl VaultPolicy {
    pub fn struct_hash(&self) -> Result<B256, EnvelopeError> {
        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(VAULT_POLICY_TYPE.as_bytes()),
            hash_sorted_strings(&self.allowed_protocols),
            hash_sorted_strings(&self.allowed_tokens_in),
            hash_sorted_strings(&self.allowed_tokens_out),
            U256::from(self.max_slippage_bps),
        ))))
    }
}

impl ClobPolicy {
    pub fn struct_hash(&self) -> Result<B256, EnvelopeError> {
        let max_pos_cents = decimal_to_cents(self.max_position_size_usd)?;
        Ok(keccak256(SolValue::abi_encode(&(
            keccak256(CLOB_POLICY_TYPE.as_bytes()),
            hash_sorted_strings(&self.allowed_market_ids),
            U256::from(max_pos_cents),
        ))))
    }
}
