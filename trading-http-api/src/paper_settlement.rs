//! Paper settlement for Polymarket conditional-token positions.
//!
//! A paper Polymarket (`polymarket_clob`) position can be entered and
//! marked-to-midpoint while its market is live, but the midpoint stops being
//! meaningful once the market resolves (the book disappears and the outcome
//! token is worth a terminal $1 or $0). Without settlement a paper bet's P&L
//! never realizes — a held YES that wins stays marked at its last midpoint
//! instead of redeeming to $1.
//!
//! This module closes that gap for **paper** bots only: it reconstructs each
//! bot's open conditional-token inventory from its persisted [`TradeRecord`]
//! history (there is no separate on-chain position store — the trade log IS the
//! position ledger), checks Polymarket's Gamma API for resolution, and records
//! a `redeem` settlement trade that pays the winning side $1/share and the
//! losing side $0/share. The synthetic portfolio's `redeem` handling then debits
//! the conditional-token position so realized P&L reflects the real bet outcome.
//!
//! Resolution is **fail-closed**: if Gamma is unreachable or the market is not
//! yet resolved, the position is left open and untouched. A settlement is never
//! fabricated.

use chrono::Utc;
use rust_decimal::Decimal;
use serde::Serialize;
use std::collections::BTreeMap;

use trading_runtime::polymarket_clob::{ClobClient, MarketResolution, fetch_market_resolution};

use crate::trade_store::{
    self, PredictionTradeMetadata, StoredValidation, TradeExecutionStatus, TradeRecord,
    TradeValuationStatus,
};

/// `decision_source` stamped on a settlement trade so downstream analytics can
/// distinguish redemptions from agent-initiated sells.
pub const PAPER_SETTLEMENT_SOURCE: &str = "paper_settlement";

/// One bot's net open inventory of a single conditional-outcome token,
/// reconstructed from its trade history.
#[derive(Debug, Clone)]
struct OpenClobPosition {
    token_id: String,
    condition_id: Option<String>,
    /// Net shares still held (buys − sells − prior settlements), > 0.
    shares: Decimal,
    /// Notional USD paid to acquire the still-held shares (cost basis).
    cost_basis_usd: Decimal,
    /// Protocol string from the underlying trades (e.g. `polymarket_clob`).
    protocol: String,
    /// Cash token the bot settles back into (token_in of the buys).
    cash_token: String,
}

impl OpenClobPosition {
    /// Weighted-average entry price per share over the still-held shares.
    fn entry_price(&self) -> Option<Decimal> {
        (self.shares > Decimal::ZERO).then(|| self.cost_basis_usd / self.shares)
    }
}

/// Outcome of a single position settlement, surfaced to callers/observability.
#[derive(Debug, Clone, Serialize)]
pub struct SettledPosition {
    pub token_id: String,
    pub condition_id: Option<String>,
    pub shares: String,
    pub payout_per_share: String,
    pub proceeds_usd: String,
    pub cost_basis_usd: String,
    pub realized_pnl_usd: String,
    pub winning: bool,
    pub trade_id: String,
}

/// Aggregate result of a settlement sweep for one bot.
#[derive(Debug, Clone, Serialize, Default)]
pub struct SettlementReport {
    pub bot_id: String,
    /// Open conditional positions inspected this run.
    pub positions_examined: usize,
    /// Positions whose market resolved and were settled this run.
    pub settled: Vec<SettledPosition>,
    /// Positions left open (market unresolved or resolution unavailable),
    /// keyed by token id → reason.
    pub skipped: BTreeMap<String, String>,
}

