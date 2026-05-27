/**
 * Agent-in-loop walk-forward evaluation.
 *
 * For each user intent:
 *   1. Ask Claude for K candidate HarnessConfig strategies.
 *   2. For each candidate, simulate D days of trading day-by-day:
 *      - FROZEN arm: the candidate harness stays put.
 *      - AGENT arm:  same starting candidate; at each weekly boundary the
 *                    agent reads its own trace + current harness + recent
 *                    PnL and chooses to {revise → new HarnessConfig, noop}.
 *      The point is to surface whether the per-day agent self-improvement
 *      loop *actually* outperforms a static strategy on real market data.
 *
 * Backtest engine is the Rust `harness_backtest` CLI (single source of
 * truth for fitness). Candles are taken from the cached venue series; we
 * slice them into 24-bar day windows and feed them to the CLI via its
 * cache-file mechanism (no Rust change needed for day-scoped runs).
 *
 * Agent turn is `claude --print --model claude-haiku-4-5` — cheap, fast,
 * the same model the per-bot runtime would use for daily reflection.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { repoRoot } from '../lib/repo.js'
import { BASELINE_HARNESS, type HarnessConfig } from '../trading/harness-types.js'

/** Wire-shape candle row, matches the Rust `Candle` serde output (Decimal as string). */
export interface Candle {
  timestamp: number
  token: string
  open: string
  high: string
  low: string
  close: string
  volume: string
}

const HARNESS_BACKTEST_BIN = join(repoRoot, 'target/release/examples/harness_backtest')
const CLAUDE_MODEL = 'claude-haiku-4-5'
const CANDLES_PER_DAY = 24

export interface UserIntent {
  id: string
  text: string
  capital_usd: number
  dd_cap_pct: number
  bot_source: string
  bot_symbol: string
  fee_protocol: string
}

export interface DayResult {
  day: number
  harness_version: number
  candles_processed: number
  n_trades: number
  day_return_pct: number
  day_sharpe: number
  cumulative_return_pct: number
  running_drawdown_pct: number
}

export interface AgentDecision {
  action: 'revise' | 'noop'
  new_harness?: HarnessConfig
  reason: string
}

export interface ArmResult {
  arm: 'frozen' | 'agent'
  candidate_idx: number
  initial_harness: HarnessConfig
  days: DayResult[]
  revisions: Array<{ day: number; reason: string; from_version: number; to_version: number }>
  final_return_pct: number
  final_max_drawdown_pct: number
  total_trades: number
  turns_offered: number
  turns_revised: number
}

export interface IntentResult {
  intent: UserIntent
  candidates: HarnessConfig[]
  arms: ArmResult[]
  frozen_mean_return: number
  agent_mean_return: number
  delta_pct: number
  per_candidate_delta: number[]
}

// ─── Strategy generation ───────────────────────────────────────────────

const STRATEGY_GEN_PROMPT = `You design HarnessConfig JSON strategies for an algorithmic trading bot.

The HarnessConfig schema (TypeScript shape — all fields are required unless marked optional):

  interface HarnessConfig {
    version: number                          // start at 1
    entry_rules: EntryRule[]                 // 1..=5 rules
    exit_rules: ExitRule[]                   // 1..=4 rules
    filters: Filter[]                        // 0..=3 filters
    position_sizing: PositionSizing
    entry_threshold: number                  // 0.05..0.95, signal-weight-sum needed to fire
    max_positions: number                    // 1..10
  }

  // EntryRule.signal is one of:
  //   { type: 'rsi', period: number }                                            // period 5..50
  //   { type: 'ema_cross', short_period: number, long_period: number }           // short < long, both 3..200
  //   { type: 'sma_cross', short_period: number, long_period: number }
  //   { type: 'price_momentum', lookback_candles: number }                       // 3..50
  //   { type: 'mean_reversion', lookback_candles: number, z_score_threshold: number }
  // EntryRule.condition is one of:
  //   { type: 'below', threshold: number } | { type: 'above', threshold: number }
  //   | { type: 'cross_above' } | { type: 'cross_below' }
  //   | { type: 'positive' } | { type: 'negative' }
  // EntryRule fields: signal, condition, weight (0.05..1.0), tokens (string[], empty for any)

  // ExitRule is one of:
  //   { type: 'stop_loss', pct: number }            // 1..15
  //   { type: 'take_profit', pct: number }          // 2..30
  //   { type: 'trailing_stop', activation_pct, trail_pct }
  //   { type: 'time_limit', max_candles: number }   // 6..100

  // PositionSizing:
  //   { method: 'fixed_fraction', fraction: number }  // 0.02..0.40
`

