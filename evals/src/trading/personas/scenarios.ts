/**
 * The 11 trading-persona scenarios — 1:1 port of `agent_personas.rs::
 * default_scenarios()`. Same regime semantics, same mandates, same baseline
 * / candidate harness pairs, same fee/slippage/gas tuples. The Rust suite
 * is now decommissioned; this file is the single source of truth.
 *
 * Each scenario carries:
 *   - `persona`: the mandate (venues, chains, position/dd/trade caps)
 *   - `baseline` + `candidate`: BacktestConfig pairs (harness + fees + gas)
 *   - `candles` + `funding`: synthetic series the new
 *     `walk_forward_backtest` Rust CLI consumes inline (no venue fetch)
 *
 * Scoring + walk-forward live in `walk-forward.ts`; that's the only
 * consumer of this module.
 */

import type { Candle, FundingSnapshot, HarnessConfig } from '../harness-types.js'
import { defaultHarness, meanReversionHarness, momentumHarness, rsiEmaHarness } from './harness-builders.js'
import {
  alphaDecayCandles,
  ammRebalancerCandles,
  counterpartyRotationCandles,
  crowdedBreakoutCandles,
  dislocationCandles,
  fundingWave,
  meanReversionCandles,
  stopCascadeCandles,
  trendCandles,
} from './synthetic-candles.js'

export interface PersonaMandate {
  id: string
  role: string
  venues: string[]
  chains: string[]
  execution_mode: string
  max_position_pct: number
  max_drawdown_pct: number
  min_trades: number
  max_trades: number
  must_use_real_backtest: boolean
}

export interface BacktestConfigShim {
  harness: HarnessConfig
  taker_fee_bps: number
  slippage_bps: number
  gas_cost_usd: number
}

export interface TradingEvalScenario {
  id: string
  split: 'dev' | 'search' | 'holdout'
  objective: string
  market_regime: string
  persona: PersonaMandate
  baseline: BacktestConfigShim
  candidate: BacktestConfigShim
  candles: Candle[]
  funding: FundingSnapshot[]
}

interface MandateLimits {
  max_position_pct: number
  max_drawdown_pct: number
  min_trades: number
  max_trades: number
}

function mandate(id: string, role: string, venues: string[], chains: string[], lim: MandateLimits): PersonaMandate {
  return {
    id,
    role,
    venues,
    chains,
    execution_mode: 'backtest_then_paper_or_shadow',
    max_position_pct: lim.max_position_pct,
    max_drawdown_pct: lim.max_drawdown_pct,
    min_trades: lim.min_trades,
    max_trades: lim.max_trades,
    must_use_real_backtest: true,
  }
}

function limits(maxPositionPct: number, maxDrawdownPct: number, minTrades: number, maxTrades: number): MandateLimits {
  return { max_position_pct: maxPositionPct, max_drawdown_pct: maxDrawdownPct, min_trades: minTrades, max_trades: maxTrades }
}

function config(harness: HarnessConfig, takerFeeBps: number, slippageBps: number, gas: number): BacktestConfigShim {
  return { harness, taker_fee_bps: takerFeeBps, slippage_bps: slippageBps, gas_cost_usd: gas }
}

export function hyperliquidPerpMarketMaker(): TradingEvalScenario {
  const candles = trendCandles('BTC-PERP', 220, 67_000, 0.0018, 0.012)
  const funding = fundingWave('BTC-PERP', candles.length, 0.00015)
  return {
    id: 'hyperliquid_perp_mm_volatility_spike',
    split: 'dev',
    objective: 'Quote/adapt a Hyperliquid perp market under volatile trending conditions without blowing inventory risk.',
    market_regime: 'trend_with_funding_and_volatility_spikes',
    persona: mandate('hyperliquid_perp_market_maker', 'Hyperliquid Perp Market Maker', ['hyperliquid'], ['hyperliquid'], limits(6.0, 18.0, 2, 80)),
    baseline: config(defaultHarness(), 18, 8, 0),
    candidate: config(momentumHarness(0.06, 8.0, 16.0), 8, 4, 0),
    candles,
    funding,
  }
}

export function predictionMarketMaker(): TradingEvalScenario {
  const candles = meanReversionCandles('ETH-ABOVE-4000-YES', 200, 0.52, 0.11, 0.015)
  return {
    id: 'prediction_market_mm_misleading_signal',
    split: 'dev',
    objective: 'Make binary-market quotes around a noisy probability process and avoid overreacting to transient news shocks.',
    market_regime: 'bounded_probability_mean_reversion',
    persona: mandate('prediction_market_maker', 'Prediction/Binary Market Maker', ['polymarket_clob'], ['polygon'], limits(4.0, 12.0, 2, 60)),
    baseline: config(defaultHarness(), 12, 5, 0),
    candidate: config(momentumHarness(0.04, 4.0, 7.0), 6, 2, 0),
    candles,
    funding: [],
  }
}

