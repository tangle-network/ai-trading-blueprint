/**
 * Persona-suite HarnessConfig constructors — direct ports of the four
 * helpers that previously lived in `agent_personas.rs` (`default_harness`,
 * `momentum_harness`, `mean_reversion_harness`, `rsi_ema_harness`).
 */

import { BASELINE_HARNESS, type HarnessConfig } from '../harness-types.js'

const MIN_VOLUME_THRESHOLD = '100' // Decimal-as-string, matches Rust `dec(100)`

/** The canonical balanced-momentum starter — RSI<30 plus EMA(12,26) cross. */
export function defaultHarness(): HarnessConfig {
  return BASELINE_HARNESS
}

/** Price-momentum harness used by ~7 of the persona scenarios. */
export function momentumHarness(fraction: number, stopLoss: number, takeProfit: number): HarnessConfig {
  return {
    version: 1,
    entry_rules: [
      {
        signal: { type: 'price_momentum', lookback_candles: 6 },
        condition: { type: 'positive' },
        weight: 1.0,
        tokens: [],
      },
    ],
    exit_rules: [
      { type: 'stop_loss', pct: stopLoss },
      { type: 'take_profit', pct: takeProfit },
      { type: 'time_limit', max_candles: 24 },
    ],
    filters: [{ type: 'min_volume', threshold: MIN_VOLUME_THRESHOLD }],
    position_sizing: { method: 'fixed_fraction', fraction },
    entry_threshold: 0.6,
    max_positions: 3,
  }
}

/** Mean-reversion harness used by two scenarios that fade flow. */
export function meanReversionHarness(
  fraction: number,
  lookbackCandles: number,
  zScoreThreshold: number,
  stopLoss: number,
  takeProfit: number,
): HarnessConfig {
  return {
    version: 1,
    entry_rules: [
      {
        signal: { type: 'mean_reversion', lookback_candles: lookbackCandles, z_score_threshold: zScoreThreshold },
        condition: { type: 'positive' },
        weight: 1.0,
        tokens: [],
      },
    ],
    exit_rules: [
      { type: 'stop_loss', pct: stopLoss },
      { type: 'take_profit', pct: takeProfit },
      { type: 'time_limit', max_candles: 18 },
    ],
    filters: [{ type: 'min_volume', threshold: MIN_VOLUME_THRESHOLD }],
    position_sizing: { method: 'fixed_fraction', fraction },
    entry_threshold: 0.6,
    max_positions: 2,
  }
}

/** Default RSI/EMA harness but with a configurable position size and exits;
 *  used by `second_order_crowded_breakout_fade` to fade visible crowds. */
export function rsiEmaHarness(fraction: number, stopLoss: number, takeProfit: number): HarnessConfig {
  return {
    ...defaultHarness(),
    position_sizing: { method: 'fixed_fraction', fraction },
    exit_rules: [
      { type: 'stop_loss', pct: stopLoss },
      { type: 'take_profit', pct: takeProfit },
      { type: 'time_limit', max_candles: 20 },
    ],
  }
}
