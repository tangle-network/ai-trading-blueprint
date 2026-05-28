/**
 * `inspectBotArtifacts()` — observes the WORK PRODUCT a bot produced
 * during an eval cell. The conversation judges score chat surface
 * (`intent_fulfilled`, etc.); this module scores ARTIFACTS:
 *
 *   - Did the bot self-improve? (the headline behavior — SPEC.md §1)
 *   - How many revisions? Did they improve or hurt forward Sharpe?
 *   - Did the bot place trades? What's the resulting PnL?
 *   - Did it use its delegation tools (research / coder / analyst)?
 *
 * Sources:
 *   GET /strategy/state            — current strategy config + version
 *   GET /strategy/config           — full HarnessConfig
 *   POST /portfolio/state          — equity, margin, PnL
 *   GET /trades?limit=200          — full trade history this session
 *   GET /evolution/status          — current self-improvement state
 *   GET /evolution/sandbox/lineage — revision lineage (the gold)
 *   GET /evolution/revision-arena  — revision A/B-test arena state
 *   GET /learning/bandit-status    — bandit arms if MAB-driven
 *
 * Deep-sandbox inspection (`/home/agent/.evolve/findings/*.jsonl`,
 * `/home/agent/tools/strategies/*.{js,ts}`) is intentionally NOT here —
 * it would need docker-exec into the sandbox container. The operator-api
 * surfaces the same evidence at a different abstraction level. Add the
 * docker-exec path later only if there's a specific artifact the HTTP
 * surface doesn't expose.
 */

import type { BotArtifactsAggregate } from '../report/types.js'
import { OperatorClient } from './operator-client.js'

export interface BotArtifacts {
  bot_id: string
  inspected_at_iso: string

  /** Current strategy state — what the bot is running RIGHT NOW. */
  current_strategy: {
    harness_version?: number
    harness?: unknown
    state?: unknown
  }

  /** SELF-IMPROVEMENT evidence — the headline behavior we ship for. */
  self_improvement: {
    total_runs: number
    revisions_promoted: number
    revisions_rejected: number
    /** Per-revision lineage with forward-Sharpe delta where measured. */
    lineage: Array<{
      revision_id: string
      version: number
      sharpe_before?: number
      sharpe_after?: number
      promoted: boolean
      timestamp_iso?: string
      reason?: string
    }>
    /** Was a self-improvement cycle ever triggered? If 0, the bot never
     *  exercised its core advertised capability — that's a big flag. */
    cycles_fired: number
  }

  /** EXECUTION — did the bot actually trade? */
  execution: {
    trades_total: number
    trades_paper: number
    trades_live: number
    /** Cumulative since bot creation. */
    realized_pnl_usd: number | null
    unrealized_pnl_usd: number | null
    equity_usd: number | null
    margin_used_usd: number | null
    /** Mean fees + slippage across trades — operator efficiency signal. */
    mean_fee_bps: number | null
  }

  /** LEARNING — adaptation signals beyond explicit self-improvement. */
  learning: {
    strategy_outcomes_recorded: number
    bandit_arms_count: number | null
  }

  /** Operator-readable flags. Each is one bullet in the per-bot report's
   *  "Quality flags" section. */
  flags: string[]
}

interface EvolutionStatus {
  cycles_fired?: number
  total_runs?: number
  current_phase?: string
}

interface SandboxLineageEntry {
  revision_id: string
  version?: number
  sharpe_before?: number
  sharpe_after?: number
  promoted?: boolean
  timestamp?: string
  reason?: string
}

interface SandboxLineageResponse {
  revisions?: SandboxLineageEntry[]
  lineage?: SandboxLineageEntry[]
}

interface RevisionArenaResponse {
  revisions_promoted?: number
  revisions_rejected?: number
  /** Sometimes the arena nests these as `promoted` / `rejected` counts. */
  promoted?: number
  rejected?: number
}

interface StrategyStateResponse {
  harness?: unknown
  harness_version?: number
  state?: unknown
  version?: number
}

interface PortfolioStateResponse {
  equity_usd?: string | number
  realized_pnl_usd?: string | number
  unrealized_pnl_usd?: string | number
  margin_used_usd?: string | number
}