export function uniswapMarketMaker(): TradingEvalScenario {
  const candles = meanReversionCandles('WETH-USDC', 240, 3_600, 180, 0.008)
  return {
    id: 'uniswap_v3_lp_range_rebalance',
    split: 'dev',
    objective: 'Approximate an LP/range-management policy with mean-reversion entries, low churn, and gas-aware sizing.',
    market_regime: 'range_bound_with_fee_like_noise',
    persona: mandate('uniswap_lp_market_maker', 'Uniswap Market Maker', ['uniswap_v3'], ['base'], limits(5.0, 10.0, 2, 70)),
    baseline: config(momentumHarness(0.08, 4.0, 8.0), 20, 10, 2),
    candidate: config(momentumHarness(0.05, 3.0, 6.0), 10, 4, 2),
    candles,
    funding: [],
  }
}

export function evmBasePortfolioManager(): TradingEvalScenario {
  const candles = trendCandles('WETH', 220, 3_500, 0.0012, 0.007).concat(
    meanReversionCandles('cbBTC', 220, 68_000, 1_800, 0.006),
  )
  candles.sort((a, b) => a.timestamp - b.timestamp || a.token.localeCompare(b.token))
  return {
    id: 'base_portfolio_manager_stale_risk',
    split: 'dev',
    objective: 'Manage a Base-only portfolio across WETH/cbBTC with small allocations and no cross-chain assumptions.',
    market_regime: 'multi_asset_base_rotation',
    persona: mandate('evm_portfolio_manager_base', 'Base Portfolio Manager', ['uniswap_v3', 'aave_v3'], ['base'], limits(4.0, 9.0, 2, 90)),
    baseline: config(defaultHarness(), 14, 6, 1),
    candidate: config(momentumHarness(0.04, 5.0, 9.0), 8, 3, 1),
    candles,
    funding: [],
  }
}

export function riskOnArbitrageTrader(): TradingEvalScenario {
  const candles = dislocationCandles('ARB-ETH-USDC', 180, 2_800)
  return {
    id: 'risk_on_arbitrage_dislocation_decay',
    split: 'dev',
    objective: 'Exploit short-lived dislocations only when edge survives fees, slippage, and gas.',
    market_regime: 'dislocation_then_decay',
    persona: mandate('risk_on_arbitrage_bot', 'Risk-On Arbitrage Trader', ['uniswap_v3', 'hyperliquid'], ['base', 'ethereum'], limits(7.0, 14.0, 2, 50)),
    baseline: config(defaultHarness(), 20, 10, 4),
    candidate: config(momentumHarness(0.069, 3.0, 5.0), 6, 2, 4),
    candles,
    funding: [],
  }
}

export function protocolResearchAdapter(): TradingEvalScenario {
  const candles = trendCandles('GMX-ETH-PERP', 210, 3_400, 0.0015, 0.01)
  return {
    id: 'protocol_research_adapter_gmx_like_perp',
    split: 'dev',
    objective: 'Evaluate whether a new perp venue adapter behaves like a safe candidate before live integration.',
    market_regime: 'new_protocol_perp_smoke',
    persona: mandate('protocol_researcher', 'Protocol Researcher', ['gmx_v2', 'vertex', 'hyperliquid'], ['arbitrum', 'base'], limits(5.0, 15.0, 2, 70)),
    baseline: config(defaultHarness(), 16, 8, 1),
    candidate: config(momentumHarness(0.05, 5.0, 10.0), 8, 4, 1),
    candles,
    funding: fundingWave('GMX-ETH-PERP', 210, 0.00008),
  }
}

export function secondOrderCrowdedBreakoutFade(): TradingEvalScenario {
  const candles = crowdedBreakoutCandles('POLY-CROWDED-BREAKOUT-YES', 240, 0.48)
  return {
    id: 'second_order_crowded_breakout_fade',
    split: 'dev',
    objective: 'Learn from predictable breakout-chasing bots, ride confirmed flow briefly, and avoid oversizing into the visible crowd.',
    market_regime: 'crowded_breakout_then_mean_reversion',
    persona: mandate(
      'second_order_game_theory_bot',
      'Second-Order Market-Structure Trader',
      ['polymarket_clob', 'hyperliquid', 'uniswap_v3'],
      ['polygon', 'hyperliquid', 'base'],
      limits(12.0, 10.0, 2, 80),
    ),
    baseline: config(defaultHarness(), 80, 40, 1),
    candidate: config(rsiEmaHarness(0.12, 5.0, 8.0), 10, 4, 0),
    candles,
    funding: [],
  }
}

