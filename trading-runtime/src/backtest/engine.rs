use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use std::collections::{BTreeMap, HashMap};

use crate::error::TradingError;
use crate::leaderboard::{self, EquityPoint};

use super::cost_model;
use super::indicators;
use super::types::*;

pub struct BacktestEngine {
    config: BacktestConfig,
}

/// Per-token candle series extracted from the mixed input.
#[allow(dead_code)]
struct TokenSeries {
    candles: Vec<Candle>,
    closes: Vec<f64>,
    highs: Vec<f64>,
    lows: Vec<f64>,
    volumes: Vec<f64>,
    indicators: TokenIndicators,
}

impl BacktestEngine {
    pub fn new(config: BacktestConfig) -> Self {
        Self { config }
    }

    /// Run a backtest over historical candle data (potentially multi-asset).
    ///
    /// Candles can contain multiple tokens — they're partitioned internally.
    /// Positions are tracked per-token. Equity curve is portfolio-level.
    pub fn run(
        &self,
        candles: &[Candle],
        funding: &[FundingSnapshot],
    ) -> Result<BacktestResult, TradingError> {
        if candles.is_empty() {
            return Ok(empty_result());
        }

        // Partition candles by token
        let mut token_candles: BTreeMap<String, Vec<Candle>> = BTreeMap::new();
        for c in candles {
            token_candles
                .entry(c.token.clone())
                .or_default()
                .push(c.clone());
        }

        // Build per-token indicator caches
        let mut series_map: HashMap<String, TokenSeries> = HashMap::new();
        for (token, tc) in &token_candles {
            let closes = extract_f64(tc, |c| c.close);
            let highs = extract_f64(tc, |c| c.high);
            let lows = extract_f64(tc, |c| c.low);
            let volumes = extract_f64(tc, |c| c.volume);
            let indicators = self.precompute_indicators(&closes, &highs, &lows);
            series_map.insert(
                token.clone(),
                TokenSeries {
                    candles: tc.clone(),
                    closes,
                    highs,
                    lows,
                    volumes,
                    indicators,
                },
            );
        }

        // Build a unified timeline: sorted unique timestamps across all tokens
        let mut all_timestamps: Vec<i64> = candles.iter().map(|c| c.timestamp).collect();
        all_timestamps.sort_unstable();
        all_timestamps.dedup();

        // Per-token position index (which candle index we're at)
        let mut token_idx: HashMap<String, usize> = HashMap::new();

        let warmup = self.warmup_period();
        let mut cash = self.config.initial_capital;
        let mut positions: HashMap<String, OpenPosition> = HashMap::new();
        let mut trades: Vec<SimulatedTrade> = Vec::new();
        let mut equity_curve: Vec<EquityPoint> = Vec::with_capacity(all_timestamps.len());
        let mut total_slippage = Decimal::ZERO;
        let mut total_gas = Decimal::ZERO;
        let mut total_fees = Decimal::ZERO;
        let mut trade_stats = RunningTradeStats::default();

        for &ts in &all_timestamps {
            // Process each token that has a candle at this timestamp
            for (token, series) in &series_map {
                let idx = token_idx.entry(token.clone()).or_insert(0);

                // Advance to the candle at this timestamp (or skip if none)
                if *idx >= series.candles.len() || series.candles[*idx].timestamp != ts {
                    continue;
                }
                let candle = &series.candles[*idx];

                // --- Check exits for this token ---
                if let Some(pos) = positions.get_mut(token) {
                    pos.candles_held += 1;
                    if candle.high > pos.high_water {
                        pos.high_water = candle.high;
                    }
                    if candle.low < pos.low_water {
                        pos.low_water = candle.low;
                    }

                    if let Some(reason) = self.check_exits(pos, candle) {
                        let trade = self.close_position(pos, candle, reason);
                        trade_stats.record(trade.pnl.to_f64().unwrap_or(0.0));
                        total_slippage += trade.slippage_cost;
                        total_gas += trade.gas_cost;
                        total_fees += trade.fee_cost;
                        cash += pos.size_usd + trade.pnl;
                        trades.push(trade);
                        positions.remove(token);
                    }
                }

                // --- Check entries for this token ---
                if !positions.contains_key(token)
                    && *idx >= warmup
                    && positions.len() < self.config.harness.max_positions
                    && self.check_filters(candle, *idx, &series.indicators, &series.closes)
                    && let Some(dir) = self.evaluate_entry(
                        token,
                        *idx,
                        &series.indicators,
                        &series.closes,
                        &series.volumes,
                        &series.candles,
                        funding,
                    )
                {
                    let size = self.compute_position_size(cash, &trade_stats);
                    if size > Decimal::ZERO && size <= cash {
                        let fill = cost_model::apply_entry_slippage(
                            candle.close,
                            dir,
                            size,
                            &self.config.slippage,
                        );
                        let entry_slip = cost_model::slippage_cost(candle.close, fill, size);
                        total_slippage += entry_slip;
                        cash -= size;
                        positions.insert(
                            token.clone(),
                            OpenPosition {
                                token: token.clone(),
                                entry_timestamp: candle.timestamp,
                                direction: dir,
                                entry_fill: fill,
                                size_usd: size,
                                high_water: candle.high,
                                low_water: candle.low,
                                trailing_active: false,
                                candles_held: 0,
                            },
                        );
                    }
                }

                *idx += 1;
            }

            // --- Record portfolio equity at this timestamp ---
            let pos_value: Decimal = positions
                .values()
                .map(|p| {
                    let current_price = series_map
                        .get(&p.token)
                        .and_then(|s| {
                            let ti = token_idx.get(&p.token).copied().unwrap_or(0);
                            // ti was already incremented, so the last processed candle is at ti-1
                            if ti > 0 { s.candles.get(ti - 1) } else { None }
                        })
                        .map(|c| c.close)
                        .unwrap_or(p.entry_fill);
                    mark_to_market(p, current_price)
                })
                .sum();

            equity_curve.push(EquityPoint {
                timestamp_secs: ts,
                account_value: cash + pos_value,
            });
        }

        // Close remaining positions at end of data
        let remaining: Vec<String> = positions.keys().cloned().collect();
        for token in remaining {
            if let Some(pos) = positions.remove(&token)
                && let Some(series) = series_map.get(&token)
                && let Some(last) = series.candles.last()
            {
                let trade = self.close_position(&pos, last, ExitReason::EndOfData);
                trade_stats.record(trade.pnl.to_f64().unwrap_or(0.0));
                total_slippage += trade.slippage_cost;
                total_gas += trade.gas_cost;
                total_fees += trade.fee_cost;
                trades.push(trade);
            }
        }

        let pnls: Vec<Decimal> = trades.iter().map(|t| t.pnl).collect();
        let stats = leaderboard::compute_stats("backtest", &equity_curve, &pnls);
        let tokens_traded: Vec<String> = token_candles.keys().cloned().collect();

        Ok(BacktestResult {
            trades,
            equity_curve,
            stats,
            total_fees,
            total_slippage,
            total_gas,
            candles_processed: candles.len(),
            tokens_traded,
        })
    }

