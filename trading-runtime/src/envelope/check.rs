use rust_decimal::Decimal;

use super::error::EnvelopeError;
use super::policy::TradingPolicy;

/// Context describing the trade being evaluated, independent of protocol.
pub struct UniversalContext {
    pub trade_size_usd: Decimal,
    pub current_total_exposure_usd: Decimal,
    pub is_open: bool,
}

pub struct PerpsContext<'a> {
    pub asset: &'a str,
    pub leverage: u32,
    /// `None` means no stop-loss was provided.
    pub stop_loss_distance: Option<Decimal>,
}

pub struct VaultContext<'a> {
    pub protocol: &'a str,
    pub token_in: &'a str,
    pub token_out: &'a str,
    /// Observed slippage in basis points.
    pub slippage_bps: u32,
}

pub struct ClobContext<'a> {
    pub market_id: &'a str,
}

/// Apply universal limits that apply to every protocol.
/// Call this first, then the protocol-specific check.
pub fn check_universal(
    policy: &TradingPolicy,
    ctx: &UniversalContext,
) -> Result<(), EnvelopeError> {
    if !ctx.is_open {
        return Ok(());
    }
    if !policy.can_open_positions {
        return Err(EnvelopeError::CloseOnlyMode);
    }
    if ctx.trade_size_usd > policy.max_trade_size_usd {
        return Err(EnvelopeError::PositionSizeExceeded {
            size: ctx.trade_size_usd.to_string(),
            max: policy.max_trade_size_usd.to_string(),
        });
    }
    let new_total = ctx.current_total_exposure_usd + ctx.trade_size_usd;
    if new_total > policy.max_total_exposure_usd {
        return Err(EnvelopeError::TotalExposureExceeded {
            new_total: new_total.to_string(),
            max: policy.max_total_exposure_usd.to_string(),
        });
    }
    Ok(())
}

/// Apply perpetuals-specific limits. Requires `policy.perps` to be set.
pub fn check_perps(policy: &TradingPolicy, ctx: &PerpsContext<'_>) -> Result<(), EnvelopeError> {
    let perps = policy
        .perps
        .as_ref()
        .ok_or(EnvelopeError::MissingPerpsPolicy)?;

    let upper = ctx.asset.to_uppercase();
    if !perps.allowed_assets.is_empty()
        && !perps
            .allowed_assets
            .iter()
            .any(|a| a.to_uppercase() == upper)
    {
        return Err(EnvelopeError::AssetNotAllowed {
            asset: ctx.asset.to_string(),
        });
    }
    if ctx.leverage > perps.max_leverage {
        return Err(EnvelopeError::LeverageExceeded {
            leverage: ctx.leverage,
            max: perps.max_leverage,
        });
    }
    match ctx.stop_loss_distance {
        None if perps.require_stop_loss => return Err(EnvelopeError::StopLossRequired),
        Some(d) => {
            if d < perps.min_stop_loss_distance {
                return Err(EnvelopeError::StopLossTooTight {
                    distance: d.to_string(),
                    min: perps.min_stop_loss_distance.to_string(),
                });
            }
            if d > perps.max_stop_loss_distance {
                return Err(EnvelopeError::StopLossTooWide {
                    distance: d.to_string(),
                    max: perps.max_stop_loss_distance.to_string(),
                });
            }
        }
        None => {}
    }
    Ok(())
}

/// Apply vault-DeFi-specific limits. Requires `policy.vault` to be set.
pub fn check_vault(policy: &TradingPolicy, ctx: &VaultContext<'_>) -> Result<(), EnvelopeError> {
    let vault = policy
        .vault
        .as_ref()
        .ok_or(EnvelopeError::MissingVaultPolicy)?;

    if !vault.allowed_protocols.is_empty()
        && !vault
            .allowed_protocols
            .iter()
            .any(|p| p.eq_ignore_ascii_case(ctx.protocol))
    {
        return Err(EnvelopeError::ProtocolNotAllowed {
            protocol: ctx.protocol.to_string(),
        });
    }
    if !vault.allowed_tokens_in.is_empty()
        && !vault
            .allowed_tokens_in
            .iter()
            .any(|t| t.eq_ignore_ascii_case(ctx.token_in))
    {
        return Err(EnvelopeError::TokenInNotAllowed {
            token: ctx.token_in.to_string(),
        });
    }
    if !vault.allowed_tokens_out.is_empty()
        && !vault
            .allowed_tokens_out
            .iter()
            .any(|t| t.eq_ignore_ascii_case(ctx.token_out))
    {
        return Err(EnvelopeError::TokenOutNotAllowed {
            token: ctx.token_out.to_string(),
        });
    }
    if ctx.slippage_bps > vault.max_slippage_bps {
        return Err(EnvelopeError::SlippageExceeded {
            bps: ctx.slippage_bps,
            max: vault.max_slippage_bps,
        });
    }
    Ok(())
}