/// Reconstruct a paper bot's open conditional-token inventory from its trade
/// history. Buys add shares + cost, sells and prior settlements remove shares
/// pro-rata. Only positions with strictly positive remaining shares are
/// returned.
fn open_clob_positions(bot_id: &str) -> Result<Vec<OpenClobPosition>, String> {
    let trades = trade_store::trades_for_bot(bot_id, 100_000, 0)?.trades;

    // Replay oldest → newest so cost basis tracks acquisition order.
    let mut ordered = trades;
    ordered.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    struct Acc {
        condition_id: Option<String>,
        shares: Decimal,
        cost_basis_usd: Decimal,
        protocol: String,
        cash_token: String,
    }
    let mut by_token: BTreeMap<String, Acc> = BTreeMap::new();

    for trade in &ordered {
        if !is_clob_trade(trade) {
            continue;
        }
        let Some(token_id) = clob_token_id(trade) else {
            continue;
        };
        let Some(shares) = fill_shares(trade) else {
            continue;
        };
        if shares <= Decimal::ZERO {
            continue;
        }

        match trade.action.trim().to_ascii_lowercase().as_str() {
            "buy" => {
                let notional = trade
                    .notional_usd
                    .as_deref()
                    .and_then(parse_decimal)
                    .filter(|n| *n > Decimal::ZERO)
                    .unwrap_or_else(|| shares * fill_price(trade).unwrap_or(Decimal::ZERO));
                let entry = by_token.entry(token_id.clone()).or_insert_with(|| Acc {
                    condition_id: clob_condition_id(trade),
                    shares: Decimal::ZERO,
                    cost_basis_usd: Decimal::ZERO,
                    protocol: trade.target_protocol.clone(),
                    cash_token: clob_cash_token(trade),
                });
                if entry.condition_id.is_none() {
                    entry.condition_id = clob_condition_id(trade);
                }
                entry.shares += shares;
                entry.cost_basis_usd += notional;
            }
            // Sells and settlements both reduce the held position. Reduce cost
            // basis pro-rata so the remaining basis stays consistent.
            "sell" | "redeem" => {
                if let Some(entry) = by_token.get_mut(&token_id)
                    && entry.shares > Decimal::ZERO
                {
                    let reduce = shares.min(entry.shares);
                    let basis_removed = if entry.shares > Decimal::ZERO {
                        entry.cost_basis_usd * (reduce / entry.shares)
                    } else {
                        Decimal::ZERO
                    };
                    entry.shares -= reduce;
                    entry.cost_basis_usd =
                        (entry.cost_basis_usd - basis_removed).max(Decimal::ZERO);
                }
            }
            _ => {}
        }
    }

    Ok(by_token
        .into_iter()
        .filter(|(_, acc)| acc.shares > Decimal::ZERO)
        .map(|(token_id, acc)| OpenClobPosition {
            token_id,
            condition_id: acc.condition_id,
            shares: acc.shares,
            cost_basis_usd: acc.cost_basis_usd,
            protocol: acc.protocol,
            cash_token: acc.cash_token,
        })
        .collect())
}

fn is_clob_trade(trade: &TradeRecord) -> bool {
    matches!(
        trade.target_protocol.trim().to_ascii_lowercase().as_str(),
        "polymarket_clob" | "polymarket"
    )
}

/// CLOB token id for a trade: prefer prediction metadata, fall back to
/// `token_out` (the outcome token the bot bought).
fn clob_token_id(trade: &TradeRecord) -> Option<String> {
    trade
        .prediction_metadata
        .as_ref()
        .and_then(|m| m.token_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let token_out = trade.token_out.trim();
            (!token_out.is_empty()).then(|| token_out.to_string())
        })
}

