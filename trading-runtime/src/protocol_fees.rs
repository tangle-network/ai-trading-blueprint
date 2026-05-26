//! Canonical per-protocol trade-fee schedules — the single source of truth used
//! by the live execute path, the backtest cost model, and the agent's loop
//! prompt context. Rates are conservative published figures (taker side, no
//! tier discounts) so a fee-aware gate errs on the side of rejecting marginal
//! trades rather than eating PnL silently.
//!
//! When a venue exposes the operator's *effective* fee tier (Hyperliquid
//! `info.user_fees`, Binance/Coinbase account endpoints, …), live callers
//! should prefer that and only fall back to this table. Keep this static set
//! as the safe floor so a tier query failure cannot accidentally enable
//! unprofitable trades.
//!
//! This module is intentionally separate from `crate::fees`, which handles
//! VAULT-LEVEL performance / management fees (FeeDistributor) — a different
//! concept that operates on AUM, not per-trade notional.

use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;

/// Conservative published fee schedule for a single protocol adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolFeeSchedule {
    /// Stable protocol id used by `TradeIntent::target_protocol`.
    pub protocol: &'static str,
    /// Taker side, basis points (1 bp = 0.01% = 0.0001). The gate uses this.
    pub taker_bps: u32,
    /// Maker side, basis points (informational; the gate is conservative).
    pub maker_bps: u32,
    /// Minimum trade notional in USD that's worth submitting given fees + gas.
    pub min_notional_usd: u32,
    /// Typical on-chain gas cost per trade in USD (0 for off-chain venues).
    pub typical_gas_usd: u32,
    /// One-line human description; included in the agent prompt verbatim.
    pub note: &'static str,
}