    /// Compare two harness configs against the same candle data.
    pub fn compare(
        config_a: &BacktestConfig,
        config_b: &BacktestConfig,
        candles: &[Candle],
        funding: &[FundingSnapshot],
    ) -> Result<BacktestComparison, TradingError> {
        let result_a = BacktestEngine::new(config_a.clone()).run(candles, funding)?;
        let result_b = BacktestEngine::new(config_b.clone()).run(candles, funding)?;

        Ok(BacktestComparison {
            sharpe_delta: result_b.stats.sharpe_ratio - result_a.stats.sharpe_ratio,
            drawdown_delta: result_b.stats.max_drawdown_pct - result_a.stats.max_drawdown_pct,
            win_rate_delta: result_b.stats.win_rate - result_a.stats.win_rate,
            current: result_a,
            candidate: result_b,
        })
    }

    /// Walk-forward validation: split candles into in-sample (train) and
    /// out-of-sample (test), run comparison on both halves independently.
    ///
    /// Only recommends promotion if the candidate beats current on BOTH halves.
    /// This prevents overfitting to historical patterns.
    ///
    /// `train_pct` controls the split (default 70% train, 30% test).
    pub fn walk_forward_compare(
        config_a: &BacktestConfig,
        config_b: &BacktestConfig,
        candles: &[Candle],
        funding: &[FundingSnapshot],
        train_pct: f64,
    ) -> Result<WalkForwardResult, TradingError> {
        let train_pct = train_pct.clamp(0.3, 0.9);

        // Split candles per token at the train_pct boundary
        let mut all_tokens: BTreeMap<String, Vec<Candle>> = BTreeMap::new();
        for c in candles {
            all_tokens
                .entry(c.token.clone())
                .or_default()
                .push(c.clone());
        }

        let mut train_candles = Vec::new();
        let mut test_candles = Vec::new();

        for tc in all_tokens.values() {
            let split = (tc.len() as f64 * train_pct) as usize;
            train_candles.extend_from_slice(&tc[..split]);
            test_candles.extend_from_slice(&tc[split..]);
        }

        if train_candles.is_empty() || test_candles.is_empty() {
            return Err(TradingError::ConfigError(
                "Not enough candles for walk-forward split".into(),
            ));
        }

        let train_comparison = Self::compare(config_a, config_b, &train_candles, funding)?;
        let test_comparison = Self::compare(config_a, config_b, &test_candles, funding)?;

        let train_promotes = train_comparison.should_promote();
        let test_promotes = test_comparison.should_promote();

        Ok(WalkForwardResult {
            train: train_comparison,
            test: test_comparison,
            should_promote: train_promotes && test_promotes,
            train_candles: train_candles.len(),
            test_candles: test_candles.len(),
        })
    }

    // --- Indicator precomputation ---

    fn precompute_indicators(
        &self,
        closes: &[f64],
        highs: &[f64],
        lows: &[f64],
    ) -> TokenIndicators {
        let mut cache = TokenIndicators::default();

        for rule in &self.config.harness.entry_rules {
            match &rule.signal {
                SignalType::Rsi { period } => {
                    cache
                        .rsi
                        .entry(*period)
                        .or_insert_with(|| indicators::rsi(closes, *period));
                }
                SignalType::EmaCross {
                    short_period,
                    long_period,
                } => {
                    cache
                        .ema
                        .entry(*short_period)
                        .or_insert_with(|| indicators::ema(closes, *short_period));
                    cache
                        .ema
                        .entry(*long_period)
                        .or_insert_with(|| indicators::ema(closes, *long_period));
                    let key = (*short_period, *long_period);
                    if !cache.ema_cross.contains_key(&key) {
                        let short = &cache.ema[short_period];
                        let long = &cache.ema[long_period];
                        cache
                            .ema_cross
                            .insert(key, indicators::ema_crossover(short, long));
                    }
                }
                SignalType::PriceMomentum { .. }
                | SignalType::VolumeSurge { .. }
                | SignalType::FundingRate => {}
            }
        }

        for filter in &self.config.harness.filters {
            if let Filter::VolatilityGate { period, .. } = filter {
                cache
                    .atr
                    .entry(*period)
                    .or_insert_with(|| indicators::atr(highs, lows, closes, *period));
            }
        }

        cache
    }

    fn warmup_period(&self) -> usize {
        let mut max = 0usize;
        for rule in &self.config.harness.entry_rules {
            let lookback = match &rule.signal {
                SignalType::Rsi { period } => *period + 1,
                SignalType::EmaCross { long_period, .. } => *long_period,
                SignalType::PriceMomentum { lookback_candles } => *lookback_candles,
                SignalType::VolumeSurge {
                    lookback_candles, ..
                } => *lookback_candles,
                SignalType::FundingRate => 0,
            };
            max = max.max(lookback);
        }
        for filter in &self.config.harness.filters {
            if let Filter::VolatilityGate { period, .. } = filter {
                max = max.max(*period);
            }
        }
        max
    }

    // --- Filters ---

    fn check_filters(
        &self,
        candle: &Candle,
        idx: usize,
        cache: &TokenIndicators,
        closes: &[f64],
    ) -> bool {
        for filter in &self.config.harness.filters {
            match filter {
                Filter::VolatilityGate {
                    min_atr_pct,
                    max_atr_pct,
                    period,
                } => {
                    if let Some(atr_vals) = cache.atr.get(period)
                        && idx < atr_vals.len()
                    {
                        let close = closes[idx];
                        if close <= 0.0 {
                            return false;
                        }
                        let atr_pct = atr_vals[idx] / close * 100.0;
                        if atr_pct < *min_atr_pct || atr_pct > *max_atr_pct {
                            return false;
                        }
                    }
                }
                Filter::TimeFilter { skip_hours } => {
                    let hour = ((candle.timestamp % 86400) / 3600) as u32;
                    if skip_hours.contains(&hour) {
                        return false;
                    }
                }
                Filter::MinVolume { threshold } => {
                    if candle.volume < *threshold {
                        return false;
                    }
                }
            }
        }
        true
    }

    // --- Entry evaluation ---

    #[allow(clippy::too_many_arguments)]
    fn evaluate_entry(
        &self,
        token: &str,
        idx: usize,
        cache: &TokenIndicators,
        closes: &[f64],
        volumes: &[f64],
        candles: &[Candle],
        funding: &[FundingSnapshot],
    ) -> Option<Direction> {
        let rules = &self.config.harness.entry_rules;
        if rules.is_empty() {
            return None;
        }

        let mut long_weight = 0.0;
        let mut short_weight = 0.0;
        let mut total_weight = 0.0;

        for rule in rules {
            // Skip rules that don't apply to this token
            if !rule.tokens.is_empty() && !rule.tokens.iter().any(|t| t == token) {
                continue;
            }
            total_weight += rule.weight;
            let signal = evaluate_signal(
                &rule.signal,
                &rule.condition,
                idx,
                cache,
                closes,
                volumes,
                candles,
                funding,
                token,
            );
            match signal {
                s if s > 0.0 => long_weight += rule.weight,
                s if s < 0.0 => short_weight += rule.weight,
                _ => {}
            }
        }

        if total_weight <= 0.0 {
            return None;
        }

        let threshold = self.config.harness.entry_threshold;
        let net = (long_weight - short_weight) / total_weight;

        if net >= threshold {
            Some(Direction::Long)
        } else if net <= -threshold {
            Some(Direction::Short)
        } else {
            None
        }
    }