fn clob_condition_id(trade: &TradeRecord) -> Option<String> {
    trade
        .prediction_metadata
        .as_ref()
        .and_then(|m| m.condition_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Cash token the position settles back into — the buy's `token_in`.
fn clob_cash_token(trade: &TradeRecord) -> String {
    let token_in = trade.token_in.trim();
    if token_in.is_empty() {
        "USDC".to_string()
    } else {
        token_in.to_string()
    }
}

/// Filled shares for a CLOB trade: the filled amount (or amount_out) the bot
/// actually received/sold, not the requested size.
fn fill_shares(trade: &TradeRecord) -> Option<Decimal> {
    // No-fill orders never moved inventory.
    if matches!(trade.execution_status, Some(TradeExecutionStatus::NoFill)) {
        return None;
    }
    trade
        .filled_amount
        .as_deref()
        .or(trade.amount_out.as_deref())
        .and_then(parse_decimal)
        .filter(|shares| *shares > Decimal::ZERO)
}

fn fill_price(trade: &TradeRecord) -> Option<Decimal> {
    trade
        .filled_price_usd
        .as_deref()
        .or(trade.entry_price_usd.as_deref())
        .or(trade.requested_price_usd.as_deref())
        .and_then(parse_decimal)
}

fn parse_decimal(raw: &str) -> Option<Decimal> {
    raw.trim().parse::<Decimal>().ok()
}

/// Settle all resolved open conditional-token positions for a paper bot.
///
/// For each open position this fetches the market's resolution from Gamma. On a
/// resolved market it records a `redeem` settlement trade paying the held shares
/// at the terminal payout ($1 winner / $0 loser). Unresolved markets, and any
/// position whose resolution can't be fetched, are left open (fail-closed).
///
/// `clob` is unused for the resolution fetch itself (Gamma is a separate public
/// API) but is accepted so callers can reuse their configured client and so the
/// signature can grow book-aware exit pricing later without churn.
pub async fn settle_resolved_paper_positions(
    bot_id: &str,
    _clob: Option<&ClobClient>,
) -> Result<SettlementReport, String> {
    let positions = open_clob_positions(bot_id)?;
    let mut report = SettlementReport {
        bot_id: bot_id.to_string(),
        positions_examined: positions.len(),
        ..Default::default()
    };

    for position in positions {
        let Some(condition_id) = position.condition_id.clone() else {
            report.skipped.insert(
                position.token_id.clone(),
                "no condition_id on trade history; cannot resolve market".to_string(),
            );
            continue;
        };

        match fetch_market_resolution(&condition_id).await {
            Ok(Some(resolution)) => match settle_one(bot_id, &position, &resolution).await {
                Ok(settled) => report.settled.push(settled),
                Err(error) => {
                    report.skipped.insert(position.token_id.clone(), error);
                }
            },
            Ok(None) => {
                report.skipped.insert(
                    position.token_id.clone(),
                    "market not yet resolved".to_string(),
                );
            }
            Err(error) => {
                // Fail-closed: leave the position open on any resolution error.
                tracing::warn!(
                    bot_id = %bot_id,
                    token_id = %position.token_id,
                    condition_id = %condition_id,
                    %error,
                    "paper settlement: resolution unavailable, leaving position open"
                );
                report.skipped.insert(
                    position.token_id.clone(),
                    format!("resolution unavailable: {error}"),
                );
            }
        }
    }

    Ok(report)
}

/// Record the settlement trade for a single resolved position.
async fn settle_one(
    bot_id: &str,
    position: &OpenClobPosition,
    resolution: &MarketResolution,
) -> Result<SettledPosition, String> {
    let Some(payout) = resolution.payout_for_token(&position.token_id) else {
        return Err(format!(
            "resolved market {} does not price token {} — leaving open",
            resolution.condition_id, position.token_id
        ));
    };

    let shares = position.shares;
    let proceeds = (shares * payout).max(Decimal::ZERO);
    let realized_pnl = proceeds - position.cost_basis_usd;
    let winning = payout >= Decimal::ONE;
    let entry_price = position.entry_price();

    let trade_id = uuid::Uuid::new_v4().to_string();
    let tx_hash = format!("paper-settle:{trade_id}");
    let reason = if winning {
        format!(
            "Paper settlement: market {} resolved in favor of held outcome; {} shares redeem at $1.00",
            resolution.condition_id, shares
        )
    } else {
        format!(
            "Paper settlement: market {} resolved against held outcome; {} shares redeem at $0.00",
            resolution.condition_id, shares
        )
    };

    let mut prediction_metadata = PredictionTradeMetadata {
        condition_id: Some(resolution.condition_id.clone()),
        token_id: Some(position.token_id.clone()),
        venue: Some("polymarket".to_string()),
        market_type: Some("prediction_market".to_string()),
        ..Default::default()
    };
    if prediction_metadata.outcome_label.is_none() {
        prediction_metadata.outcome_label = resolution.winning_outcome.clone();
    }

    let record = TradeRecord {
        id: trade_id.clone(),
        bot_id: bot_id.to_string(),
        timestamp: Utc::now(),
        action: "redeem".to_string(),
        // token_in = the outcome token being redeemed; token_out = cash back.
        token_in: position.token_id.clone(),
        token_out: position.cash_token.clone(),
        amount_in: shares.to_string(),
        min_amount_out: proceeds.to_string(),
        target_protocol: position.protocol.clone(),
        tx_hash,
        block_number: Some(0),
        gas_used: Some("0".to_string()),
        paper_trade: true,
        execution_status: Some(TradeExecutionStatus::Filled),
        clob_order_id: None,
        amount_out: Some(proceeds.to_string()),
        entry_price_usd: entry_price.map(|p| p.to_string()),
        notional_usd: Some(proceeds.to_string()),
        requested_price_usd: Some(payout.to_string()),
        filled_price_usd: Some(payout.to_string()),
        filled_amount: Some(shares.to_string()),
        slippage_bps: None,
        execution_reason: Some(reason),
        prediction_metadata: Some(prediction_metadata),
        hyperliquid_metadata: None,
        valuation_status: TradeValuationStatus::Priced,
        validation: settlement_validation(),
        signal_price: entry_price.map(|p| p.to_string()),
        fill_price: Some(payout.to_string()),
        signal_to_fill_ms: None,
        decision_source: Some(PAPER_SETTLEMENT_SOURCE.to_string()),
        runner_signal: None,
        agent_reasoning: None,
        harness_version: None,
        candidate_hash: None,
        revision_id: None,
        risk_budget_decision_id: None,
        paper_pnl_pct: None,
        paper_equity_after: None,
    };

    trade_store::record_trade(record)
        .await
        .map_err(|e| format!("settlement trade persistence failed: {e}"))?;

    tracing::info!(
        bot_id = %bot_id,
        token_id = %position.token_id,
        condition_id = %resolution.condition_id,
        shares = %shares,
        payout = %payout,
        realized_pnl = %realized_pnl,
        winning,
        "paper settlement recorded"
    );

    Ok(SettledPosition {
        token_id: position.token_id.clone(),
        condition_id: position.condition_id.clone(),
        shares: shares.to_string(),
        payout_per_share: payout.to_string(),
        proceeds_usd: proceeds.to_string(),
        cost_basis_usd: position.cost_basis_usd.to_string(),
        realized_pnl_usd: realized_pnl.to_string(),
        winning,
        trade_id,
    })
}

/// A settlement is an automated bookkeeping event, not a validator-gated trade.
/// It carries an explicit non-validator marker so it never looks like an
/// approved order, mirroring how other internal paper bookkeeping records read.
fn settlement_validation() -> StoredValidation {
    StoredValidation {
        approved: true,
        aggregate_score: 0,
        intent_hash: format!("0x{}", "00".repeat(32)),
        responses: Vec::new(),
        simulation: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trading_runtime::polymarket_clob::MarketResolution;

    fn buy_trade(
        bot_id: &str,
        token_id: &str,
        condition_id: &str,
        shares: &str,
        price: &str,
        notional: &str,
    ) -> TradeRecord {
        TradeRecord {
            id: uuid::Uuid::new_v4().to_string(),
            bot_id: bot_id.to_string(),
            timestamp: Utc::now(),
            action: "buy".to_string(),
            token_in: "USDC".to_string(),
            token_out: token_id.to_string(),
            amount_in: notional.to_string(),
            min_amount_out: shares.to_string(),
            target_protocol: "polymarket_clob".to_string(),
            tx_hash: format!("paper-clob:{}", uuid::Uuid::new_v4()),
            block_number: Some(0),
            gas_used: Some("0".to_string()),
            paper_trade: true,
            execution_status: Some(TradeExecutionStatus::Filled),
            clob_order_id: None,
            amount_out: Some(shares.to_string()),
            entry_price_usd: Some(price.to_string()),
            notional_usd: Some(notional.to_string()),
            requested_price_usd: Some(price.to_string()),
            filled_price_usd: Some(price.to_string()),
            filled_amount: Some(shares.to_string()),
            slippage_bps: None,
            execution_reason: Some("test buy".to_string()),
            prediction_metadata: Some(PredictionTradeMetadata {
                condition_id: Some(condition_id.to_string()),
                token_id: Some(token_id.to_string()),
                venue: Some("polymarket".to_string()),
                ..Default::default()
            }),
            hyperliquid_metadata: None,
            valuation_status: TradeValuationStatus::Priced,
            validation: settlement_validation(),
            signal_price: None,
            fill_price: None,
            signal_to_fill_ms: None,
            decision_source: Some("test".to_string()),
            runner_signal: None,
            agent_reasoning: None,
            harness_version: None,
            candidate_hash: None,
            revision_id: None,
            risk_budget_decision_id: None,
            paper_pnl_pct: None,
            paper_equity_after: None,
        }
    }

    #[test]
    fn open_positions_net_buys_minus_sells() {
        let bot = format!("settle-net-{}", uuid::Uuid::new_v4());
        // 100 shares @ 0.60 = $60 cost.
        tokio_block(trade_store::record_trade(buy_trade(
            &bot, "tok-1", "cond-1", "100", "0.60", "60",
        )))
        .unwrap();
        // Sell 40 shares back.
        let mut sell = buy_trade(&bot, "tok-1", "cond-1", "40", "0.65", "26");
        sell.action = "sell".to_string();
        sell.token_in = "tok-1".to_string();
        sell.token_out = "USDC".to_string();
        tokio_block(trade_store::record_trade(sell)).unwrap();

        let positions = open_clob_positions(&bot).unwrap();
        let pos = positions
            .iter()
            .find(|p| p.token_id == "tok-1")
            .expect("open position");
        assert_eq!(pos.shares, Decimal::from(60));
        // Cost basis reduced pro-rata: 60 * (60/100) = 36.
        assert_eq!(pos.cost_basis_usd, Decimal::from(36));
        assert_eq!(
            pos.entry_price(),
            Some(Decimal::from_str_exact("0.6").unwrap())
        );
    }

    #[tokio::test]
    async fn yes_position_settles_to_one_dollar() {
        let bot = format!("settle-yes-{}", uuid::Uuid::new_v4());
        // 100 YES shares @ 0.40 = $40 cost.
        trade_store::record_trade(buy_trade(&bot, "yes-tok", "cond-yes", "100", "0.40", "40"))
            .await
            .unwrap();
        let position = open_clob_positions(&bot)
            .unwrap()
            .into_iter()
            .find(|p| p.token_id == "yes-tok")
            .unwrap();

        let mut payouts = std::collections::HashMap::new();
        payouts.insert("yes-tok".to_string(), Decimal::ONE);
        payouts.insert("no-tok".to_string(), Decimal::ZERO);
        let resolution = MarketResolution {
            condition_id: "cond-yes".to_string(),
            payouts,
            winning_outcome: Some("Yes".to_string()),
        };

        let settled = settle_one(&bot, &position, &resolution).await.unwrap();
        assert!(settled.winning);
        // Proceeds = 100 * 1 = 100; PnL = 100 - 40 = 60.
        assert_eq!(settled.proceeds_usd, "100");
        assert_eq!(settled.realized_pnl_usd, "60");

        // Re-aggregating now shows the position closed (redeem debited it).
        let remaining = open_clob_positions(&bot).unwrap();
        assert!(
            remaining.iter().all(|p| p.token_id != "yes-tok"),
            "settled position should net to zero"
        );
    }

    #[tokio::test]
    async fn no_position_settles_to_zero_full_loss() {
        let bot = format!("settle-no-{}", uuid::Uuid::new_v4());
        // 50 shares @ 0.70 = $35 cost; market resolves against → $0.
        trade_store::record_trade(buy_trade(&bot, "lose-tok", "cond-no", "50", "0.70", "35"))
            .await
            .unwrap();
        let position = open_clob_positions(&bot)
            .unwrap()
            .into_iter()
            .find(|p| p.token_id == "lose-tok")
            .unwrap();

        let mut payouts = std::collections::HashMap::new();
        payouts.insert("lose-tok".to_string(), Decimal::ZERO);
        payouts.insert("win-tok".to_string(), Decimal::ONE);
        let resolution = MarketResolution {
            condition_id: "cond-no".to_string(),
            payouts,
            winning_outcome: Some("Win".to_string()),
        };

        let settled = settle_one(&bot, &position, &resolution).await.unwrap();
        assert!(!settled.winning);
        assert_eq!(settled.proceeds_usd, "0");
        // Full loss of cost basis.
        assert_eq!(settled.realized_pnl_usd, "-35");
    }

    fn tokio_block<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }
}