/// Conservative published fee schedules for every adapter currently routed
/// through this runtime. Maker rates are shown for transparency but the gate
/// uses the taker side (worst case).
pub const SCHEDULES: &[ProtocolFeeSchedule] = &[
    // ── Hyperliquid (off-chain L1 clearinghouse) ─────────────────────────────
    ProtocolFeeSchedule {
        protocol: "hyperliquid",
        taker_bps: 5,
        maker_bps: 2,
        min_notional_usd: 10,
        typical_gas_usd: 0,
        note: "perps: 0.05% taker / 0.02% maker; volume-tier discounts ignored",
    },
    ProtocolFeeSchedule {
        protocol: "hyperliquid_perp",
        taker_bps: 5,
        maker_bps: 2,
        min_notional_usd: 10,
        typical_gas_usd: 0,
        note: "alias of hyperliquid",
    },
    ProtocolFeeSchedule {
        protocol: "hyperliquid_spot",
        taker_bps: 7,
        maker_bps: 4,
        min_notional_usd: 10,
        typical_gas_usd: 0,
        note: "spot: 0.07% taker / 0.04% maker",
    },
    // ── EVM DEXs (gas estimates assume L2 / HyperEVM) ────────────────────────
    ProtocolFeeSchedule {
        protocol: "uniswap_v3",
        taker_bps: 30,
        maker_bps: 30,
        min_notional_usd: 100,
        typical_gas_usd: 2,
        note: "0.30% default pool — use 5/30/100bps tier per pair when known",
    },
    ProtocolFeeSchedule {
        protocol: "pancakeswap_v3",
        taker_bps: 25,
        maker_bps: 25,
        min_notional_usd: 100,
        typical_gas_usd: 2,
        note: "0.25% default pool",
    },
    ProtocolFeeSchedule {
        protocol: "curve",
        taker_bps: 4,
        maker_bps: 4,
        min_notional_usd: 100,
        typical_gas_usd: 2,
        note: "~0.04% stableswap (varies by pool)",
    },
    ProtocolFeeSchedule {
        protocol: "aerodrome",
        taker_bps: 5,
        maker_bps: 5,
        min_notional_usd: 100,
        typical_gas_usd: 2,
        note: "Base; stable=0.01%, volatile=0.05% — assume volatile",
    },
    // ── Perp DEXs ────────────────────────────────────────────────────────────
    ProtocolFeeSchedule {
        protocol: "gmx_v2",
        taker_bps: 5,
        maker_bps: 5,
        min_notional_usd: 50,
        typical_gas_usd: 3,
        note: "0.05% open/close + funding (funding modeled separately)",
    },
    ProtocolFeeSchedule {
        protocol: "vertex",
        taker_bps: 2,
        maker_bps: 0,
        min_notional_usd: 10,
        typical_gas_usd: 2,
        note: "0.02% taker / 0% maker on perps",
    },
    // ── Lending ──────────────────────────────────────────────────────────────
    ProtocolFeeSchedule {
        protocol: "aave_v3",
        taker_bps: 0,
        maker_bps: 0,
        min_notional_usd: 100,
        typical_gas_usd: 3,
        note: "no per-tx fee; ongoing borrow/supply spread",
    },
    ProtocolFeeSchedule {
        protocol: "morpho",
        taker_bps: 0,
        maker_bps: 0,
        min_notional_usd: 100,
        typical_gas_usd: 3,
        note: "no per-tx fee; lend/borrow spread",
    },
    // ── Prediction markets ───────────────────────────────────────────────────
    ProtocolFeeSchedule {
        protocol: "polymarket",
        taker_bps: 0,
        maker_bps: 0,
        min_notional_usd: 10,
        typical_gas_usd: 1,
        note: "no per-trade fee; resolver fees taken at settlement",
    },
    // ── Centralized exchanges ────────────────────────────────────────────────
    ProtocolFeeSchedule {
        protocol: "binance",
        taker_bps: 10,
        maker_bps: 10,
        min_notional_usd: 10,
        typical_gas_usd: 0,
        note: "spot: 0.10%/0.10% (BNB-discount tier NOT assumed)",
    },
    ProtocolFeeSchedule {
        protocol: "coinbase",
        taker_bps: 60,
        maker_bps: 40,
        min_notional_usd: 10,
        typical_gas_usd: 0,
        note: "advanced: 0.60% taker / 0.40% maker (volume tier ignored)",
    },
    // ── Cross-protocol synthetics (TWAP, stat-arb) ───────────────────────────
    ProtocolFeeSchedule {
        protocol: "twap",
        taker_bps: 5,
        maker_bps: 5,
        min_notional_usd: 100,
        typical_gas_usd: 2,
        note: "uses underlying DEX fees; cost amortized across slices",
    },
    ProtocolFeeSchedule {
        protocol: "stat_arb",
        taker_bps: 5,
        maker_bps: 5,
        min_notional_usd: 100,
        typical_gas_usd: 2,
        note: "uses underlying DEX fees per leg (×2 for round-trip)",
    },
    // ── Solana DEXs (Jupiter aggregator + Drift perps) ───────────────────────
    ProtocolFeeSchedule {
        protocol: "jupiter",
        taker_bps: 15,
        maker_bps: 15,
        min_notional_usd: 50,
        typical_gas_usd: 0,
        note: "Solana aggregator; route-dependent (~0.15% typical) + ~$0 priority fee",
    },
    ProtocolFeeSchedule {
        protocol: "drift",
        taker_bps: 10,
        maker_bps: 2,
        min_notional_usd: 10,
        typical_gas_usd: 0,
        note: "Solana perps; 0.10% taker / 0.02% maker (rebates may apply)",
    },
];

/// Look up the canonical fee schedule for a protocol id.
///
/// Matching is case-insensitive and falls back by stripping a trailing
/// `_perp`/`_spot`/`_v2`/`_v3` suffix, so callers can pass either
/// `"hyperliquid"` or `"hyperliquid_perp"` interchangeably.
pub fn schedule_for(protocol: &str) -> Option<&'static ProtocolFeeSchedule> {
    let key = protocol.trim().to_ascii_lowercase();
    if let Some(s) = SCHEDULES.iter().find(|s| s.protocol.eq_ignore_ascii_case(&key)) {
        return Some(s);
    }
    // Suffix fallback: try the bare protocol id after stripping a common suffix.
    for suffix in ["_perp", "_spot"] {
        if let Some(bare) = key.strip_suffix(suffix)
            && let Some(s) = SCHEDULES.iter().find(|s| s.protocol.eq_ignore_ascii_case(bare))
        {
            return Some(s);
        }
    }
    None
}

/// Estimate the fee in USD for a trade of `notional_usd` at the schedule's
/// taker rate (the conservative side). Includes a flat gas estimate when the
/// venue settles on-chain.
///
/// Live callers that know the venue's effective tier should compute fees from
/// that and only consult this helper as a safe upper-bound fallback.
pub fn estimate_fee_usd(schedule: &ProtocolFeeSchedule, notional_usd: Decimal) -> Decimal {
    let trade_fee = notional_usd * Decimal::new(schedule.taker_bps as i64, 4);
    let gas = Decimal::from_u32(schedule.typical_gas_usd).unwrap_or(Decimal::ZERO);
    trade_fee + gas
}

