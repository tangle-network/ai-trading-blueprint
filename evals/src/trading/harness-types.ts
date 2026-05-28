/**
 * Canonical TypeScript surface for the `HarnessConfig` strategy genome —
 * kept in sync with the Rust schema in `trading-runtime::backtest::types`.
 *
 * One source of truth for every consumer in this repo:
 *   - the developer evaluation loop (`harness-self-improve.ts`)
 *   - the per-bot runtime loop (`per-bot-self-improve.ts`)
 *   - the Rust cell-level CLI (`trading-runtime/examples/harness_backtest.rs`)
 *     reads this exact JSON shape on stdin.
 *
 * The Rust enums use internally-tagged JSON (`#[serde(tag = "type", …)]`),
 * which is why every variant carries an explicit `type` discriminator.
 */

export interface HarnessConfig {
  version: number
  entry_rules: EntryRule[]
  exit_rules: ExitRule[]
  filters: unknown[]
  position_sizing: PositionSizing
  entry_threshold: number
  max_positions: number
}

export interface EntryRule {
  signal: SignalType
  condition: EntryCondition
  weight: number
  tokens: string[]
}

export type SignalType =
  | { type: 'rsi'; period: number }
  | { type: 'ema_cross'; short_period: number; long_period: number }
  | { type: 'sma_cross'; short_period: number; long_period: number }
  | { type: 'price_momentum'; lookback_candles: number }
  | { type: 'atr_breakout'; period: number; multiplier: number }
  | { type: 'mean_reversion'; lookback_candles: number; z_score_threshold: number }
  | { type: 'macd'; fast_period: number; slow_period: number; signal_period: number }
  | { type: 'bollinger_band'; period: number; std_dev: number }

export type Filter =
  | { type: 'volatility_gate'; min_atr_pct: number; max_atr_pct: number; period: number }
  | { type: 'time_filter'; skip_hours: number[] }
  | { type: 'min_volume'; threshold: string }

/** A candle row, wire-shape-compatible with the Rust `Candle` struct.
 *  Decimals are JSON strings (rust_decimal's default serde wire format). */
export interface Candle {
  timestamp: number
  token: string
  open: string
  high: string
  low: string
  close: string
  volume: string
}

/** A funding-rate sample, wire-compatible with Rust `FundingSnapshot`. */
export interface FundingSnapshot {
  timestamp: number
  token: string
  rate: string
}

export type EntryCondition =
  | { type: 'below'; threshold: number }
  | { type: 'above'; threshold: number }
  | { type: 'cross_above' }
  | { type: 'cross_below' }
  | { type: 'positive' }
  | { type: 'negative' }

export type ExitRule =
  | { type: 'stop_loss'; pct: number }
  | { type: 'take_profit'; pct: number }
  | { type: 'trailing_stop'; activation_pct: number; trail_pct: number }
  | { type: 'time_limit'; max_candles: number }

export type PositionSizing =
  | { method: 'fixed_fraction'; fraction: number }
  | { method: 'fixed_amount_usd'; amount: number }
  | { method: 'kelly_fraction'; fraction: number }

/** Conservative balanced-momentum baseline — the genome every loop starts
 *  from when no prior `HarnessConfig` is known. */
export const BASELINE_HARNESS: HarnessConfig = {
  version: 1,
  entry_rules: [
    { signal: { type: 'rsi', period: 14 }, condition: { type: 'below', threshold: 30 }, weight: 0.5, tokens: [] },
    { signal: { type: 'ema_cross', short_period: 12, long_period: 26 }, condition: { type: 'cross_above' }, weight: 0.5, tokens: [] },
  ],
  exit_rules: [{ type: 'stop_loss', pct: 5 }, { type: 'take_profit', pct: 10 }],
  filters: [],
  position_sizing: { method: 'fixed_fraction', fraction: 0.1 },
  entry_threshold: 0.3,
  max_positions: 5,
}

/** Per-bot context the Rust `harness_backtest` CLI needs: source venue +
 *  symbol + fee-schedule label + candle window. Identical across both the
 *  developer and the per-bot loops. */
export interface BotContext {
  id: string
  source: 'hyperliquid' | 'binance' | 'coinbase' | 'drift' | 'polymarket' | 'geckoterminal'
  symbol: string
  fee_protocol: string
  venue_label: string
}

/** What `harness_backtest` produces per (harness, bot) cell. */
export interface BacktestArtifact {
  sharpe: number
  sharpe_ci_lo: number | null
  sharpe_ci_hi: number | null
  sortino: number
  calmar: number
  max_drawdown_pct: number
  n_trades: number
  win_rate_pct: number
  total_return_pct: number
  total_fees_usd: number
  total_slippage_usd: number
  total_gas_usd: number
  candles_processed: number
  oos_sharpe_70_30: number
  oos_n_trades: number
  in_sample_sharpe: number
  is_oos_gap: number
}