function claudePrint(prompt: string, opts: { maxTokens?: number } = {}): string {
  // Use --print --output-format text for stdout-only output.
  const proc = spawnSync('claude', ['--print', '--model', CLAUDE_MODEL, '--output-format', 'text'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (proc.status !== 0) {
    throw new Error(`claude --print failed (status ${proc.status}): ${proc.stderr}`)
  }
  return proc.stdout
}

function extractJson(text: string): unknown {
  // Claude often wraps JSON in ```json … ``` fences. Tolerate that.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenceMatch?.[1] ?? text
  // Drop everything before the first `{` and after the last `}`.
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`no JSON object in claude output: ${text.slice(0, 200)}`)
  }
  return JSON.parse(body.slice(start, end + 1))
}

export function generateCandidate(intent: UserIntent, seedIdx: number): HarnessConfig {
  const prompt = `${STRATEGY_GEN_PROMPT}

User intent: "${intent.text}"
Capital: $${intent.capital_usd}, max drawdown: ${intent.dd_cap_pct}%.
Venue: ${intent.bot_source} ${intent.bot_symbol} (hourly candles).

Generate ONE valid HarnessConfig JSON tailored to this intent. Candidate #${seedIdx + 1} of several — vary the parameters meaningfully from a default RSI<30 + EMA-cross baseline so a portfolio of these candidates explores the space. Output ONLY the JSON object, no prose, no markdown fences.`
  const out = claudePrint(prompt)
  const parsed = extractJson(out) as Partial<HarnessConfig>
  // Light validation — the Rust engine will reject malformed configs, but
  // bumping `version` and forcing the seed metadata in keeps things tidy.
  const config: HarnessConfig = {
    version: 1,
    entry_rules: parsed.entry_rules ?? BASELINE_HARNESS.entry_rules,
    exit_rules: parsed.exit_rules ?? BASELINE_HARNESS.exit_rules,
    filters: parsed.filters ?? [],
    position_sizing: parsed.position_sizing ?? BASELINE_HARNESS.position_sizing,
    entry_threshold: parsed.entry_threshold ?? BASELINE_HARNESS.entry_threshold,
    max_positions: parsed.max_positions ?? BASELINE_HARNESS.max_positions,
  }
  return config
}

// ─── Day-scoped backtest dispatch ──────────────────────────────────────

interface DayBacktestResponse {
  sharpe: number
  max_drawdown_pct: number
  n_trades: number
  total_return_pct: number
}