/// Reason a fee gate rejected a trade. Surfaced verbatim to the caller (the
/// agent / API client) so it can either resize, retry on a different venue,
/// or skip the trade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeeRejection {
    UnknownProtocol(String),
    BelowMinNotional {
        notional_usd: Decimal,
        min_usd: u32,
    },
    FeesEatProfit {
        fees_usd: Decimal,
        expected_pnl_usd: Decimal,
        min_pnl_after_fees_usd: Decimal,
    },
}

impl std::fmt::Display for FeeRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FeeRejection::UnknownProtocol(p) => {
                write!(f, "no fee schedule for protocol '{p}' — refusing to trade without a known fee floor")
            }
            FeeRejection::BelowMinNotional { notional_usd, min_usd } => {
                write!(f, "trade notional ${notional_usd} is below the minimum ${min_usd} worth submitting at this venue's fees")
            }
            FeeRejection::FeesEatProfit { fees_usd, expected_pnl_usd, min_pnl_after_fees_usd } => {
                write!(
                    f,
                    "expected fees ${fees_usd} exceed expected PnL ${expected_pnl_usd} minus min-margin ${min_pnl_after_fees_usd}; refusing trade",
                )
            }
        }
    }
}

impl std::error::Error for FeeRejection {}

/// Pre-trade gate without a PnL estimate — checks only that the protocol is
/// known and the notional clears the venue's minimum worth submitting.
/// Returns the resolved schedule on success.
///
/// This is the gate the live execute path uses today: an intent does not yet
/// carry an `expected_pnl_usd` field, so we cannot enforce a fees-vs-profit
/// floor at the runtime layer. The agent prompt pushes that responsibility
/// to the reasoning layer (see `render_agent_context`). When intents grow an
/// expected-PnL field, switch the live path to `gate_with_pnl` below.
pub fn gate_min_notional(
    protocol: &str,
    notional_usd: Decimal,
) -> Result<&'static ProtocolFeeSchedule, FeeRejection> {
    let schedule = schedule_for(protocol)
        .ok_or_else(|| FeeRejection::UnknownProtocol(protocol.to_string()))?;
    if notional_usd < Decimal::from(schedule.min_notional_usd) {
        return Err(FeeRejection::BelowMinNotional {
            notional_usd,
            min_usd: schedule.min_notional_usd,
        });
    }
    Ok(schedule)
}

/// Stronger gate that ALSO refuses a trade when the venue's fees would eat
/// most of the expected profit. Use this when the caller can supply a
/// pre-fee PnL estimate (backtests, eval harnesses, future intents).
pub fn gate_with_pnl(
    protocol: &str,
    notional_usd: Decimal,
    expected_pnl_usd: Decimal,
    min_pnl_after_fees_usd: Decimal,
) -> Result<&'static ProtocolFeeSchedule, FeeRejection> {
    let schedule = gate_min_notional(protocol, notional_usd)?;
    let fees_usd = estimate_fee_usd(schedule, notional_usd);
    if expected_pnl_usd - fees_usd < min_pnl_after_fees_usd {
        return Err(FeeRejection::FeesEatProfit {
            fees_usd,
            expected_pnl_usd,
            min_pnl_after_fees_usd,
        });
    }
    Ok(schedule)
}