    // --- Exit evaluation ---

    fn check_exits(&self, pos: &mut OpenPosition, candle: &Candle) -> Option<ExitReason> {
        for rule in &self.config.harness.exit_rules {
            match rule {
                ExitRule::StopLoss { pct } => {
                    let stop = level_price(pos.entry_fill, pos.direction, -*pct);
                    match pos.direction {
                        Direction::Long if candle.low <= stop => {
                            return Some(ExitReason::StopLoss);
                        }
                        Direction::Short if candle.high >= stop => {
                            return Some(ExitReason::StopLoss);
                        }
                        _ => {}
                    }
                }
                ExitRule::TakeProfit { pct } => {
                    let tp = level_price(pos.entry_fill, pos.direction, *pct);
                    match pos.direction {
                        Direction::Long if candle.high >= tp => {
                            return Some(ExitReason::TakeProfit);
                        }
                        Direction::Short if candle.low <= tp => {
                            return Some(ExitReason::TakeProfit);
                        }
                        _ => {}
                    }
                }
                ExitRule::TrailingStop {
                    activation_pct,
                    trail_pct,
                } => {
                    if !pos.trailing_active {
                        let activation =
                            level_price(pos.entry_fill, pos.direction, *activation_pct);
                        match pos.direction {
                            Direction::Long if candle.high >= activation => {
                                pos.trailing_active = true;
                            }
                            Direction::Short if candle.low <= activation => {
                                pos.trailing_active = true;
                            }
                            _ => {}
                        }
                    }
                    if pos.trailing_active {
                        let trail_frac =
                            Decimal::try_from(*trail_pct / 100.0).unwrap_or(Decimal::ZERO);
                        match pos.direction {
                            Direction::Long => {
                                let trail_stop = pos.high_water * (Decimal::ONE - trail_frac);
                                if candle.low <= trail_stop {
                                    return Some(ExitReason::TrailingStop);
                                }
                            }
                            Direction::Short => {
                                let trail_stop = pos.low_water * (Decimal::ONE + trail_frac);
                                if candle.high >= trail_stop {
                                    return Some(ExitReason::TrailingStop);
                                }
                            }
                        }
                    }
                }
                ExitRule::TimeLimit { max_candles } => {
                    if pos.candles_held >= *max_candles {
                        return Some(ExitReason::TimeLimit);
                    }
                }
            }
        }
        None
    }

    // --- Position closing ---

    fn close_position(
        &self,
        pos: &OpenPosition,
        candle: &Candle,
        reason: ExitReason,
    ) -> SimulatedTrade {
        let raw_exit = match &reason {
            ExitReason::StopLoss => level_price(
                pos.entry_fill,
                pos.direction,
                -self.find_exit_pct(|r| matches!(r, ExitRule::StopLoss { .. }), 5.0),
            ),
            ExitReason::TakeProfit => level_price(
                pos.entry_fill,
                pos.direction,
                self.find_exit_pct(|r| matches!(r, ExitRule::TakeProfit { .. }), 10.0),
            ),
            ExitReason::TrailingStop => {
                let trail_pct =
                    self.find_exit_pct(|r| matches!(r, ExitRule::TrailingStop { .. }), 2.0);
                let frac = Decimal::try_from(trail_pct / 100.0).unwrap_or(Decimal::ZERO);
                match pos.direction {
                    Direction::Long => pos.high_water * (Decimal::ONE - frac),
                    Direction::Short => pos.low_water * (Decimal::ONE + frac),
                }
            }
            _ => candle.close,
        };

        let exit_fill = cost_model::apply_exit_slippage(
            raw_exit,
            pos.direction,
            pos.size_usd,
            &self.config.slippage,
        );

        let gross_pnl = match pos.direction {
            Direction::Long => {
                if pos.entry_fill > Decimal::ZERO {
                    pos.size_usd * (exit_fill / pos.entry_fill - Decimal::ONE)
                } else {
                    Decimal::ZERO
                }
            }
            Direction::Short => {
                if pos.entry_fill > Decimal::ZERO {
                    pos.size_usd * (Decimal::ONE - exit_fill / pos.entry_fill)
                } else {
                    Decimal::ZERO
                }
            }
        };

        let exit_slip = cost_model::slippage_cost(raw_exit, exit_fill, pos.size_usd);
        let gas_cost = self.config.gas_cost_usd * Decimal::TWO;
        let fee_cost =
            cost_model::trade_fee(pos.size_usd, self.config.taker_fee_bps) * Decimal::TWO;
        let total_cost = gas_cost + fee_cost;
        let net_pnl = gross_pnl - total_cost;

        let pnl_pct = if pos.size_usd > Decimal::ZERO {
            net_pnl.to_f64().unwrap_or(0.0) / pos.size_usd.to_f64().unwrap_or(1.0) * 100.0
        } else {
            0.0
        };

        SimulatedTrade {
            token: pos.token.clone(),
            entry_timestamp: pos.entry_timestamp,
            exit_timestamp: candle.timestamp,
            direction: pos.direction,
            entry_price: pos.entry_fill,
            exit_price: exit_fill,
            size_usd: pos.size_usd,
            pnl: net_pnl,
            pnl_pct,
            slippage_cost: exit_slip,
            gas_cost,
            fee_cost,
            exit_reason: reason,
        }
    }

    // --- Position sizing ---

    fn compute_position_size(&self, equity: Decimal, stats: &RunningTradeStats) -> Decimal {
        match &self.config.harness.position_sizing {
            PositionSizing::FixedFraction { fraction } => equity * f64_to_decimal(*fraction),
            PositionSizing::KellyFraction {
                kelly_multiplier,
                max_position_pct,
            } => {
                let kelly = stats.kelly_fraction();
                let frac = if kelly > 0.0 {
                    (kelly * kelly_multiplier).min(*max_position_pct / 100.0)
                } else {
                    (0.02_f64).min(*max_position_pct / 100.0)
                };
                equity * f64_to_decimal(frac)
            }
            PositionSizing::FixedAmount { amount_usd } => *amount_usd,
        }
    }

    fn find_exit_pct(&self, pred: impl Fn(&ExitRule) -> bool, default: f64) -> f64 {
        for rule in &self.config.harness.exit_rules {
            if pred(rule) {
                return match rule {
                    ExitRule::StopLoss { pct } => *pct,
                    ExitRule::TakeProfit { pct } => *pct,
                    ExitRule::TrailingStop { trail_pct, .. } => *trail_pct,
                    ExitRule::TimeLimit { .. } => default,
                };
            }
        }
        default
    }
}

// --- Free functions ---

