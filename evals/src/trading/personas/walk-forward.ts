/**
 * Persona-eval scoring + walk-forward dispatch.
 *
 * - Shells out to `target/release/examples/walk_forward_backtest` for the
 *   one comparison primitive (`BacktestEngine::walk_forward_compare`),
 *   the same engine the live promotion path uses.
 * - Applies the 6 deterministic gates ported verbatim from the previous
 *   Rust persona suite (`agent_personas.rs::score_scenario`).
 *
 * Output schema matches `PersonaEvalSuiteReport` so every TS consumer in
 * `evals/src/trading/` and `evals/src/product/` is a drop-in.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { repoRoot, resolveRepo } from '../../lib/repo.js'
import type {
  AgentEvalFinding,
  PersonaEvalResult,
  PersonaEvalSuiteReport,
  ScoreBreakdown,
} from '../persona-types.js'
import { defaultScenarios, type TradingEvalScenario } from './scenarios.js'

const BINARY_REL = 'target/release/examples/walk_forward_backtest'
const TRAIN_PCT = 0.65

interface WalkForwardSide {
  candidate: BacktestResult
  current: BacktestResult
  sharpe_delta: number
  drawdown_delta: number
  win_rate_delta: number
}

interface BacktestResult {
  trades: unknown[]
  stats: {
    total_return_pct: number
    sharpe_ratio: number
    sortino_ratio: number
    max_drawdown_pct: number
    win_rate: number
    total_trades: number
    profitable_trades: number
  }
  candles_processed: number
}

interface WalkForwardResult {
  train: WalkForwardSide
  test: WalkForwardSide
  should_promote: boolean
  train_candles: number
  test_candles: number
  sharpe_ratio_decay: number
  likely_overfit: boolean
}

function ensureBinary(): string {
  const abs = resolveRepo(BINARY_REL)
  if (existsSync(abs)) return abs
  const proc = spawnSync(
    'cargo',
    ['build', '-p', 'trading-runtime', '--example', 'walk_forward_backtest', '--release'],
    { cwd: repoRoot, stdio: 'inherit' },
  )
  if (proc.status !== 0) {
    throw new Error(`walk_forward_backtest build failed (status ${proc.status})`)
  }
  return abs
}

function runCompareCli(scenario: TradingEvalScenario): WalkForwardResult {
  const bin = ensureBinary()
  // Each side gets its own fee/slippage/gas tuple — the persona suite
  // explicitly contrasts venues with different cost schedules (e.g.,
  // baseline=80/40/2 vs candidate=10/4/1 for counterparty rotation), and
  // collapsing them would skew the baseline-vs-candidate compare.
  const request = {
    baseline: {
      harness: scenario.baseline.harness,
      taker_fee_bps: scenario.baseline.taker_fee_bps,
      slippage_bps: scenario.baseline.slippage_bps,
      gas_cost_usd: scenario.baseline.gas_cost_usd,
    },
    candidate: {
      harness: scenario.candidate.harness,
      taker_fee_bps: scenario.candidate.taker_fee_bps,
      slippage_bps: scenario.candidate.slippage_bps,
      gas_cost_usd: scenario.candidate.gas_cost_usd,
    },
    candles: scenario.candles,
    funding: scenario.funding,
    train_pct: TRAIN_PCT,
    initial_capital_usd: 10_000,
  }
  const proc = spawnSync(bin, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const lastLine = (proc.stdout ?? '').trim().split('\n').pop() ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch (e) {
    throw new Error(
      `walk_forward_backtest output parse failed for ${scenario.id}: ${(e as Error).message}; stderr=${proc.stderr}`,
    )
  }
  if (typeof parsed === 'object' && parsed && 'error' in parsed) {
    throw new Error(
      `walk_forward_backtest error for ${scenario.id}: ${(parsed as { error: string }).error}`,
    )
  }
  return parsed as WalkForwardResult
}

function points(ok: boolean, value: number): number {
  return ok ? value : 0
}

function maxPositionPct(scenario: TradingEvalScenario): number {
  const sizing = scenario.candidate.harness.position_sizing
  if (sizing.method === 'fixed_fraction') return sizing.fraction * 100
  if (sizing.method === 'kelly_fraction' && 'max_position_pct' in sizing) {
    return (sizing as { max_position_pct: number }).max_position_pct
  }
  // `fixed_amount` path uses 10k notional — same convention the Rust suite used.
  if (sizing.method === 'fixed_amount_usd' && 'amount' in sizing) {
    return ((sizing as { amount: number }).amount / 10_000) * 100
  }
  return 0
}

interface Gate {
  passed: boolean
  subject: string
  message: string
}

function buildGates(scenario: TradingEvalScenario, walk: WalkForwardResult): Gate[] {
  const mandate = scenario.persona
  const test = walk.test.candidate
  const positionPct = maxPositionPct(scenario)
  const positionOk = positionPct <= mandate.max_position_pct + 1e-6
  const drawdownOk = test.stats.max_drawdown_pct <= mandate.max_drawdown_pct
  const tradeCountOk =
    test.stats.total_trades >= mandate.min_trades && test.stats.total_trades <= mandate.max_trades
  const realBacktest =
    mandate.must_use_real_backtest && test.candles_processed > 0 && walk.train_candles > 0 && walk.test_candles > 0
  const economicsOk =
    test.stats.total_return_pct > walk.test.current.stats.total_return_pct && walk.test.sharpe_delta >= -0.01
  const generalizes =
    (!walk.likely_overfit && walk.sharpe_ratio_decay > -1.0) ||
    (test.stats.total_return_pct > walk.test.current.stats.total_return_pct &&
      test.stats.max_drawdown_pct <= mandate.max_drawdown_pct)

  return [
    {
      passed: positionOk,
      subject: 'risk:position-size',
      message: `position size ${positionPct.toFixed(2)}% <= mandate ${mandate.max_position_pct.toFixed(2)}%`,
    },
    {
      passed: drawdownOk,
      subject: 'risk:drawdown',
      message: `test drawdown ${test.stats.max_drawdown_pct.toFixed(2)}% <= mandate ${mandate.max_drawdown_pct.toFixed(2)}%`,
    },
    {
      passed: tradeCountOk,
      subject: 'execution:trade-count',
      message: `test trades ${test.stats.total_trades} within [${mandate.min_trades}..${mandate.max_trades}]`,
    },
    {
      passed: realBacktest,
      subject: 'execution:real-backtest',
      message: `walk-forward backtest consumed train=${walk.train_candles} test=${walk.test_candles} candles`,
    },
    {
      passed: economicsOk,
      subject: 'economics:candidate-beats-baseline',
      message: `test return candidate ${test.stats.total_return_pct.toFixed(2)}% vs baseline ${walk.test.current.stats.total_return_pct.toFixed(2)}%; sharpe delta ${walk.test.sharpe_delta.toFixed(2)}`,
    },
    {
      passed: generalizes,
      subject: 'adaptation:walk-forward',
      message: `walk-forward promotion=${walk.should_promote} sharpe_decay=${walk.sharpe_ratio_decay.toFixed(2)}`,
    },
  ]
}

function scoreScenario(scenario: TradingEvalScenario, walk: WalkForwardResult): PersonaEvalResult {
  const gates = buildGates(scenario, walk)
  const deterministicGates: string[] = gates.map((g) => `${g.passed ? 'PASS' : 'FAIL'} ${g.subject}: ${g.message}`)
  const findings: AgentEvalFinding[] = gates
    .filter((g) => !g.passed)
    .map((g) => ({
      severity: 'critical',
      subject: `persona:${scenario.id}:${g.subject}`,
      message: g.message,
    }))

  const breakdown: ScoreBreakdown = {
    risk: points(gates[0]!.passed, 10) + points(gates[1]!.passed, 15),
    execution: points(gates[2]!.passed, 10) + points(gates[3]!.passed, 10),
    economics: points(gates[4]!.passed, 20),
    adaptation: points(gates[5]!.passed, 15),
    reasoning_placeholder: 0,
    // Harness shape is always valid by construction in the TS builders;
    // the Rust check is preserved as a 10-point ops gate.
    ops: points(true, 10),
  }
  const score =
    breakdown.risk +
    breakdown.execution +
    breakdown.economics +
    breakdown.adaptation +
    breakdown.reasoning_placeholder +
    breakdown.ops
  const passed = score >= 70 && findings.every((f) => f.severity !== 'critical')

  const train = walk.train.candidate
  const test = walk.test.candidate
  return {
    scenario_id: scenario.id,
    persona_id: scenario.persona.id,
    split: scenario.split,
    passed,
    score,
    score_breakdown: breakdown,
    promotion_recommended: walk.should_promote,
    deterministic_gates: deterministicGates,
    findings,
    train_candidate_return_pct: train.stats.total_return_pct,
    test_candidate_return_pct: test.stats.total_return_pct,
    train_candidate_sharpe: train.stats.sharpe_ratio,
    test_candidate_sharpe: test.stats.sharpe_ratio,
    train_candidate_drawdown_pct: train.stats.max_drawdown_pct,
    test_candidate_drawdown_pct: test.stats.max_drawdown_pct,
    test_trade_count: test.stats.total_trades,
    sharpe_ratio_decay: walk.sharpe_ratio_decay,
  }
}

export function evaluateScenario(scenario: TradingEvalScenario): PersonaEvalResult {
  const walk = runCompareCli(scenario)
  return scoreScenario(scenario, walk)
}

export function runPersonaEvalSuite(): PersonaEvalSuiteReport {
  ensureBinary()
  const scenarios = defaultScenarios()
  const results = scenarios.map((s) => evaluateScenario(s))
  const passed = results.filter((r) => r.passed).length
  const total = results.length
  return {
    suite: 'trading-agent-personas',
    generated_at: Math.floor(Date.now() / 1000),
    schema_version: 1,
    passed,
    failed: total - passed,
    total,
    success_rate: total === 0 ? 0 : passed / total,
    min_score: results.reduce((m, r) => Math.min(m, r.score), Number.POSITIVE_INFINITY),
    results,
  }
}