/// Render the canonical fee schedule as a markdown section ready to splice
/// into the agent's system prompt. Re-rendered each tick so any schedule
/// change flows through to the agent's reasoning context.
pub fn render_agent_context() -> String {
    let mut s = String::from("## Protocol fee schedule (conservative; assume taker)\n\n");
    s.push_str("| Protocol | Taker | Maker | Min $ | Gas ~$ | Notes |\n");
    s.push_str("|---|---:|---:|---:|---:|---|\n");
    for sched in SCHEDULES {
        s.push_str(&format!(
            "| {} | {:.2}% | {:.2}% | ${} | ${} | {} |\n",
            sched.protocol,
            sched.taker_bps as f64 / 100.0,
            sched.maker_bps as f64 / 100.0,
            sched.min_notional_usd,
            sched.typical_gas_usd,
            sched.note,
        ));
    }
    s.push_str(
        "\n**Fee-aware reasoning is mandatory.** Before recommending a trade, \
         ensure expected PnL exceeds fees + slippage by a sane margin. The runtime \
         rejects trades below each venue's minimum notional; below that floor the \
         fees alone will eat most or all of any plausible profit. When a venue exposes \
         your effective fee tier (Hyperliquid `info.user_fees`, CEX account endpoints), \
         prefer those over this table — but treat this table as the safe floor.\n",
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(num: i64, scale: u32) -> Decimal {
        Decimal::new(num, scale)
    }

    #[test]
    fn every_adapter_resolves() {
        for p in [
            "hyperliquid",
            "hyperliquid_perp",
            "hyperliquid_spot",
            "uniswap_v3",
            "pancakeswap_v3",
            "curve",
            "aerodrome",
            "gmx_v2",
            "vertex",
            "aave_v3",
            "morpho",
            "polymarket",
            "binance",
            "coinbase",
            "twap",
            "stat_arb",
            "jupiter",
            "drift",
        ] {
            assert!(schedule_for(p).is_some(), "missing schedule for {p}");
        }
    }

    #[test]
    fn protocol_lookup_is_case_insensitive() {
        assert!(schedule_for("HyperLiquid").is_some());
        assert!(schedule_for("UNISWAP_V3").is_some());
    }

    #[test]
    fn perp_spot_suffix_fallback_to_base_protocol() {
        // gmx_v2 has no _perp alias in the table; suffix fallback strips it.
        assert!(schedule_for("gmx_v2_perp").is_some());
        // hyperliquid_perp IS in the table directly; should resolve that, not fall back.
        let direct = schedule_for("hyperliquid_perp").unwrap();
        assert_eq!(direct.protocol, "hyperliquid_perp");
    }

    #[test]
    fn gate_min_notional_rejects_below_floor() {
        let r = gate_min_notional("hyperliquid", d(5, 0));
        assert!(matches!(r, Err(FeeRejection::BelowMinNotional { .. })));
    }

    #[test]
    fn gate_min_notional_accepts_above_floor() {
        let r = gate_min_notional("hyperliquid", d(100, 0));
        assert_eq!(r.unwrap().protocol, "hyperliquid");
    }

    #[test]
    fn unknown_protocol_rejected() {
        let r = gate_min_notional("does_not_exist", d(1000, 0));
        assert!(matches!(r, Err(FeeRejection::UnknownProtocol(_))));
    }

    #[test]
    fn gate_with_pnl_rejects_when_fees_eat_profit() {
        // $1000 trade on hyperliquid: fee = 1000 * 0.0005 + 0 gas = $0.50
        // PnL $0.20 → after fees -$0.30, below min 0 → reject
        let r = gate_with_pnl("hyperliquid", d(1000, 0), d(20, 2), d(0, 0));
        assert!(matches!(r, Err(FeeRejection::FeesEatProfit { .. })));
    }

    #[test]
    fn gate_with_pnl_accepts_profitable_trade() {
        // $1000 × 0.05% = $0.50 fee; PnL $5.00 → after $4.50, min 0 → ok
        let r = gate_with_pnl("hyperliquid", d(1000, 0), d(500, 2), d(0, 0));
        assert!(r.is_ok());
    }

    #[test]
    fn estimate_fee_includes_gas_for_onchain_venues() {
        let uni = schedule_for("uniswap_v3").unwrap();
        // $100 trade × 0.30% = $0.30 + $2 gas = $2.30
        let fee = estimate_fee_usd(uni, d(100, 0));
        assert_eq!(fee, d(230, 2));
    }

    #[test]
    fn estimate_fee_no_gas_for_offchain_venues() {
        let hl = schedule_for("hyperliquid").unwrap();
        // $1000 × 0.05% = $0.50 + $0 gas
        let fee = estimate_fee_usd(hl, d(1000, 0));
        assert_eq!(fee, d(50, 2));
    }

    #[test]
    fn agent_context_includes_every_protocol() {
        let ctx = render_agent_context();
        for sched in SCHEDULES {
            assert!(
                ctx.contains(sched.protocol),
                "agent prompt context missing protocol '{}'",
                sched.protocol
            );
        }
        assert!(ctx.contains("Fee-aware reasoning is mandatory"));
    }
}
