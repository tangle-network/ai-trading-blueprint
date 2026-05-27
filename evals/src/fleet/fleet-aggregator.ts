/**
 * Fleet-view aggregator (SPEC.md §5 eval-aux + §3 acceptance: operator
 * dashboard).
 *
 * Takes N per-bot `BotReportData` artifacts and ranks them. The output
 * is what an operator (Drew) sees at a glance:
 *   - which bots are S-tier (≥9.0) and should be promoted
 *   - which are A/B and need iteration with named gaps
 *   - which are C/D and should be killed
 *
 * Plus a leaderboard sorted by S-tier composite, with the rubric breakdown
 * (multishot · walk-forward · research · robustness · cost) per bot so
 * the operator can see WHERE each bot wins or loses.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { BotReportData } from '../report/types.js'

export interface FleetBotEntry {
  bot_id: string
  intent_text: string
  s_tier_composite: number
  multishot_composite?: number
  walk_forward_agent_pnl?: number
  research_depth_score?: number
  robustness_pass_rate?: number
  cost_dollars_per_day?: number
  recommendation: 'promote' | 'iterate' | 'kill'
  gap_summary: string
}

export interface FleetView {
  generated_at_iso: string
  bots_evaluated: number
  promote_count: number
  iterate_count: number
  kill_count: number
  leaderboard: FleetBotEntry[]
  /** Aggregate stats for the operator dashboard footer. */
  fleet_aggregate: {
    mean_composite: number
    median_composite: number
    total_llm_cost_per_day: number
    max_drawdown_observed_pct: number
  }
}

function recommend(composite: number): { rec: 'promote' | 'iterate' | 'kill'; gap_seed: string } {
  if (composite >= 9.0) return { rec: 'promote', gap_seed: 'meets S-tier bar' }
  if (composite >= 8.0) return { rec: 'promote', gap_seed: 'A-tier; promote to next venue/capital tier' }
  if (composite >= 7.0) return { rec: 'iterate', gap_seed: 'B-tier; close identified gaps before promotion' }
  if (composite >= 5.0) return { rec: 'iterate', gap_seed: 'C-tier; substantial revision needed' }
  return { rec: 'kill', gap_seed: 'D-tier; below operational competence bar' }
}

