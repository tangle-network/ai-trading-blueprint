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

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_perps() -> PerpsPolicy {
        PerpsPolicy {
            allowed_assets: vec!["ETH".into(), "BTC".into()],
            max_leverage: 5,
            max_stop_loss_distance: Decimal::new(5, 2),
            min_stop_loss_distance: Decimal::new(1, 2),
            require_stop_loss: false,
        }
    }

    fn valid_policy() -> TradingPolicy {
        TradingPolicy {
            max_trade_size_usd: Decimal::from(1000),
            max_total_exposure_usd: Decimal::from(3000),
            max_drawdown_pct: Decimal::from(10),
            can_open_positions: true,
            perps: Some(valid_perps()),
            vault: None,
            clob: None,
        }
    }

    // ── validate() ───────────────────────────────────────────────────────────

    #[test]
    fn validate_accepts_valid_policy() {
        valid_policy().validate().unwrap();
    }

    #[test]
    fn validate_rejects_zero_trade_size() {
        let mut p = valid_policy();
        p.max_trade_size_usd = Decimal::ZERO;
        assert_eq!(p.validate().unwrap_err(), EnvelopeError::InvalidTradeSize);
    }

    #[test]
    fn validate_rejects_negative_trade_size() {
        let mut p = valid_policy();
        p.max_trade_size_usd = Decimal::from(-1);
        assert_eq!(p.validate().unwrap_err(), EnvelopeError::InvalidTradeSize);
    }

    #[test]
    fn validate_rejects_zero_total_exposure() {
        let mut p = valid_policy();
        p.max_total_exposure_usd = Decimal::ZERO;
        assert_eq!(
            p.validate().unwrap_err(),
            EnvelopeError::InvalidTotalExposure
        );
    }

    #[test]
    fn validate_rejects_drawdown_over_100() {
        let mut p = valid_policy();
        p.max_drawdown_pct = Decimal::from(150);
        assert!(matches!(
            p.validate().unwrap_err(),
            EnvelopeError::InvalidDrawdownPct { .. }
        ));
    }

    #[test]
    fn validate_rejects_zero_drawdown() {
        let mut p = valid_policy();
        p.max_drawdown_pct = Decimal::ZERO;
        assert!(matches!(
            p.validate().unwrap_err(),
            EnvelopeError::InvalidDrawdownPct { .. }
        ));
    }

    #[test]
    fn validate_accepts_drawdown_at_100() {
        let mut p = valid_policy();
        p.max_drawdown_pct = Decimal::from(100);
        p.validate().unwrap();
    }

    #[test]
    fn validate_perps_rejects_zero_leverage() {
        let mut p = valid_perps();
        p.max_leverage = 0;
        assert_eq!(p.validate().unwrap_err(), EnvelopeError::InvalidLeverage);
    }

    #[test]
    fn validate_perps_rejects_inverted_stop_loss_range() {
        let mut p = valid_perps();
        p.min_stop_loss_distance = Decimal::new(10, 2);
        p.max_stop_loss_distance = Decimal::new(5, 2);
        assert_eq!(
            p.validate().unwrap_err(),
            EnvelopeError::InvalidStopLossRange
        );
    }

    #[test]
    fn validate_perps_rejects_equal_stop_loss_bounds() {
        let mut p = valid_perps();
        p.min_stop_loss_distance = Decimal::new(5, 2);
        p.max_stop_loss_distance = Decimal::new(5, 2);
        assert_eq!(
            p.validate().unwrap_err(),
            EnvelopeError::InvalidStopLossRange
        );
    }

    // ── decimal scaling helpers ──────────────────────────────────────────────

    #[test]
    fn decimal_to_cents_scales_correctly() {
        assert_eq!(decimal_to_cents(Decimal::from(1)).unwrap(), 100);
        assert_eq!(decimal_to_cents(Decimal::new(150, 2)).unwrap(), 150);
        assert_eq!(decimal_to_cents(Decimal::ZERO).unwrap(), 0);
    }

    #[test]
    fn decimal_to_cents_rejects_overflow() {
        // u64::MAX cents in dollars = ~1.84e17, push past it
        let huge = Decimal::from(i64::MAX);
        let result = decimal_to_cents(huge * Decimal::from(1000));
        assert!(matches!(
            result,
            Err(EnvelopeError::HashEncodingFailed { .. })
        ));
    }

    #[test]
    fn decimal_pct_to_bps_scales_correctly() {
        assert_eq!(decimal_pct_to_bps(Decimal::from(10)).unwrap(), 1000);
        assert_eq!(decimal_pct_to_bps(Decimal::from(100)).unwrap(), 10_000);
    }

    #[test]
    fn decimal_fraction_to_bps_scales_correctly() {
        assert_eq!(decimal_fraction_to_bps(Decimal::new(5, 2)).unwrap(), 500);
        assert_eq!(decimal_fraction_to_bps(Decimal::ONE).unwrap(), 10_000);
        assert_eq!(decimal_fraction_to_bps(Decimal::ZERO).unwrap(), 0);
    }

    // ── hash_sorted_strings ──────────────────────────────────────────────────

    #[test]
    fn hash_sorted_strings_is_order_independent() {
        let a = vec!["ETH".to_string(), "BTC".to_string(), "SOL".to_string()];
        let b = vec!["SOL".to_string(), "ETH".to_string(), "BTC".to_string()];
        assert_eq!(hash_sorted_strings(&a), hash_sorted_strings(&b));
    }

    #[test]
    fn hash_sorted_strings_dedups_repeats() {
        let a = vec!["ETH".to_string(), "BTC".to_string()];
        let b = vec![
            "ETH".to_string(),
            "BTC".to_string(),
            "ETH".to_string(),
            "BTC".to_string(),
        ];
        assert_eq!(hash_sorted_strings(&a), hash_sorted_strings(&b));
    }

    #[test]
    fn hash_sorted_strings_distinct_inputs_produce_distinct_hashes() {
        let a = vec!["ETH".to_string()];
        let b = vec!["BTC".to_string()];
        assert_ne!(hash_sorted_strings(&a), hash_sorted_strings(&b));
    }

    #[test]
    fn hash_sorted_strings_empty_is_stable() {
        let a: Vec<String> = vec![];
        let b: Vec<String> = vec![];
        assert_eq!(hash_sorted_strings(&a), hash_sorted_strings(&b));
    }

    // ── struct_hash determinism + cross-protocol distinctness ───────────────

    #[test]
    fn struct_hash_is_deterministic() {
        let p = valid_policy();
        assert_eq!(p.struct_hash().unwrap(), p.struct_hash().unwrap());
    }

    #[test]
    fn struct_hash_differs_when_perps_field_changes() {
        let p1 = valid_policy();
        let mut p2 = valid_policy();
        p2.perps.as_mut().unwrap().max_leverage = 10;
        assert_ne!(p1.struct_hash().unwrap(), p2.struct_hash().unwrap());
    }

    #[test]
    fn struct_hash_differs_when_universal_field_changes() {
        let p1 = valid_policy();
        let mut p2 = valid_policy();
        p2.can_open_positions = false;
        assert_ne!(p1.struct_hash().unwrap(), p2.struct_hash().unwrap());
    }

    #[test]
    fn perps_only_vs_vault_only_struct_hashes_distinct() {
        let mut perps_only = valid_policy();
        let mut vault_only = valid_policy();
        perps_only.vault = None;
        perps_only.clob = None;
        vault_only.perps = None;
        vault_only.vault = Some(VaultPolicy {
            allowed_protocols: vec!["uniswap_v3".into()],
            allowed_tokens_in: vec![],
            allowed_tokens_out: vec![],
            max_slippage_bps: 50,
        });
        assert_ne!(
            perps_only.struct_hash().unwrap(),
            vault_only.struct_hash().unwrap()
        );
    }

    #[test]
    fn vault_only_vs_clob_only_struct_hashes_distinct() {
        let mut vault_only = valid_policy();
        vault_only.perps = None;
        vault_only.vault = Some(VaultPolicy {
            allowed_protocols: vec![],
            allowed_tokens_in: vec![],
            allowed_tokens_out: vec![],
            max_slippage_bps: 50,
        });
        let mut clob_only = valid_policy();
        clob_only.perps = None;
        clob_only.clob = Some(ClobPolicy {
            allowed_market_ids: vec![],
            max_position_size_usd: Decimal::from(100),
        });
        assert_ne!(
            vault_only.struct_hash().unwrap(),
            clob_only.struct_hash().unwrap()
        );
    }

    #[test]
    fn perps_struct_hash_field_sensitivity() {
        let p1 = valid_perps();
        let h1 = p1.struct_hash().unwrap();

        let mut p2 = p1.clone();
        p2.allowed_assets = vec!["ETH".into()];
        assert_ne!(h1, p2.struct_hash().unwrap());

        let mut p3 = p1.clone();
        p3.max_leverage = 100;
        assert_ne!(h1, p3.struct_hash().unwrap());

        let mut p4 = p1.clone();
        p4.require_stop_loss = true;
        assert_ne!(h1, p4.struct_hash().unwrap());
    }

    #[test]
    fn vault_struct_hash_field_sensitivity() {
        let p1 = VaultPolicy {
            allowed_protocols: vec!["uniswap_v3".into()],
            allowed_tokens_in: vec!["0xabc".into()],
            allowed_tokens_out: vec!["0xdef".into()],
            max_slippage_bps: 50,
        };
        let h1 = p1.struct_hash().unwrap();

        let mut p2 = p1.clone();
        p2.allowed_protocols.push("aave_v3".into());
        assert_ne!(h1, p2.struct_hash().unwrap());

        let mut p3 = p1.clone();
        p3.max_slippage_bps = 100;
        assert_ne!(h1, p3.struct_hash().unwrap());
    }
}