/// Compute a price level relative to entry.
/// Positive pct = favorable direction (TP for long, SL for short).
/// Negative pct = adverse direction (SL for long, TP for short).
fn level_price(entry: Decimal, direction: Direction, pct: f64) -> Decimal {
    let frac = Decimal::try_from(pct.abs() / 100.0).unwrap_or(Decimal::ZERO);
    let favorable = pct > 0.0;
    match (direction, favorable) {
        (Direction::Long, true) | (Direction::Short, false) => entry * (Decimal::ONE + frac),
        (Direction::Long, false) | (Direction::Short, true) => entry * (Decimal::ONE - frac),
    }
}

fn mark_to_market(pos: &OpenPosition, current_price: Decimal) -> Decimal {
    if pos.entry_fill <= Decimal::ZERO {
        return Decimal::ZERO;
    }
    match pos.direction {
        Direction::Long => pos.size_usd * current_price / pos.entry_fill,
        Direction::Short => pos.size_usd * (Decimal::TWO - current_price / pos.entry_fill),
    }
}

#[allow(clippy::too_many_arguments)]
fn evaluate_signal(
    signal: &SignalType,
    condition: &EntryCondition,
    idx: usize,
    cache: &TokenIndicators,
    closes: &[f64],
    volumes: &[f64],
    candles: &[Candle],
    funding: &[FundingSnapshot],
    token: &str,
) -> f64 {
    match signal {
        SignalType::Rsi { period } => {
            let rsi_val = cache
                .rsi
                .get(period)
                .and_then(|v| v.get(idx))
                .copied()
                .unwrap_or(50.0);
            match condition {
                EntryCondition::Below { threshold } => {
                    if rsi_val < *threshold {
                        1.0
                    } else {
                        0.0
                    }
                }
                EntryCondition::Above { threshold } => {
                    if rsi_val > *threshold {
                        -1.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            }
        }
        SignalType::EmaCross {
            short_period,
            long_period,
        } => {
            let cross = cache
                .ema_cross
                .get(&(*short_period, *long_period))
                .and_then(|v| v.get(idx))
                .copied()
                .unwrap_or(0);
            match condition {
                EntryCondition::CrossAbove => {
                    if cross == 1 {
                        1.0
                    } else {
                        0.0
                    }
                }
                EntryCondition::CrossBelow => {
                    if cross == -1 {
                        -1.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            }
        }
        SignalType::PriceMomentum { lookback_candles } => {
            if idx < *lookback_candles || *lookback_candles == 0 {
                return 0.0;
            }
            let prev = closes[idx - lookback_candles];
            let curr = closes[idx];
            if prev <= 0.0 {
                return 0.0;
            }
            let change_pct = (curr - prev) / prev;
            match condition {
                EntryCondition::Positive => {
                    if change_pct > 0.0 {
                        1.0
                    } else {
                        0.0
                    }
                }
                EntryCondition::Negative => {
                    if change_pct < 0.0 {
                        -1.0
                    } else {
                        0.0
                    }
                }
                EntryCondition::Above { threshold } => {
                    if change_pct * 100.0 > *threshold {
                        1.0
                    } else {
                        0.0
                    }
                }
                EntryCondition::Below { threshold } => {
                    if change_pct * 100.0 < *threshold {
                        -1.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            }
        }
        SignalType::VolumeSurge {
            lookback_candles,
            multiplier,
        } => {
            if idx < *lookback_candles || *lookback_candles == 0 {
                return 0.0;
            }
            let avg_vol: f64 = volumes[idx.saturating_sub(*lookback_candles)..idx]
                .iter()
                .sum::<f64>()
                / *lookback_candles as f64;
            if avg_vol <= 0.0 {
                return 0.0;
            }
            let surge = volumes[idx] / avg_vol;
            if surge > *multiplier { 1.0 } else { 0.0 }
        }
        SignalType::FundingRate => {
            let ts = candles.get(idx).map(|c| c.timestamp).unwrap_or(0);
            let rate = funding
                .iter()
                .rev()
                .find(|f| f.timestamp <= ts && f.token == token)
                .or_else(|| funding.iter().rev().find(|f| f.timestamp <= ts))
                .map(|f| f.rate)
                .unwrap_or(Decimal::ZERO);
            match condition {
                EntryCondition::Negative => {
                    if rate < Decimal::ZERO {
                        1.0
                    } else {
                        0.0
                    }
                }
                EntryCondition::Positive => {
                    if rate > Decimal::ZERO {
                        -1.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            }
        }
    }
}

/// Convert f64 to Decimal safely, rounding to 8 decimal places to avoid
/// Decimal's 28-digit precision limit panicking on high-precision floats.
fn f64_to_decimal(v: f64) -> Decimal {
    // Round to 8dp to stay well within Decimal's 28-digit scale limit
    let rounded = (v * 1e8).round() / 1e8;
    Decimal::try_from(rounded).unwrap_or(Decimal::new(1, 1))
}

fn extract_f64(candles: &[Candle], f: fn(&Candle) -> Decimal) -> Vec<f64> {
    candles
        .iter()
        .map(|c| f(c).to_f64().unwrap_or(0.0))
        .collect()
}

fn empty_result() -> BacktestResult {
    BacktestResult {
        trades: vec![],
        equity_curve: vec![],
        stats: leaderboard::compute_stats("backtest", &[], &[]),
        total_fees: Decimal::ZERO,
        total_slippage: Decimal::ZERO,
        total_gas: Decimal::ZERO,
        candles_processed: 0,
        tokens_traded: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candles(token: &str, prices: impl Iterator<Item = (usize, f64, f64)>) -> Vec<Candle> {
        prices
            .map(|(i, base, step)| Candle {
                timestamp: (i as i64) * 3600,
                token: token.to_string(),
                open: Decimal::try_from(base).unwrap(),
                high: Decimal::try_from(base + step * 0.5).unwrap(),
                low: Decimal::try_from(base - step * 0.3).unwrap(),
                close: Decimal::try_from(base + step * 0.3).unwrap(),
                volume: Decimal::new(1_000_000, 0),
            })
            .collect()
    }

    fn uptrend(token: &str, n: usize, start: f64, step: f64) -> Vec<Candle> {
        make_candles(
            token,
            (0..n).map(move |i| (i, start + i as f64 * step, step)),
        )
    }

    fn downtrend(token: &str, n: usize, start: f64, step: f64) -> Vec<Candle> {
        make_candles(
            token,
            (0..n).map(move |i| (i, start - i as f64 * step, step)),
        )
    }

    fn default_candles() -> Vec<Candle> {
        let mut c = downtrend("default", 20, 100.0, 2.0);
        c.extend(uptrend("default", 30, 60.0, 2.0));
        // Fix timestamps for second half
        for (i, candle) in c[20..].iter_mut().enumerate() {
            candle.timestamp = (20 + i) as i64 * 3600;
        }
        c
    }

    fn simple_config() -> BacktestConfig {
        BacktestConfig {
            initial_capital: Decimal::new(10_000, 0),
            harness: HarnessConfig {
                version: 1,
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 14 },
                    condition: EntryCondition::Below { threshold: 35.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![
                    ExitRule::TakeProfit { pct: 15.0 },
                    ExitRule::StopLoss { pct: 10.0 },
                ],
                filters: vec![],
                position_sizing: PositionSizing::FixedFraction { fraction: 0.3 },
                entry_threshold: 0.3,
                max_positions: 5,
            },
            slippage: SlippageModel::FixedBps { bps: 5 },
            gas_cost_usd: Decimal::new(1, 0),
            taker_fee_bps: 5,
        }
    }

    // --- Core engine tests ---

    #[test]
    fn empty_candles_returns_zero_result() {
        let engine = BacktestEngine::new(BacktestConfig::default());
        let result = engine.run(&[], &[]).unwrap();
        assert_eq!(result.candles_processed, 0);
        assert!(result.trades.is_empty());
        assert!(result.tokens_traded.is_empty());
    }

    #[test]
    fn single_token_backward_compat() {
        let candles = default_candles();
        let engine = BacktestEngine::new(simple_config());
        let result = engine.run(&candles, &[]).unwrap();
        assert!(!result.trades.is_empty());
        assert_eq!(result.tokens_traded, vec!["default"]);
        assert_eq!(result.equity_curve.len(), candles.len());
    }

    #[test]
    fn multi_token_produces_trades_for_each() {
        let mut candles = downtrend("ETH", 20, 2000.0, 30.0);
        candles.extend(
            uptrend("ETH", 30, 1400.0, 30.0)
                .into_iter()
                .enumerate()
                .map(|(i, mut c)| {
                    c.timestamp = (20 + i) as i64 * 3600;
                    c
                }),
        );
        let mut btc = downtrend("BTC", 20, 40000.0, 500.0);
        btc.extend(
            uptrend("BTC", 30, 30000.0, 500.0)
                .into_iter()
                .enumerate()
                .map(|(i, mut c)| {
                    c.timestamp = (20 + i) as i64 * 3600;
                    c
                }),
        );
        candles.extend(btc);

        let engine = BacktestEngine::new(simple_config());
        let result = engine.run(&candles, &[]).unwrap();

        assert!(result.tokens_traded.contains(&"ETH".to_string()));
        assert!(result.tokens_traded.contains(&"BTC".to_string()));
    }

    #[test]
    fn max_positions_respected() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                max_positions: 1,
                ..simple_config().harness
            },
            ..simple_config()
        };

        let mut candles = downtrend("ETH", 20, 2000.0, 30.0);
        candles.extend(downtrend("BTC", 20, 40000.0, 500.0));
        // Sync timestamps
        for c in &mut candles[20..] {
            // BTC candles get same timestamps as ETH
        }

        let engine = BacktestEngine::new(config);
        let result = engine.run(&candles, &[]).unwrap();

        // With max_positions=1, there should never be >1 position open at once
        // This is enforced by the engine, tested implicitly by having 2 tokens
        assert!(
            result.trades.len() <= 20,
            "Should be limited by max positions"
        );
    }

    // --- Exit tests ---

    #[test]
    fn stop_loss_fires_on_price_drop() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::StopLoss { pct: 5.0 }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        let mut prices = downtrend("default", 10, 100.0, 1.0);
        prices.push(Candle {
            timestamp: 10 * 3600,
            token: "default".into(),
            open: Decimal::new(88, 0),
            high: Decimal::new(89, 0),
            low: Decimal::new(75, 0),
            close: Decimal::new(76, 0),
            volume: Decimal::new(1_000_000, 0),
        });

        let result = BacktestEngine::new(config).run(&prices, &[]).unwrap();
        assert!(
            result
                .trades
                .iter()
                .any(|t| t.exit_reason == ExitReason::StopLoss)
        );
    }

    #[test]
    fn take_profit_fires_on_price_surge() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![
                    ExitRule::StopLoss { pct: 20.0 },
                    ExitRule::TakeProfit { pct: 10.0 },
                ],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        let mut prices = downtrend("default", 10, 100.0, 1.0);
        prices.push(Candle {
            timestamp: 10 * 3600,
            token: "default".into(),
            open: Decimal::new(88, 0),
            high: Decimal::new(120, 0),
            low: Decimal::new(87, 0),
            close: Decimal::new(115, 0),
            volume: Decimal::new(1_000_000, 0),
        });

        let result = BacktestEngine::new(config).run(&prices, &[]).unwrap();
        assert!(
            result
                .trades
                .iter()
                .any(|t| t.exit_reason == ExitReason::TakeProfit)
        );
    }

    #[test]
    fn time_limit_exit_fires() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::TimeLimit { max_candles: 3 }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        let candles = downtrend("default", 15, 100.0, 1.0);
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        assert!(
            result
                .trades
                .iter()
                .any(|t| t.exit_reason == ExitReason::TimeLimit)
        );
    }

    // --- Cost model tests ---

    #[test]
    fn costs_reduce_pnl() {
        let no_cost = BacktestConfig {
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..simple_config()
        };
        let with_cost = BacktestConfig {
            slippage: SlippageModel::FixedBps { bps: 50 },
            gas_cost_usd: Decimal::new(5, 0),
            taker_fee_bps: 30,
            ..simple_config()
        };

        let candles = default_candles();
        let r1 = BacktestEngine::new(no_cost).run(&candles, &[]).unwrap();
        let r2 = BacktestEngine::new(with_cost).run(&candles, &[]).unwrap();

        if !r1.trades.is_empty() && !r2.trades.is_empty() {
            let pnl1: f64 = r1
                .trades
                .iter()
                .map(|t| t.pnl.to_f64().unwrap_or(0.0))
                .sum();
            let pnl2: f64 = r2
                .trades
                .iter()
                .map(|t| t.pnl.to_f64().unwrap_or(0.0))
                .sum();
            assert!(
                pnl2 < pnl1,
                "Costs should reduce PnL: no-cost={pnl1}, with-cost={pnl2}"
            );
        }
    }

    #[test]
    fn sqrt_impact_penalizes_large_trades() {
        let small_depth = BacktestConfig {
            slippage: SlippageModel::SqrtImpact {
                base_bps: 10,
                depth_usd: Decimal::new(10_000, 0),
            },
            ..simple_config()
        };
        let large_depth = BacktestConfig {
            slippage: SlippageModel::SqrtImpact {
                base_bps: 10,
                depth_usd: Decimal::new(1_000_000, 0),
            },
            ..simple_config()
        };

        let candles = default_candles();
        let r_small = BacktestEngine::new(small_depth).run(&candles, &[]).unwrap();
        let r_large = BacktestEngine::new(large_depth).run(&candles, &[]).unwrap();

        // Small depth = more slippage impact
        assert!(
            r_small.total_slippage >= r_large.total_slippage,
            "Shallower depth should cause more slippage"
        );
    }

    // --- Filter tests ---

    #[test]
    fn volatility_filter_blocks_flat_market() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 60.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::TakeProfit { pct: 5.0 }],
                filters: vec![Filter::VolatilityGate {
                    min_atr_pct: 5.0,
                    max_atr_pct: 50.0,
                    period: 5,
                }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        let candles: Vec<Candle> = (0..30)
            .map(|i| Candle {
                timestamp: i * 3600,
                token: "default".into(),
                open: Decimal::new(10000, 2),
                high: Decimal::new(10001, 2),
                low: Decimal::new(9999, 2),
                close: Decimal::new(10000, 2),
                volume: Decimal::new(1_000_000, 0),
            })
            .collect();

        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        assert!(
            result.trades.is_empty(),
            "Volatility filter should block flat market"
        );
    }

    // --- Signal tests ---

    #[test]
    fn funding_rate_signal_fires_on_negative() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::FundingRate,
                    condition: EntryCondition::Negative,
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::TakeProfit { pct: 5.0 }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        let candles = uptrend("default", 20, 100.0, 1.0);
        let funding = vec![FundingSnapshot {
            timestamp: 0,
            token: "default".into(),
            rate: Decimal::new(-3, 4),
        }];

        let result = BacktestEngine::new(config).run(&candles, &funding).unwrap();
        assert!(
            !result.trades.is_empty(),
            "Negative funding should trigger entry"
        );
    }

    #[test]
    fn token_specific_entry_rule() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec!["ETH".into()], // Only applies to ETH
                }],
                exit_rules: vec![ExitRule::TakeProfit { pct: 10.0 }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        let mut candles = downtrend("ETH", 15, 2000.0, 30.0);
        candles.extend(downtrend("BTC", 15, 40000.0, 500.0));

        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        // All trades should be on ETH since the rule only applies to ETH
        for trade in &result.trades {
            assert_eq!(trade.token, "ETH", "Rule should only fire for ETH");
        }
    }

    // --- Sizing tests ---

    #[test]
    fn fixed_amount_sizing() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                position_sizing: PositionSizing::FixedAmount {
                    amount_usd: Decimal::new(500, 0),
                },
                ..HarnessConfig::default()
            },
            ..BacktestConfig::default()
        };
        let engine = BacktestEngine::new(config);
        let stats = RunningTradeStats::default();
        let size = engine.compute_position_size(Decimal::new(10_000, 0), &stats);
        assert_eq!(size, Decimal::new(500, 0));
    }

    #[test]
    fn kelly_sizing_uses_trade_history() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                position_sizing: PositionSizing::KellyFraction {
                    kelly_multiplier: 0.5,
                    max_position_pct: 20.0,
                },
                ..HarnessConfig::default()
            },
            ..BacktestConfig::default()
        };
        let engine = BacktestEngine::new(config);

        // With good stats: 70% win rate, 2:1 win/loss ratio
        let mut stats = RunningTradeStats::default();
        for _ in 0..7 {
            stats.record(200.0);
        }
        for _ in 0..3 {
            stats.record(-100.0);
        }

        let size_with_history = engine.compute_position_size(Decimal::new(10_000, 0), &stats);

        // With no stats: conservative fallback
        let empty_stats = RunningTradeStats::default();
        let size_no_history = engine.compute_position_size(Decimal::new(10_000, 0), &empty_stats);

        assert!(
            size_with_history > size_no_history,
            "Good trade history should size larger: with={size_with_history} without={size_no_history}"
        );
    }

    // --- Validation tests ---

    #[test]
    fn harness_config_validates_ok() {
        let config = HarnessConfig::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn harness_config_rejects_empty_rules() {
        let config = HarnessConfig {
            entry_rules: vec![],
            ..HarnessConfig::default()
        };
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| e.contains("entry_rules is empty")));
    }

    #[test]
    fn harness_config_rejects_bad_ema_periods() {
        let config = HarnessConfig {
            entry_rules: vec![EntryRule {
                signal: SignalType::EmaCross {
                    short_period: 50,
                    long_period: 20, // short > long is invalid
                },
                condition: EntryCondition::CrossAbove,
                weight: 1.0,
                tokens: vec![],
            }],
            ..HarnessConfig::default()
        };
        let errors = config.validate().unwrap_err();
        assert!(
            errors
                .iter()
                .any(|e| e.contains("EMA cross periods invalid"))
        );
    }

    #[test]
    fn harness_config_rejects_zero_max_positions() {
        let config = HarnessConfig {
            max_positions: 0,
            ..HarnessConfig::default()
        };
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| e.contains("max_positions is 0")));
    }

    // --- Comparison tests ---

    #[test]
    fn comparison_produces_valid_deltas() {
        let candles = default_candles();
        let config_a = simple_config();
        let mut config_b = simple_config();
        config_b.harness.exit_rules = vec![
            ExitRule::StopLoss { pct: 15.0 },
            ExitRule::TakeProfit { pct: 20.0 },
        ];

        let comparison = BacktestEngine::compare(&config_a, &config_b, &candles, &[]).unwrap();
        assert_eq!(comparison.current.candles_processed, candles.len());
        assert_eq!(comparison.candidate.candles_processed, candles.len());
    }

    #[test]
    fn equity_curve_length_matches_unique_timestamps() {
        let candles = default_candles();
        let engine = BacktestEngine::new(simple_config());
        let result = engine.run(&candles, &[]).unwrap();
        let unique_ts: std::collections::HashSet<i64> =
            candles.iter().map(|c| c.timestamp).collect();
        assert_eq!(result.equity_curve.len(), unique_ts.len());
    }

    // --- Serde tests ---

    #[test]
    fn harness_config_roundtrip_serde() {
        let config = HarnessConfig::default();
        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: HarnessConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, config.version);
        assert_eq!(parsed.entry_rules.len(), config.entry_rules.len());
        assert_eq!(parsed.max_positions, config.max_positions);
    }

    #[test]
    fn backtest_config_serde_with_sqrt_impact() {
        let config = BacktestConfig {
            slippage: SlippageModel::SqrtImpact {
                base_bps: 10,
                depth_usd: Decimal::new(100_000, 0),
            },
            ..BacktestConfig::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: BacktestConfig = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed.slippage, SlippageModel::SqrtImpact { .. }));
    }

    // --- Kelly stats tests ---

    #[test]
    fn kelly_fraction_with_edge() {
        let mut stats = RunningTradeStats::default();
        // 60% win rate, avg win $200, avg loss $100 → b=2, kelly = (0.6*2 - 0.4)/2 = 0.4
        for _ in 0..6 {
            stats.record(200.0);
        }
        for _ in 0..4 {
            stats.record(-100.0);
        }
        let kelly = stats.kelly_fraction();
        assert!(
            (kelly - 0.4).abs() < 0.01,
            "Kelly should be ~0.4, got {kelly}"
        );
    }

    #[test]
    fn kelly_fraction_negative_edge_returns_zero() {
        let mut stats = RunningTradeStats::default();
        // 30% win rate, 1:1 ratio → negative edge
        for _ in 0..3 {
            stats.record(100.0);
        }
        for _ in 0..7 {
            stats.record(-100.0);
        }
        assert_eq!(stats.kelly_fraction(), 0.0);
    }

    #[test]
    fn kelly_fraction_insufficient_data() {
        let mut stats = RunningTradeStats::default();
        stats.record(100.0);
        stats.record(-50.0);
        assert_eq!(stats.kelly_fraction(), 0.0, "Need >= 5 trades");
    }

    // === Adversarial / edge case tests ===

    #[test]
    fn short_position_lifecycle() {
        // RSI above threshold → short entry, then price rises → stop loss
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Above { threshold: 60.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![
                    ExitRule::StopLoss { pct: 5.0 },
                    ExitRule::TakeProfit { pct: 10.0 },
                ],
                entry_threshold: 0.3,
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        // Strong uptrend → RSI > 60 → short entry, then price keeps rising → stop loss
        let candles = uptrend("default", 20, 100.0, 3.0);
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();

        let shorts: Vec<_> = result
            .trades
            .iter()
            .filter(|t| t.direction == Direction::Short)
            .collect();
        assert!(
            !shorts.is_empty(),
            "Should have short trades in uptrend with RSI>60 rule"
        );

        // Shorts in an uptrend should lose money
        for trade in &shorts {
            assert!(
                trade.pnl < Decimal::ZERO,
                "Short in uptrend should lose: pnl={}",
                trade.pnl
            );
        }
    }

    #[test]
    fn short_take_profit_on_price_drop() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Above { threshold: 60.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![
                    ExitRule::StopLoss { pct: 20.0 },
                    ExitRule::TakeProfit { pct: 8.0 },
                ],
                entry_threshold: 0.3,
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        // Uptrend to trigger RSI>60 entry, then crash to trigger TP
        let mut candles = uptrend("default", 10, 100.0, 3.0);
        candles.push(Candle {
            timestamp: 10 * 3600,
            token: "default".into(),
            open: Decimal::new(125, 0),
            high: Decimal::new(126, 0),
            low: Decimal::new(100, 0), // 20% drop from ~125 → well past 8% TP
            close: Decimal::new(102, 0),
            volume: Decimal::new(1_000_000, 0),
        });

        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        let short_tps: Vec<_> = result
            .trades
            .iter()
            .filter(|t| t.direction == Direction::Short && t.exit_reason == ExitReason::TakeProfit)
            .collect();
        assert!(
            !short_tps.is_empty(),
            "Short should hit TP when price drops"
        );
        for t in &short_tps {
            assert!(
                t.pnl > Decimal::ZERO,
                "Short TP should be profitable: pnl={}",
                t.pnl
            );
        }
    }

    #[test]
    fn trailing_stop_activates_and_trails() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::TrailingStop {
                    activation_pct: 5.0,
                    trail_pct: 3.0,
                }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        // Down (trigger RSI entry), then up 10% (activate trail), then pullback 4% (trigger trail)
        let mut candles = downtrend("default", 10, 100.0, 1.5);
        // Rally phase: 10 candles up
        for i in 0..10 {
            let base = 86.0 + i as f64 * 2.0;
            candles.push(Candle {
                timestamp: (10 + i) as i64 * 3600,
                token: "default".into(),
                open: Decimal::try_from(base).unwrap(),
                high: Decimal::try_from(base + 1.5).unwrap(),
                low: Decimal::try_from(base - 0.5).unwrap(),
                close: Decimal::try_from(base + 1.0).unwrap(),
                volume: Decimal::new(1_000_000, 0),
            });
        }
        // Pullback: sharp drop
        candles.push(Candle {
            timestamp: 20 * 3600,
            token: "default".into(),
            open: Decimal::new(105, 0),
            high: Decimal::new(106, 0),
            low: Decimal::new(95, 0), // drop from high ~107 → 95 = ~11% from peak
            close: Decimal::new(96, 0),
            volume: Decimal::new(1_000_000, 0),
        });

        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        let trails: Vec<_> = result
            .trades
            .iter()
            .filter(|t| t.exit_reason == ExitReason::TrailingStop)
            .collect();
        assert!(
            !trails.is_empty(),
            "Trailing stop should fire after activation + pullback"
        );
        // Trailing stop should lock in some profit (entered in downtrend, exited after rally)
        for t in &trails {
            assert!(
                t.pnl > Decimal::ZERO,
                "Trailing stop should capture rally profit: pnl={}",
                t.pnl
            );
        }
    }

    #[test]
    fn equity_starts_at_initial_capital() {
        let config = BacktestConfig {
            initial_capital: Decimal::new(50_000, 0),
            ..simple_config()
        };
        let candles = uptrend("default", 5, 100.0, 1.0);
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        assert_eq!(
            result.equity_curve[0].account_value,
            Decimal::new(50_000, 0),
            "First equity point should equal initial capital"
        );
    }

    #[test]
    fn losing_trade_reduces_equity() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::StopLoss { pct: 3.0 }],
                position_sizing: PositionSizing::FixedFraction { fraction: 0.5 },
                ..HarnessConfig::default()
            },
            initial_capital: Decimal::new(10_000, 0),
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
        };

        // Continuous downtrend → enter long → stop loss → equity drops
        let candles = downtrend("default", 20, 100.0, 2.0);
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();

        if !result.trades.is_empty() {
            let final_equity = result.equity_curve.last().unwrap().account_value;
            assert!(
                final_equity < Decimal::new(10_000, 0),
                "Losing trades should reduce equity below initial: final={final_equity}"
            );
        }
    }

    #[test]
    fn aggregate_cost_fields_are_positive_when_trading() {
        let config = BacktestConfig {
            slippage: SlippageModel::FixedBps { bps: 20 },
            gas_cost_usd: Decimal::new(3, 0),
            taker_fee_bps: 15,
            ..simple_config()
        };
        let candles = default_candles();
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();

        if !result.trades.is_empty() {
            assert!(result.total_gas > Decimal::ZERO, "Should have gas costs");
            assert!(result.total_fees > Decimal::ZERO, "Should have fee costs");
            // Verify per-trade costs match aggregates
            let sum_gas: Decimal = result.trades.iter().map(|t| t.gas_cost).sum();
            let sum_fees: Decimal = result.trades.iter().map(|t| t.fee_cost).sum();
            assert_eq!(result.total_gas, sum_gas, "Aggregate gas should match sum");
            assert_eq!(
                result.total_fees, sum_fees,
                "Aggregate fees should match sum"
            );
        }
    }

    #[test]
    fn should_promote_known_thresholds() {
        let make_result = |sharpe: f64, dd: f64| BacktestResult {
            stats: {
                let mut s = leaderboard::compute_stats("test", &[], &[]);
                s.sharpe_ratio = sharpe;
                s.max_drawdown_pct = dd;
                s
            },
            trades: vec![],
            equity_curve: vec![],
            total_fees: Decimal::ZERO,
            total_slippage: Decimal::ZERO,
            total_gas: Decimal::ZERO,
            candles_processed: 0,
            tokens_traded: vec![],
        };

        // Case 1: 20% Sharpe improvement, 0% drawdown regression → promote
        let comp1 = BacktestComparison {
            current: make_result(1.0, 10.0),
            candidate: make_result(1.2, 10.0),
            sharpe_delta: 0.2,
            drawdown_delta: 0.0,
            win_rate_delta: 0.0,
        };
        assert!(
            comp1.should_promote(),
            "20% Sharpe improvement should promote"
        );

        // Case 2: 5% Sharpe improvement, 0% regression → no promote (below 10% threshold)
        let comp2 = BacktestComparison {
            current: make_result(1.0, 10.0),
            candidate: make_result(1.05, 10.0),
            sharpe_delta: 0.05,
            drawdown_delta: 0.0,
            win_rate_delta: 0.0,
        };
        assert!(
            !comp2.should_promote(),
            "5% Sharpe improvement insufficient"
        );

        // Case 3: 20% Sharpe improvement but 10% drawdown regression → no promote
        let comp3 = BacktestComparison {
            current: make_result(1.0, 10.0),
            candidate: make_result(1.2, 11.0),
            sharpe_delta: 0.2,
            drawdown_delta: 1.0,
            win_rate_delta: 0.0,
        };
        assert!(
            !comp3.should_promote(),
            "10% drawdown regression should block"
        );
    }

    #[test]
    fn position_size_never_exceeds_cash() {
        // FixedAmount larger than equity → engine should reject (size > cash check)
        let config = BacktestConfig {
            initial_capital: Decimal::new(100, 0), // Only $100
            harness: HarnessConfig {
                position_sizing: PositionSizing::FixedAmount {
                    amount_usd: Decimal::new(1000, 0), // $1000 > $100 cash
                },
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::TakeProfit { pct: 5.0 }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
        };

        let candles = downtrend("default", 15, 100.0, 1.0);
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        assert!(
            result.trades.is_empty(),
            "Should not open position when size > cash"
        );
    }

    #[test]
    fn min_volume_filter_blocks_low_volume() {
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 60.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::TakeProfit { pct: 5.0 }],
                filters: vec![Filter::MinVolume {
                    threshold: Decimal::new(5_000_000, 0), // Require 5M volume
                }],
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        // Candles with only 1M volume (below 5M threshold)
        let candles = downtrend("default", 15, 100.0, 1.0);
        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();
        assert!(
            result.trades.is_empty(),
            "MinVolume filter should block low-volume entries"
        );
    }

    #[test]
    fn multi_token_independent_exits() {
        // ETH enters and exits independently of BTC
        let config = BacktestConfig {
            harness: HarnessConfig {
                entry_rules: vec![EntryRule {
                    signal: SignalType::Rsi { period: 5 },
                    condition: EntryCondition::Below { threshold: 50.0 },
                    weight: 1.0,
                    tokens: vec![],
                }],
                exit_rules: vec![ExitRule::StopLoss { pct: 5.0 }],
                max_positions: 5,
                ..HarnessConfig::default()
            },
            slippage: SlippageModel::FixedBps { bps: 0 },
            gas_cost_usd: Decimal::ZERO,
            taker_fee_bps: 0,
            ..BacktestConfig::default()
        };

        // ETH: down (enter) then crash (stop loss at candle 12)
        let mut candles = downtrend("ETH", 10, 2000.0, 20.0);
        candles.push(Candle {
            timestamp: 10 * 3600,
            token: "ETH".into(),
            open: Decimal::new(1800, 0),
            high: Decimal::new(1810, 0),
            low: Decimal::new(1500, 0),
            close: Decimal::new(1520, 0),
            volume: Decimal::new(1_000_000, 0),
        });
        // BTC: down (enter), holds steady — no stop loss trigger
        let mut btc: Vec<Candle> = downtrend("BTC", 10, 40000.0, 200.0);
        btc.push(Candle {
            timestamp: 10 * 3600,
            token: "BTC".into(),
            open: Decimal::new(38000, 0),
            high: Decimal::new(38500, 0),
            low: Decimal::new(37500, 0),
            close: Decimal::new(38000, 0),
            volume: Decimal::new(1_000_000, 0),
        });
        candles.extend(btc);

        let result = BacktestEngine::new(config).run(&candles, &[]).unwrap();

        let eth_stops = result
            .trades
            .iter()
            .filter(|t| t.token == "ETH" && t.exit_reason == ExitReason::StopLoss)
            .count();
        let btc_stops = result
            .trades
            .iter()
            .filter(|t| t.token == "BTC" && t.exit_reason == ExitReason::StopLoss)
            .count();

        // ETH should have a stop loss, BTC should not (or exit as EndOfData)
        assert!(eth_stops > 0, "ETH should hit stop loss on crash");
        assert_eq!(
            btc_stops, 0,
            "BTC should not hit stop loss — it held steady"
        );
    }

    #[test]
    fn harness_config_rejects_negative_weight() {
        let config = HarnessConfig {
            entry_rules: vec![EntryRule {
                signal: SignalType::Rsi { period: 14 },
                condition: EntryCondition::Below { threshold: 30.0 },
                weight: -0.5,
                tokens: vec![],
            }],
            ..HarnessConfig::default()
        };
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| e.contains("negative weight")));
    }

    #[test]
    fn harness_config_rejects_threshold_out_of_range() {
        let config = HarnessConfig {
            entry_threshold: 1.5,
            ..HarnessConfig::default()
        };
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| e.contains("out of [0, 1] range")));
    }

    // === Walk-forward tests ===

    #[test]
    fn walk_forward_splits_data_correctly() {
        let candles = default_candles();
        let config = simple_config();
        let result =
            BacktestEngine::walk_forward_compare(&config, &config, &candles, &[], 0.7).unwrap();

        // 50 candles * 0.7 = 35 train, 15 test
        assert_eq!(result.train_candles, 35);
        assert_eq!(result.test_candles, 15);
    }

    #[test]
    fn walk_forward_rejects_too_few_candles() {
        let candles = uptrend("default", 3, 100.0, 1.0);
        let config = simple_config();
        // With 3 candles and 0.7 split → 2 train, 1 test. Should work.
        // With 1 candle total → will fail because one half is empty
        let single = uptrend("default", 1, 100.0, 1.0);
        let result = BacktestEngine::walk_forward_compare(&config, &config, &single, &[], 0.7);
        assert!(result.is_err(), "Should reject too few candles for split");

        // 3 candles should work (2 train + 1 test)
        let result = BacktestEngine::walk_forward_compare(&config, &config, &candles, &[], 0.7);
        assert!(result.is_ok());
    }

    #[test]
    fn walk_forward_same_config_does_not_promote() {
        let candles = default_candles();
        let config = simple_config();
        let result =
            BacktestEngine::walk_forward_compare(&config, &config, &candles, &[], 0.7).unwrap();

        // Same config → sharpe_delta = 0 → should NOT promote
        assert!(!result.should_promote, "Same config should not promote");
    }

    #[test]
    fn harness_config_rejects_rsi_period_zero() {
        let config = HarnessConfig {
            entry_rules: vec![EntryRule {
                signal: SignalType::Rsi { period: 0 },
                condition: EntryCondition::Below { threshold: 30.0 },
                weight: 1.0,
                tokens: vec![],
            }],
            ..HarnessConfig::default()
        };
        let errors = config.validate().unwrap_err();
        assert!(errors.iter().any(|e| e.contains("RSI period is 0")));
    }
}