function summariseGaps(data: BotReportData): string {
  const gaps: string[] = []
  if (data.research) {
    if (data.research.depth_score < 7) gaps.push(`research depth ${data.research.depth_score.toFixed(1)}/10`)
    if (data.research.mean_source_count < 5) gaps.push(`sources ${data.research.mean_source_count.toFixed(1)} <5`)
    if (data.research.mean_recency_hours > 24) gaps.push(`recency ${data.research.mean_recency_hours.toFixed(0)}h >24h`)
  }
  if (data.robustness && data.robustness.pass_rate < 0.8) {
    gaps.push(`robustness ${(data.robustness.pass_rate * 100).toFixed(0)}% <80%`)
  }
  if (data.multishot) {
    const meanComposite = data.multishot.shots.length > 0
      ? data.multishot.shots.reduce((a, s) => a + s.composite, 0) / data.multishot.shots.length
      : 0
    if (meanComposite < 0.7) gaps.push(`multishot ${meanComposite.toFixed(2)} <0.70`)
  }
  if (data.cost) {
    if (data.cost.llm_dollars_per_day > 2.0) gaps.push(`LLM $${data.cost.llm_dollars_per_day.toFixed(2)}/d >$2`)
    if (data.cost.dollars_per_insight > 0.5) gaps.push(`$/insight ${data.cost.dollars_per_insight.toFixed(2)} >$0.50`)
  }
  return gaps.length === 0 ? 'no flagged gaps' : gaps.join('; ')
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function buildFleetView(reports: BotReportData[]): FleetView {
  const leaderboard: FleetBotEntry[] = reports.map((data) => {
    const rec = recommend(data.s_tier_composite)
    const multishot_composite = data.multishot && data.multishot.shots.length > 0
      ? data.multishot.shots.reduce((a, s) => a + s.composite, 0) / data.multishot.shots.length
      : undefined
    const wf = data.walkForward?.arms.find((a) => a.arm === 'agent')
    return {
      bot_id: data.bot_id,
      intent_text: data.intent_text,
      s_tier_composite: data.s_tier_composite,
      ...(multishot_composite !== undefined ? { multishot_composite } : {}),
      ...(wf ? { walk_forward_agent_pnl: wf.final_return_pct } : {}),
      ...(data.research ? { research_depth_score: data.research.depth_score } : {}),
      ...(data.robustness ? { robustness_pass_rate: data.robustness.pass_rate } : {}),
      ...(data.cost ? { cost_dollars_per_day: data.cost.llm_dollars_per_day } : {}),
      recommendation: rec.rec,
      gap_summary: summariseGaps(data),
    }
  })
  leaderboard.sort((a, b) => b.s_tier_composite - a.s_tier_composite)
  const composites = leaderboard.map((b) => b.s_tier_composite)
  const promote_count = leaderboard.filter((b) => b.recommendation === 'promote').length
  const iterate_count = leaderboard.filter((b) => b.recommendation === 'iterate').length
  const kill_count = leaderboard.filter((b) => b.recommendation === 'kill').length
  const total_llm_cost =
    leaderboard.reduce((acc, b) => acc + (b.cost_dollars_per_day ?? 0), 0)
  const max_dd = reports
    .flatMap((r) => r.walkForward?.arms.map((a) => a.final_max_dd_pct) ?? [])
    .reduce((acc, v) => Math.max(acc, v), 0)
  return {
    generated_at_iso: new Date().toISOString(),
    bots_evaluated: leaderboard.length,
    promote_count, iterate_count, kill_count,
    leaderboard,
    fleet_aggregate: {
      mean_composite: composites.length === 0 ? 0 : composites.reduce((a, b) => a + b, 0) / composites.length,
      median_composite: median(composites),
      total_llm_cost_per_day: total_llm_cost,
      max_drawdown_observed_pct: max_dd,
    },
  }
}

export function renderFleetView(fleet: FleetView): string {
  const lines: string[] = []
  lines.push('# Fleet view')
  lines.push('')
  lines.push(`Generated: ${fleet.generated_at_iso}`)
  lines.push(`Bots evaluated: **${fleet.bots_evaluated}** · promote **${fleet.promote_count}** · iterate **${fleet.iterate_count}** · kill **${fleet.kill_count}**`)
  lines.push('')
  lines.push('## Aggregate')
  lines.push(`- Mean S-tier composite: **${fleet.fleet_aggregate.mean_composite.toFixed(2)}**`)
  lines.push(`- Median S-tier composite: **${fleet.fleet_aggregate.median_composite.toFixed(2)}**`)
  lines.push(`- Total fleet LLM cost: **$${fleet.fleet_aggregate.total_llm_cost_per_day.toFixed(2)}/day**`)
  lines.push(`- Max DD observed across fleet: **${fleet.fleet_aggregate.max_drawdown_observed_pct.toFixed(2)}%**`)
  lines.push('')
  lines.push('## Leaderboard')
  lines.push('')
  lines.push('| Rank | Bot | Composite | Recommendation | Multishot | WF PnL | Research | Robust | $/d | Gaps |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  fleet.leaderboard.forEach((b, i) => {
    const ms = b.multishot_composite !== undefined ? b.multishot_composite.toFixed(2) : '—'
    const wf = b.walk_forward_agent_pnl !== undefined ? `${b.walk_forward_agent_pnl.toFixed(2)}%` : '—'
    const research = b.research_depth_score !== undefined ? b.research_depth_score.toFixed(1) : '—'
    const robust = b.robustness_pass_rate !== undefined ? `${(b.robustness_pass_rate * 100).toFixed(0)}%` : '—'
    const cost = b.cost_dollars_per_day !== undefined ? `$${b.cost_dollars_per_day.toFixed(2)}` : '—'
    const recIcon = b.recommendation === 'promote' ? '🟢 promote' : b.recommendation === 'iterate' ? '🟡 iterate' : '🔴 kill'
    lines.push(`| ${i + 1} | \`${b.bot_id}\` | **${b.s_tier_composite.toFixed(2)}** | ${recIcon} | ${ms} | ${wf} | ${research} | ${robust} | ${cost} | ${b.gap_summary} |`)
  })
  lines.push('')
  return lines.join('\n')
}

export function writeFleetView(fleet: FleetView, mdPath: string, jsonPath?: string): void {
  mkdirSync(dirname(mdPath), { recursive: true })
  writeFileSync(mdPath, renderFleetView(fleet), 'utf8')
  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, JSON.stringify(fleet, null, 2), 'utf8')
  }
}