interface TradeListResponse {
  trades?: Array<{
    paper_trade?: boolean
    slippage_bps?: string | number
  }>
  total?: number
}

interface BanditStatusResponse {
  arms?: Array<unknown>
  arms_count?: number
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

async function safeGet<T>(client: OperatorClient, path: string): Promise<T | null> {
  try {
    return await client.get<T>(path)
  } catch {
    return null
  }
}

async function safePost<T>(client: OperatorClient, path: string, body: unknown): Promise<T | null> {
  try {
    return await client.post<T>(path, body)
  } catch {
    return null
  }
}

/** Inspect a bot's work-product state via the operator-api. Read-only —
 *  no side effects on the bot. Best-effort: any individual endpoint that
 *  fails (404, 500, timeout) is treated as "no data for that field"
 *  rather than failing the whole inspection. */
export async function inspectBotArtifacts(client: OperatorClient, botId: string): Promise<BotArtifacts> {
  void botId // bot scoping is via the bearer-token middleware on the operator-api side
  const [strategy, portfolio, trades, evolutionStatus, lineage, arena, bandit] = await Promise.all([
    safeGet<StrategyStateResponse>(client, '/strategy/state'),
    safePost<PortfolioStateResponse>(client, '/portfolio/state', {}),
    safeGet<TradeListResponse | TradeListResponse['trades']>(client, '/trades?limit=200'),
    safeGet<EvolutionStatus>(client, '/evolution/status'),
    safeGet<SandboxLineageResponse>(client, '/evolution/sandbox/lineage'),
    safeGet<RevisionArenaResponse>(client, '/evolution/revision-arena'),
    safeGet<BanditStatusResponse>(client, '/learning/bandit-status'),
  ])

  const lineageEntries = lineage?.revisions ?? lineage?.lineage ?? []
  const promoted = arena?.revisions_promoted ?? arena?.promoted ?? lineageEntries.filter((r) => r.promoted).length
  const rejected = arena?.revisions_rejected ?? arena?.rejected ?? Math.max(0, lineageEntries.length - promoted)
  const cyclesFired = evolutionStatus?.cycles_fired ?? evolutionStatus?.total_runs ?? lineageEntries.length

  // /trades returns a BARE array on the trading-blueprint operator-api
  // (older sandbox-runtime builds wrapped it in {trades, total}). Accept both
  // — same shape-tolerance lesson as getTranscript. Without this, a bare-array
  // response leaves trades_total=0 and state-based judging never sees a trade.
  const tradeRecords = Array.isArray(trades) ? trades : (trades?.trades ?? [])
  const tradesTotal = Array.isArray(trades) ? trades.length : (trades?.total ?? tradeRecords.length)
  const paperTrades = tradeRecords.filter((t) => t.paper_trade === true).length
  const liveTrades = tradesTotal - paperTrades
  const slippageBpsValues = tradeRecords
    .map((t) => toNumberOrNull(t.slippage_bps))
    .filter((n): n is number => n !== null)
  const meanFeeBps = slippageBpsValues.length === 0
    ? null
    : slippageBpsValues.reduce((a, b) => a + b, 0) / slippageBpsValues.length

  // Quality flags — operator-readable summary signals
  const flags: string[] = []
  if (tradesTotal === 0) flags.push('no-trades-placed')
  if (cyclesFired === 0) flags.push('self-improvement-never-fired')
  if (cyclesFired > 0 && promoted === 0) flags.push('self-improvement-cycles-no-promotion')
  if (promoted > 0) flags.push(`${promoted}-revisions-promoted`)
  const realizedPnl = toNumberOrNull(portfolio?.realized_pnl_usd)
  if (realizedPnl !== null) {
    if (realizedPnl > 0) flags.push(`pnl-positive: +$${realizedPnl.toFixed(2)}`)
    else if (realizedPnl < 0) flags.push(`pnl-negative: -$${Math.abs(realizedPnl).toFixed(2)}`)
  }

  return {
    bot_id: botId,
    inspected_at_iso: new Date().toISOString(),
    current_strategy: {
      ...(strategy?.harness_version !== undefined ? { harness_version: strategy.harness_version } : {}),
      ...(strategy?.version !== undefined && strategy.harness_version === undefined ? { harness_version: strategy.version } : {}),
      ...(strategy?.harness !== undefined ? { harness: strategy.harness } : {}),
      ...(strategy?.state !== undefined ? { state: strategy.state } : {}),
    },
    self_improvement: {
      total_runs: cyclesFired,
      revisions_promoted: promoted,
      revisions_rejected: rejected,
      cycles_fired: cyclesFired,
      lineage: lineageEntries.map((r) => ({
        revision_id: r.revision_id,
        version: r.version ?? 0,
        ...(r.sharpe_before !== undefined ? { sharpe_before: r.sharpe_before } : {}),
        ...(r.sharpe_after !== undefined ? { sharpe_after: r.sharpe_after } : {}),
        promoted: r.promoted === true,
        ...(r.timestamp ? { timestamp_iso: r.timestamp } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      })),
    },
    execution: {
      trades_total: tradesTotal,
      trades_paper: paperTrades,
      trades_live: liveTrades,
      realized_pnl_usd: realizedPnl,
      unrealized_pnl_usd: toNumberOrNull(portfolio?.unrealized_pnl_usd),
      equity_usd: toNumberOrNull(portfolio?.equity_usd),
      margin_used_usd: toNumberOrNull(portfolio?.margin_used_usd),
      mean_fee_bps: meanFeeBps,
    },
    learning: {
      strategy_outcomes_recorded: 0, // /learning/strategy-outcome doesn't have a list-GET; track on POST side later
      bandit_arms_count: bandit?.arms_count ?? bandit?.arms?.length ?? null,
    },
    flags,
  }
}

// ─── Aggregator: many per-cell BotArtifacts → one report-level rollup ──

/** Aggregate per-cell artifacts into the report's `BotArtifactsAggregate` slice.
 *  Used by the bin to compose `BotReportData.artifacts` from all cells the
 *  drivers produced. */
export function aggregateBotArtifacts(cells: Array<BotArtifacts | null>): BotArtifactsAggregate {
  const present = cells.filter((a): a is BotArtifacts => a !== null)
  if (present.length === 0) {
    return {
      cells_inspected: 0,
      total_self_improvement_runs: 0,
      total_revisions_promoted: 0,
      total_revisions_rejected: 0,
      mean_sharpe_delta_on_promotion: null,
      total_trades: 0,
      total_realized_pnl_usd: 0,
      cells_with_trades: 0,
      cells_with_self_improvement: 0,
      top_flags: [],
    }
  }
  const totalRuns = present.reduce((a, c) => a + c.self_improvement.total_runs, 0)
  const promoted = present.reduce((a, c) => a + c.self_improvement.revisions_promoted, 0)
  const rejected = present.reduce((a, c) => a + c.self_improvement.revisions_rejected, 0)
  const promotedDeltas = present
    .flatMap((c) => c.self_improvement.lineage)
    .filter((r) => r.promoted && r.sharpe_before !== undefined && r.sharpe_after !== undefined)
    .map((r) => (r.sharpe_after as number) - (r.sharpe_before as number))
  const meanDelta = promotedDeltas.length === 0
    ? null
    : promotedDeltas.reduce((a, b) => a + b, 0) / promotedDeltas.length
  const totalTrades = present.reduce((a, c) => a + c.execution.trades_total, 0)
  const totalRealizedPnl = present.reduce((a, c) => a + (c.execution.realized_pnl_usd ?? 0), 0)
  const cellsWithTrades = present.filter((c) => c.execution.trades_total > 0).length
  const cellsWithSelfImprove = present.filter((c) => c.self_improvement.cycles_fired > 0).length
  // Top flags by count
  const flagCounts = new Map<string, number>()
  for (const c of present) for (const f of c.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1)
  const topFlags = Array.from(flagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([flag, count]) => ({ flag, count }))
  return {
    cells_inspected: present.length,
    total_self_improvement_runs: totalRuns,
    total_revisions_promoted: promoted,
    total_revisions_rejected: rejected,
    mean_sharpe_delta_on_promotion: meanDelta,
    total_trades: totalTrades,
    total_realized_pnl_usd: totalRealizedPnl,
    cells_with_trades: cellsWithTrades,
    cells_with_self_improvement: cellsWithSelfImprove,
    top_flags: topFlags,
  }
}