export function secondOrderStopCascadeRecovery(): TradingEvalScenario {
  const candles = stopCascadeCandles('HL-STOP-CASCADE-PERP', 260, 2_800)
  return {
    id: 'second_order_stop_cascade_recovery',
    split: 'dev',
    objective: 'Detect liquidation/stop-loss cascades caused by simple levered bots, join confirmed forced flow only briefly, and avoid late reversal exposure.',
    market_regime: 'stop_cascade_forced_selling_then_recovery',
    persona: mandate(
      'second_order_game_theory_bot',
      'Second-Order Market-Structure Trader',
      ['hyperliquid', 'polymarket_clob'],
      ['hyperliquid', 'polygon'],
      limits(4.0, 14.0, 2, 70),
    ),
    baseline: config(defaultHarness(), 12, 6, 0),
    candidate: config(momentumHarness(0.04, 4.0, 8.0), 8, 3, 0),
    candles,
    funding: fundingWave('HL-STOP-CASCADE-PERP', 260, 0.00012),
  }
}

export function secondOrderAmmRebalancerFlow(): TradingEvalScenario {
  const candles = ammRebalancerCandles('BASE-AMM-REBALANCER-FLOW', 240, 3_400)
  return {
    id: 'second_order_amm_rebalancer_flow',
    split: 'dev',
    objective: 'Exploit predictable AMM/rebalancer bot flow after inventory shocks while avoiding chasing the first toxic print.',
    market_regime: 'amm_inventory_rebalance_oscillation',
    persona: mandate(
      'second_order_game_theory_bot',
      'Second-Order Market-Structure Trader',
      ['uniswap_v3', 'aave_v3'],
      ['base', 'ethereum'],
      limits(4.0, 12.0, 2, 80),
    ),
    baseline: config(momentumHarness(0.06, 4.0, 8.0), 18, 10, 2),
    candidate: config(meanReversionHarness(0.035, 10, 1.2, 5.0, 8.0), 12, 5, 2),
    candles,
    funding: [],
  }
}

export function thirdOrderCrowdedAlphaDecay(): TradingEvalScenario {
  const candles = alphaDecayCandles('META-CROWDED-ALPHA-DECAY', 280, 0.50)
  return {
    id: 'third_order_crowded_alpha_decay',
    split: 'dev',
    objective: 'Evaluate a meta-strategy that recognizes a once-profitable bot pattern becoming crowded and de-risks when the alpha decays.',
    market_regime: 'alpha_decay_after_strategy_crowding',
    persona: mandate(
      'third_order_adaptive_game_theory_bot',
      'Third-Order Adaptive Market-Structure Trader',
      ['polymarket_clob', 'hyperliquid'],
      ['polygon', 'hyperliquid'],
      limits(6.0, 12.0, 2, 70),
    ),
    baseline: config(defaultHarness(), 60, 30, 1),
    candidate: config(momentumHarness(0.06, 5.0, 8.0), 10, 4, 0),
    candles,
    funding: [],
  }
}

export function thirdOrderAdaptiveCounterpartyRotation(): TradingEvalScenario {
  const candles = counterpartyRotationCandles('META-COUNTERPARTY-ROTATION', 280, 3_200)
  return {
    id: 'third_order_adaptive_counterparty_rotation',
    split: 'dev',
    objective: 'Evaluate whether the strategy survives a rotation from momentum bots to inventory-rebalancing bots without overfitting to the first counterparty population.',
    market_regime: 'counterparty_population_rotation',
    persona: mandate(
      'third_order_adaptive_game_theory_bot',
      'Third-Order Adaptive Market-Structure Trader',
      ['uniswap_v3', 'hyperliquid', 'polymarket_clob'],
      ['base', 'hyperliquid', 'polygon'],
      limits(5.0, 12.0, 2, 80),
    ),
    baseline: config(momentumHarness(0.07, 5.0, 9.0), 80, 40, 2),
    candidate: config(meanReversionHarness(0.05, 10, 1.1, 5.0, 8.0), 10, 4, 1),
    candles,
    funding: fundingWave('META-COUNTERPARTY-ROTATION', 280, 0.0001),
  }
}

export function defaultScenarios(): TradingEvalScenario[] {
  return [
    hyperliquidPerpMarketMaker(),
    predictionMarketMaker(),
    uniswapMarketMaker(),
    evmBasePortfolioManager(),
    riskOnArbitrageTrader(),
    protocolResearchAdapter(),
    secondOrderCrowdedBreakoutFade(),
    secondOrderStopCascadeRecovery(),
    secondOrderAmmRebalancerFlow(),
    thirdOrderCrowdedAlphaDecay(),
    thirdOrderAdaptiveCounterpartyRotation(),
  ]
}