function dayBacktest(harness: HarnessConfig, dayCandles: Candle[], intent: UserIntent): DayBacktestResponse {
  const cacheDir = mkdtempSync(join(tmpdir(), 'agent-in-loop-'))
  // The CLI's cache-file mechanism: `{source}-{symbol}-1h-{limit}.json`.
  // We synthesize a unique symbol per day so each call gets its own
  // cache entry (no cross-contamination across days).
  const symbol = `DAY-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const cachePath = join(cacheDir, `${intent.bot_source}-${symbol}-1h-${dayCandles.length}.json`)
  writeFileSync(cachePath, JSON.stringify(dayCandles))
  const request = {
    harness,
    source: intent.bot_source,
    symbol,
    fee_protocol: intent.fee_protocol,
    candles_limit: dayCandles.length,
    candles_cache_dir: cacheDir,
  }
  const proc = spawnSync(HARNESS_BACKTEST_BIN, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const lastLine = (proc.stdout ?? '').trim().split('\n').pop() ?? ''
  let parsed: { error?: string } & DayBacktestResponse
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    throw new Error(`harness_backtest parse failed: ${lastLine.slice(0, 200)}; stderr=${proc.stderr}`)
  }
  if (parsed.error) throw new Error(`harness_backtest error: ${parsed.error}`)
  return parsed
}

// ─── Walk-forward over a candidate ─────────────────────────────────────

interface WalkOptions {
  candles: Candle[]
  intent: UserIntent
  candidate: HarnessConfig
  candidateIdx: number
  totalDays: number
  /** Day indices at which the agent gets a revision turn (AGENT arm only). */
  agentTurnDays: number[]
  withAgent: boolean
}

function walkForward(opts: WalkOptions): ArmResult {
  let harness = JSON.parse(JSON.stringify(opts.candidate)) as HarnessConfig
  const days: DayResult[] = []
  const revisions: ArmResult['revisions'] = []
  let cumulativeReturnPct = 0
  let cumulativeEquity = 1.0 // multiplicative tracker for cumulative return
  let peakEquity = 1.0
  let maxDdPct = 0
  let totalTrades = 0
  let turnsOffered = 0
  let turnsRevised = 0

  const turnSet = new Set(opts.agentTurnDays)

  for (let day = 0; day < opts.totalDays; day++) {
    const dayCandles = opts.candles.slice(day * CANDLES_PER_DAY, (day + 1) * CANDLES_PER_DAY)
    if (dayCandles.length < CANDLES_PER_DAY) break

    const r = dayBacktest(harness, dayCandles, opts.intent)
    cumulativeEquity *= 1 + r.total_return_pct / 100
    cumulativeReturnPct = (cumulativeEquity - 1) * 100
    peakEquity = Math.max(peakEquity, cumulativeEquity)
    const runningDd = ((peakEquity - cumulativeEquity) / peakEquity) * 100
    maxDdPct = Math.max(maxDdPct, runningDd)

    days.push({
      day,
      harness_version: harness.version,
      candles_processed: dayCandles.length,
      n_trades: r.n_trades,
      day_return_pct: r.total_return_pct,
      day_sharpe: r.sharpe,
      cumulative_return_pct: cumulativeReturnPct,
      running_drawdown_pct: runningDd,
    })
    totalTrades += r.n_trades

    // Agent turn at week boundaries (AGENT arm only).
    if (opts.withAgent && turnSet.has(day) && day < opts.totalDays - 1) {
      turnsOffered += 1
      const decision = agentTurn({
        intent: opts.intent,
        currentHarness: harness,
        recentDays: days.slice(Math.max(0, days.length - 7)),
        cumulativeReturnPct,
        runningDdPct: runningDd,
      })
      if (decision.action === 'revise' && decision.new_harness) {
        const fromVersion = harness.version
        const newHarness = decision.new_harness
        newHarness.version = fromVersion + 1
        revisions.push({ day, reason: decision.reason, from_version: fromVersion, to_version: newHarness.version })
        harness = newHarness
        turnsRevised += 1
      }
    }
  }

  return {
    arm: opts.withAgent ? 'agent' : 'frozen',
    candidate_idx: opts.candidateIdx,
    initial_harness: opts.candidate,
    days,
    revisions,
    final_return_pct: cumulativeReturnPct,
    final_max_drawdown_pct: maxDdPct,
    total_trades: totalTrades,
    turns_offered: turnsOffered,
    turns_revised: turnsRevised,
  }
}

// ─── Agent turn ────────────────────────────────────────────────────────

function agentTurn(input: {
  intent: UserIntent
  currentHarness: HarnessConfig
  recentDays: DayResult[]
  cumulativeReturnPct: number
  runningDdPct: number
}): AgentDecision {
  const recentSummary = input.recentDays
    .map((d) => `  day ${d.day}: trades=${d.n_trades} ret=${d.day_return_pct.toFixed(2)}% sharpe=${d.day_sharpe.toFixed(2)}`)
    .join('\n')
  const prompt = `${STRATEGY_GEN_PROMPT}

You are a trading bot's self-improvement reflection step. You see your own recent performance and decide whether to revise your strategy or stand pat.

User intent: "${input.intent.text}"
Capital: $${input.intent.capital_usd}, max drawdown allowed: ${input.intent.dd_cap_pct}%.

Current HarnessConfig (the strategy you're running):
${JSON.stringify(input.currentHarness, null, 2)}

Recent days (latest week):
${recentSummary}

Cumulative since start: ${input.cumulativeReturnPct.toFixed(2)}% return, ${input.runningDdPct.toFixed(2)}% running drawdown.

Decide: should you REVISE the harness, or NOOP and let it run another week?

Revise only if you see a concrete failure mode: drawdown approaching the cap, no trades firing, repeated losses on a specific signal, etc. Random tweaks waste a week of trading — be deliberate.

Output ONE JSON object, no prose, no fences:
  { "action": "revise", "new_harness": <HarnessConfig>, "reason": "<1-2 sentence why>" }
or:
  { "action": "noop", "reason": "<1 sentence why>" }`
  const out = claudePrint(prompt)
  const parsed = extractJson(out) as { action: string; new_harness?: HarnessConfig; reason?: string }
  if (parsed.action === 'revise' && parsed.new_harness) {
    return { action: 'revise', new_harness: parsed.new_harness, reason: parsed.reason ?? '' }
  }
  return { action: 'noop', reason: parsed.reason ?? 'no rationale given' }
}

// ─── Public entry: run one intent ──────────────────────────────────────

export interface RunIntentOptions {
  intent: UserIntent
  candles: Candle[]
  numCandidates: number
  totalDays: number
  agentTurnEveryNDays: number
}

export function runIntent(opts: RunIntentOptions): IntentResult {
  const candidates: HarnessConfig[] = []
  for (let k = 0; k < opts.numCandidates; k++) {
    process.stderr.write(`  · generating candidate ${k + 1}/${opts.numCandidates}…\n`)
    candidates.push(generateCandidate(opts.intent, k))
  }
  const agentTurnDays: number[] = []
  for (let d = opts.agentTurnEveryNDays; d < opts.totalDays; d += opts.agentTurnEveryNDays) agentTurnDays.push(d)

  const arms: ArmResult[] = []
  for (let k = 0; k < candidates.length; k++) {
    const candidate = candidates[k]!
    process.stderr.write(`  · candidate ${k + 1}/${candidates.length} (frozen)…\n`)
    arms.push(
      walkForward({
        candles: opts.candles,
        intent: opts.intent,
        candidate,
        candidateIdx: k,
        totalDays: opts.totalDays,
        agentTurnDays: [],
        withAgent: false,
      }),
    )
    process.stderr.write(`  · candidate ${k + 1}/${candidates.length} (agent-in-loop)…\n`)
    arms.push(
      walkForward({
        candles: opts.candles,
        intent: opts.intent,
        candidate,
        candidateIdx: k,
        totalDays: opts.totalDays,
        agentTurnDays,
        withAgent: true,
      }),
    )
  }

  const frozenReturns = arms.filter((a) => a.arm === 'frozen').map((a) => a.final_return_pct)
  const agentReturns = arms.filter((a) => a.arm === 'agent').map((a) => a.final_return_pct)
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
  const perCandidateDelta: number[] = []
  for (let k = 0; k < candidates.length; k++) {
    const fz = arms.find((a) => a.candidate_idx === k && a.arm === 'frozen')!
    const ag = arms.find((a) => a.candidate_idx === k && a.arm === 'agent')!
    perCandidateDelta.push(ag.final_return_pct - fz.final_return_pct)
  }
  return {
    intent: opts.intent,
    candidates,
    arms,
    frozen_mean_return: mean(frozenReturns),
    agent_mean_return: mean(agentReturns),
    delta_pct: mean(agentReturns) - mean(frozenReturns),
    per_candidate_delta: perCandidateDelta,
  }
}

// ─── Markdown report ───────────────────────────────────────────────────

export function writeReport(results: IntentResult[], path: string): void {
  const lines: string[] = []
  lines.push('# Agent-in-loop walk-forward eval — results')
  lines.push('')
  const totalRevisions = results.reduce(
    (s, r) => s + r.arms.filter((a) => a.arm === 'agent').reduce((a, ar) => a + ar.turns_revised, 0),
    0,
  )
  const totalTurns = results.reduce(
    (s, r) => s + r.arms.filter((a) => a.arm === 'agent').reduce((a, ar) => a + ar.turns_offered, 0),
    0,
  )
  lines.push(
    `**Suite**: ${results.length} user intents · ${results[0]?.candidates.length ?? 0} candidates each · ${
      results[0]?.arms[0]?.days.length ?? 0
    } simulated days · ${totalRevisions}/${totalTurns} agent turns used to revise.`,
  )
  lines.push('')
  lines.push('## Aggregate frozen vs agent-in-loop')
  lines.push('')
  lines.push('| Intent | Frozen mean PnL | Agent mean PnL | Δ (agent − frozen) | Wins by agent |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    const wins = r.per_candidate_delta.filter((d) => d > 0).length
    lines.push(
      `| ${r.intent.id} | ${r.frozen_mean_return.toFixed(2)}% | ${r.agent_mean_return.toFixed(2)}% | ${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(2)}% | ${wins}/${r.candidates.length} |`,
    )
  }
  lines.push('')
  for (const r of results) {
    lines.push(`## Intent: ${r.intent.id}`)
    lines.push('')
    lines.push(`> "${r.intent.text}"`)
    lines.push('')
    lines.push(`Capital $${r.intent.capital_usd}, max DD ${r.intent.dd_cap_pct}%.`)
    lines.push('')
    lines.push('| # | Frozen PnL | Frozen DD | Agent PnL | Agent DD | Δ | Revisions |')
    lines.push('|---|---|---|---|---|---|---|')
    for (let k = 0; k < r.candidates.length; k++) {
      const fz = r.arms.find((a) => a.candidate_idx === k && a.arm === 'frozen')!
      const ag = r.arms.find((a) => a.candidate_idx === k && a.arm === 'agent')!
      lines.push(
        `| ${k + 1} | ${fz.final_return_pct.toFixed(2)}% | ${fz.final_max_drawdown_pct.toFixed(2)}% | ${ag.final_return_pct.toFixed(2)}% | ${ag.final_max_drawdown_pct.toFixed(2)}% | ${ag.final_return_pct - fz.final_return_pct >= 0 ? '+' : ''}${(ag.final_return_pct - fz.final_return_pct).toFixed(2)}% | ${ag.turns_revised}/${ag.turns_offered} |`,
      )
    }
    lines.push('')
    // Revision lineage for the candidate where the agent had the biggest positive delta.
    const bestK = r.per_candidate_delta.indexOf(Math.max(...r.per_candidate_delta))
    const bestAgentArm = r.arms.find((a) => a.candidate_idx === bestK && a.arm === 'agent')
    if (bestAgentArm && bestAgentArm.revisions.length > 0) {
      lines.push(`### Best-delta candidate #${bestK + 1} — revision lineage`)
      lines.push('')
      for (const rev of bestAgentArm.revisions) {
        lines.push(`- **day ${rev.day}** (v${rev.from_version} → v${rev.to_version}): ${rev.reason}`)
      }
      lines.push('')
    }
  }
  mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true })
  writeFileSync(path, lines.join('\n'))
}

// ─── Helpers ───────────────────────────────────────────────────────────

export function loadCachedCandles(path: string): Candle[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Candle[]
}