/// Apply CLOB-specific limits. Requires `policy.clob` to be set.
pub fn check_clob(policy: &TradingPolicy, ctx: &ClobContext<'_>) -> Result<(), EnvelopeError> {
    let clob = policy
        .clob
        .as_ref()
        .ok_or(EnvelopeError::MissingClobPolicy)?;
    if !clob.allowed_market_ids.is_empty()
        && !clob.allowed_market_ids.iter().any(|m| m == ctx.market_id)
    {
        return Err(EnvelopeError::MarketNotAllowed {
            market_id: ctx.market_id.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::policy::{ClobPolicy, PerpsPolicy, TradingPolicy, VaultPolicy};
    use rust_decimal::Decimal;

    fn base_policy() -> TradingPolicy {
        TradingPolicy {
            max_trade_size_usd: Decimal::from(1000),
            max_total_exposure_usd: Decimal::from(3000),
            max_drawdown_pct: Decimal::from(10),
            can_open_positions: true,
            perps: Some(PerpsPolicy {
                allowed_assets: vec!["ETH".into()],
                max_leverage: 5,
                max_stop_loss_distance: Decimal::new(5, 2),
                min_stop_loss_distance: Decimal::new(1, 2),
                require_stop_loss: false,
            }),
            vault: None,
            clob: None,
        }
    }

    // ── universal ────────────────────────────────────────────────────────────

    #[test]
    fn universal_allows_valid_open() {
        let p = base_policy();
        check_universal(
            &p,
            &UniversalContext {
                trade_size_usd: Decimal::from(500),
                current_total_exposure_usd: Decimal::ZERO,
                is_open: true,
            },
        )
        .unwrap();
    }

    #[test]
    fn universal_closes_always_pass() {
        let mut p = base_policy();
        p.can_open_positions = false;
        check_universal(
            &p,
            &UniversalContext {
                trade_size_usd: Decimal::from(999999),
                current_total_exposure_usd: Decimal::ZERO,
                is_open: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn universal_close_only_blocks_opens() {
        let mut p = base_policy();
        p.can_open_positions = false;
        let err = check_universal(
            &p,
            &UniversalContext {
                trade_size_usd: Decimal::from(100),
                current_total_exposure_usd: Decimal::ZERO,
                is_open: true,
            },
        )
        .unwrap_err();
        assert_eq!(err, EnvelopeError::CloseOnlyMode);
    }

    #[test]
    fn universal_position_size_exceeded() {
        let p = base_policy();
        let err = check_universal(
            &p,
            &UniversalContext {
                trade_size_usd: Decimal::from(1001),
                current_total_exposure_usd: Decimal::ZERO,
                is_open: true,
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::PositionSizeExceeded { .. }));
    }

    #[test]
    fn universal_total_exposure_exceeded() {
        let p = base_policy();
        let err = check_universal(
            &p,
            &UniversalContext {
                trade_size_usd: Decimal::from(500),
                current_total_exposure_usd: Decimal::from(2800),
                is_open: true,
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::TotalExposureExceeded { .. }));
    }

    #[test]
    fn universal_exact_limits_pass() {
        let p = base_policy();
        check_universal(
            &p,
            &UniversalContext {
                trade_size_usd: Decimal::from(1000),
                current_total_exposure_usd: Decimal::from(2000),
                is_open: true,
            },
        )
        .unwrap();
    }

    // ── perps ─────────────────────────────────────────────────────────────────

    #[test]
    fn perps_allows_valid_trade() {
        let p = base_policy();
        check_perps(
            &p,
            &PerpsContext {
                asset: "ETH",
                leverage: 3,
                stop_loss_distance: Some(Decimal::new(3, 2)),
            },
        )
        .unwrap();
    }

    #[test]
    fn perps_case_insensitive_asset() {
        let p = base_policy();
        check_perps(
            &p,
            &PerpsContext {
                asset: "eth",
                leverage: 1,
                stop_loss_distance: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn perps_asset_not_allowed() {
        let p = base_policy();
        let err = check_perps(
            &p,
            &PerpsContext {
                asset: "DOGE",
                leverage: 1,
                stop_loss_distance: None,
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::AssetNotAllowed { .. }));
    }

    #[test]
    fn perps_leverage_exceeded() {
        let p = base_policy();
        let err = check_perps(
            &p,
            &PerpsContext {
                asset: "ETH",
                leverage: 10,
                stop_loss_distance: None,
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::LeverageExceeded {
                leverage: 10,
                max: 5
            }
        ));
    }

    #[test]
    fn perps_stop_loss_required_but_absent() {
        let mut p = base_policy();
        p.perps.as_mut().unwrap().require_stop_loss = true;
        let err = check_perps(
            &p,
            &PerpsContext {
                asset: "ETH",
                leverage: 1,
                stop_loss_distance: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, EnvelopeError::StopLossRequired);
    }

    #[test]
    fn perps_stop_loss_too_tight() {
        let p = base_policy();
        let err = check_perps(
            &p,
            &PerpsContext {
                asset: "ETH",
                leverage: 1,
                stop_loss_distance: Some(Decimal::new(5, 3)),
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::StopLossTooTight { .. }));
    }

    #[test]
    fn perps_stop_loss_too_wide() {
        let p = base_policy();
        let err = check_perps(
            &p,
            &PerpsContext {
                asset: "ETH",
                leverage: 1,
                stop_loss_distance: Some(Decimal::new(10, 2)),
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::StopLossTooWide { .. }));
    }

    #[test]
    fn perps_missing_policy() {
        let mut p = base_policy();
        p.perps = None;
        let err = check_perps(
            &p,
            &PerpsContext {
                asset: "ETH",
                leverage: 1,
                stop_loss_distance: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, EnvelopeError::MissingPerpsPolicy);
    }

    // ── vault ─────────────────────────────────────────────────────────────────

    #[test]
    fn vault_allows_valid_trade() {
        let mut p = base_policy();
        p.vault = Some(VaultPolicy {
            allowed_protocols: vec!["uniswap_v3".into()],
            allowed_tokens_in: vec![],
            allowed_tokens_out: vec![],
            max_slippage_bps: 50,
        });
        check_vault(
            &p,
            &VaultContext {
                protocol: "uniswap_v3",
                token_in: "0xabc",
                token_out: "0xdef",
                slippage_bps: 30,
            },
        )
        .unwrap();
    }

    #[test]
    fn vault_empty_lists_allow_all() {
        let mut p = base_policy();
        p.vault = Some(VaultPolicy {
            allowed_protocols: vec![],
            allowed_tokens_in: vec![],
            allowed_tokens_out: vec![],
            max_slippage_bps: 100,
        });
        check_vault(
            &p,
            &VaultContext {
                protocol: "anything",
                token_in: "0x1",
                token_out: "0x2",
                slippage_bps: 50,
            },
        )
        .unwrap();
    }

    #[test]
    fn vault_protocol_not_allowed() {
        let mut p = base_policy();
        p.vault = Some(VaultPolicy {
            allowed_protocols: vec!["uniswap_v3".into()],
            allowed_tokens_in: vec![],
            allowed_tokens_out: vec![],
            max_slippage_bps: 100,
        });
        let err = check_vault(
            &p,
            &VaultContext {
                protocol: "aave_v3",
                token_in: "0x1",
                token_out: "0x2",
                slippage_bps: 10,
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::ProtocolNotAllowed { .. }));
    }

    #[test]
    fn vault_slippage_exceeded() {
        let mut p = base_policy();
        p.vault = Some(VaultPolicy {
            allowed_protocols: vec![],
            allowed_tokens_in: vec![],
            allowed_tokens_out: vec![],
            max_slippage_bps: 30,
        });
        let err = check_vault(
            &p,
            &VaultContext {
                protocol: "uniswap_v3",
                token_in: "0x1",
                token_out: "0x2",
                slippage_bps: 50,
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            EnvelopeError::SlippageExceeded { bps: 50, max: 30 }
        ));
    }

    // ── clob ──────────────────────────────────────────────────────────────────

    #[test]
    fn clob_allows_any_market_when_list_empty() {
        let mut p = base_policy();
        p.clob = Some(ClobPolicy {
            allowed_market_ids: vec![],
            max_position_size_usd: Decimal::from(100),
        });
        check_clob(
            &p,
            &ClobContext {
                market_id: "0xabcdef",
            },
        )
        .unwrap();
    }

    #[test]
    fn clob_market_not_allowed() {
        let mut p = base_policy();
        p.clob = Some(ClobPolicy {
            allowed_market_ids: vec!["0x1111".into()],
            max_position_size_usd: Decimal::from(100),
        });
        let err = check_clob(
            &p,
            &ClobContext {
                market_id: "0x9999",
            },
        )
        .unwrap_err();
        assert!(matches!(err, EnvelopeError::MarketNotAllowed { .. }));
    }
}
