/**
 * S-tier per-bot weekly report renderer (SPEC.md §4).
 *
 * Takes a `BotReportData` bundle (one or more eval slices) and emits a
 * markdown document with inline SVG charts that GitHub renders directly.
 *
 * Forgiving: missing sections become honest "not yet evaluated" stubs
 * instead of throwing. This lets us ship the renderer ahead of all 7
 * evals being built.
 */

import {
  costDecompSvg,
  dimensionBarsSvg,
  drawdownSvg,
  equityCurveSvg,
  latencyHistSvg,
  revisionLineageSvg,
} from './charts.js'
import type { BotReportData, MultishotShot, TurnView, WalkForwardArm } from './types.js'

function tierBand(score: number): { label: string; recommendation: string } {
  if (score >= 9.0) return { label: 'S-TIER', recommendation: 'Promote to next venue / capital tier' }
  if (score >= 8.0) return { label: 'A', recommendation: 'Promote to Tier 1 (public testnet, real venue, no real funds)' }
  if (score >= 7.0) return { label: 'B', recommendation: 'Review and iterate — close on identified gaps' }
  if (score >= 5.0) return { label: 'C', recommendation: 'Substantial revision needed' }
  return { label: 'D', recommendation: 'Reject / kill — does not meet operational competence bar' }
}

function ciPctTable(label: string, mean: number, n: number, std: number, benchmark?: string): string {
  // 95% CI via t-approx for small n; for n>=5 z=1.96 is fine but t is safer
  const tcrit = n >= 30 ? 1.96 : n >= 10 ? 2.26 : n >= 5 ? 2.78 : 4.30
  const sem = n > 1 ? std / Math.sqrt(n) : std
  const half = tcrit * sem
  const lo = (mean - half).toFixed(2)
  const hi = (mean + half).toFixed(2)
  return `| ${label} | ${mean.toFixed(2)} | [${lo}, ${hi}] | ${benchmark ?? '—'} |`
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1))
}

function renderTurn(turn: TurnView): string {
  const lines: string[] = []
  lines.push(`**Turn ${turn.turn} — USER**`)
  lines.push(`> ${turn.user_message.split('\n').join('\n> ')}`)
  lines.push('')
  lines.push(`**BOT** (reply in ${Math.round(turn.bot_reply_arrived_ms / 1000)}s):`)
  if (turn.bot_tool_calls && turn.bot_tool_calls.length > 0) {
    for (const tc of turn.bot_tool_calls) {
      lines.push(`> 🔧 \`${tc.tool}(${tc.args_summary})\` → ${tc.result_summary} (${tc.latency_ms}ms)`)
    }
  }
  lines.push(`> ${turn.bot_reply_text.split('\n').join('\n> ')}`)
  if (turn.signalled_done) lines.push('')
  if (turn.signalled_done) lines.push('_(user-sim emitted `[done]` — session ended naturally)_')
  return lines.join('\n')
}

async function renderMultishot(data: BotReportData['multishot']): Promise<string> {
  if (!data) return notEvaluated('Multishot user-sim eval', 'Eval #1 in SPEC.md §5')
  const composites = data.shots.map((s) => s.composite)
  const meanC = mean(composites)
  const stdC = std(composites)
  const dims: Array<keyof MultishotShot['dimensions']> = [
    'intent_fulfilled',
    'respected_constraints',
    'actually_traded_or_committed',
    'productive_conversation',
  ]
  const lines: string[] = []
  lines.push('## Eval #1 — Multishot user-sim')
  lines.push('')
  lines.push(`Reps: **${data.reps}** · Shots: **${data.shots.length}** · Mean composite: **${meanC.toFixed(2)}**`)
  lines.push('')
  lines.push('### Dimension scores (mean ± 95% CI across reps)')
  lines.push('')
  lines.push('| Dimension | Mean | 95% CI | S-tier bench |')
  lines.push('|---|---|---|---|')
  const benches: Record<string, string> = {
    intent_fulfilled: '>0.7',
    respected_constraints: '>0.85',
    actually_traded_or_committed: '>0.7',
    productive_conversation: '>0.6',
  }
  for (const dim of dims) {
    const xs = data.shots.map((s) => s.dimensions[dim])
    lines.push(ciPctTable(dim, mean(xs), xs.length, std(xs), benches[dim]))
  }
  lines.push(ciPctTable('**composite**', meanC, composites.length, stdC, '>0.6'))
  lines.push('')

  if (data.baselineComparison) {
    const b = data.baselineComparison
    lines.push('### Comparison to adversarial baselines')
    lines.push('')
    lines.push('| Bot | Composite | Vs this bot |')
    lines.push('|---|---|---|')
    lines.push(`| null-bot (echoes user) | ${b.null_bot_composite.toFixed(2)} | ${(meanC - b.null_bot_composite >= 0 ? '+' : '')}${(meanC - b.null_bot_composite).toFixed(2)} |`)
    lines.push(`| stall-bot ("I'll think") | ${b.stall_bot_composite.toFixed(2)} | ${(meanC - b.stall_bot_composite >= 0 ? '+' : '')}${(meanC - b.stall_bot_composite).toFixed(2)} |`)
    lines.push(`| frontier-bot (S-tier ref) | ${b.frontier_bot_composite.toFixed(2)} | ${(meanC - b.frontier_bot_composite >= 0 ? '+' : '')}${(meanC - b.frontier_bot_composite).toFixed(2)} |`)
    lines.push('')

    // Radar/bar chart comparing dimension scores across this bot + baselines
    const series = [
      {
        label: 'this bot',
        dimensions: Object.fromEntries(dims.map((d) => [d, mean(data.shots.map((s) => s.dimensions[d]))])),
      },
      { label: 'null-bot', dimensions: { intent_fulfilled: 0.1, respected_constraints: 0.0, actually_traded_or_committed: 0.0, productive_conversation: 0.1 } },
      { label: 'frontier-bot', dimensions: { intent_fulfilled: 0.92, respected_constraints: 0.95, actually_traded_or_committed: 0.90, productive_conversation: 0.85 } },
    ]
    lines.push(await dimensionBarsSvg(series))
    lines.push('')
  }

  // Show one sample shot's transcript (highest composite rep)
  const bestShot = data.shots.slice().sort((a, b) => b.composite - a.composite)[0]
  if (bestShot) {
    lines.push(`### Sample conversation — best shot (rep ${bestShot.rep}, composite ${bestShot.composite.toFixed(2)})`)
    lines.push('')
    lines.push(`*Ended by: \`${bestShot.ended_by}\` after ${bestShot.turns.length} turns in ${Math.round(bestShot.total_wall_ms / 1000)}s*`)
    lines.push('')
    for (const t of bestShot.turns) {
      lines.push(renderTurn(t))
      lines.push('')
    }
  }
  return lines.join('\n')
}

async function renderWalkForward(data: BotReportData['walkForward']): Promise<string> {
  if (!data) return notEvaluated('Agent-in-loop walk-forward', 'Eval #2 in SPEC.md §5')
  const lines: string[] = []
  lines.push('## Eval #2 — Agent-in-loop walk-forward')
  lines.push('')
  lines.push(`${data.days_simulated} simulated days · ${data.num_candidates} candidates × 2 arms = ${data.arms.length} runs`)
  lines.push('')
  lines.push('### Per-candidate arm results')
  lines.push('')
  lines.push('| # | Arm | Final return | Max DD | Trades | Revisions |')
  lines.push('|---|---|---|---|---|---|')
  for (const arm of data.arms) {
    lines.push(
      `| ${arm.candidate_idx + 1} | ${arm.arm} | ${arm.final_return_pct.toFixed(2)}% | ${arm.final_max_dd_pct.toFixed(2)}% | ${arm.total_trades} | ${arm.revisions.length} |`,
    )
  }
  lines.push('')
  // For the best-delta candidate, render charts
  const byCandidate: Record<number, { frozen?: WalkForwardArm; agent?: WalkForwardArm }> = {}
  for (const a of data.arms) (byCandidate[a.candidate_idx] ??= {})[a.arm] = a
  const deltas = Object.entries(byCandidate)
    .map(([k, v]) => ({ k: Number(k), d: (v.agent?.final_return_pct ?? 0) - (v.frozen?.final_return_pct ?? 0) }))
    .sort((a, b) => b.d - a.d)
  const best = deltas[0] ? byCandidate[deltas[0].k] : undefined
  if (best?.agent && best?.frozen) {
    lines.push(`### Best-delta candidate #${(deltas[0]!.k) + 1} — equity curves`)
    lines.push('')
    lines.push('Frozen arm:')
    lines.push(await equityCurveSvg(best.frozen.days_pnl.map((d) => ({ day: d.day, equity: d.equity })), { title: 'Frozen — cumulative equity' }))
    lines.push('')
    lines.push('Agent-in-loop arm:')
    lines.push(await equityCurveSvg(best.agent.days_pnl.map((d) => ({ day: d.day, equity: d.equity })), { title: 'Agent-in-loop — cumulative equity' }))
    lines.push('')
    lines.push('Drawdown (agent arm) vs cap:')
    lines.push(await drawdownSvg(best.agent.days_pnl.map((d) => ({ day: d.day, dd_pct: d.dd_pct })), 5))
    lines.push('')
    if (best.agent.revisions.length > 0) {
      lines.push('Revision lineage (agent arm):')
      lines.push(await revisionLineageSvg(best.agent.revisions.map((r) => ({ day: r.day, reason: r.reason })), data.days_simulated))
      lines.push('')
    }
  }
  return lines.join('\n')
}

function renderResearch(data: BotReportData['research']): string {
  if (!data) return notEvaluated('Research depth eval', 'Eval #3 in SPEC.md §5')
  return [
    '## Eval #3 — Research depth',
    '',
    `Theses evaluated: ${data.theses_evaluated}`,
    '',
    '| Metric | Value | S-tier bench |',
    '|---|---|---|',
    `| Mean source count | ${data.mean_source_count.toFixed(1)} | ≥5 |`,
    `| Mean recency (h) | ${data.mean_recency_hours.toFixed(1)} | <24 |`,
    `| Source diversity | ${data.source_diversity_score.toFixed(2)} | >0.7 |`,
    `| Citation resolution | ${(data.citation_resolution_rate * 100).toFixed(0)}% | >80% |`,
    `| **Depth score** | **${data.depth_score.toFixed(1)}/10** | ≥7 |`,
  ].join('\n')
}

function renderRobustness(data: BotReportData['robustness']): string {
  if (!data) return notEvaluated('Adversarial robustness eval', 'Eval #5 in SPEC.md §5')
  const lines = [
    '## Eval #5 — Adversarial robustness',
    '',
    `Pass rate: **${(data.pass_rate * 100).toFixed(0)}%** (${data.scenarios_tested.filter((s) => s.graceful_handling === 1).length} of ${data.scenarios_tested.length})`,
    '',
    '| Scenario | Handled | Bot response |',
    '|---|---|---|',
  ]
  for (const s of data.scenarios_tested) {
    lines.push(`| ${s.scenario_id} | ${s.graceful_handling ? '✓' : '✗'} | ${s.bot_response_summary.slice(0, 100)} |`)
  }
  return lines.join('\n')
}

async function renderCost(data: BotReportData['cost']): Promise<string> {
  if (!data) return notEvaluated('Cost & efficiency eval', 'Eval #6 in SPEC.md §5')
  const lines = [
    '## Eval #6 — Cost & efficiency',
    '',
    '| Metric | Value | S-tier bench |',
    '|---|---|---|',
    `| LLM $/day | $${data.llm_dollars_per_day.toFixed(2)} | <$2 |`,
    `| Tokens/shot mean | ${data.tokens_per_shot_mean.toFixed(0)} | — |`,
    `| Decision latency p50 | ${data.decision_latency_ms_p50.toFixed(0)}ms | — |`,
    `| Decision latency p95 | ${data.decision_latency_ms_p95.toFixed(0)}ms | <5000ms |`,
    `| Decision latency p99 | ${data.decision_latency_ms_p99.toFixed(0)}ms | <10000ms |`,
    `| $ / insight | $${data.dollars_per_insight.toFixed(2)} | <$0.50 |`,
    `| Tool calls/shot mean | ${data.tool_call_count_per_shot_mean.toFixed(1)} | — |`,
    '',
  ]
  return lines.join('\n')
}

function notEvaluated(label: string, ref: string): string {
  return `## ${label}\n\n_Not yet evaluated for this period (${ref})._`
}

export async function renderBotReport(data: BotReportData): Promise<string> {
  const tier = tierBand(data.s_tier_composite)
  const sections: string[] = []
  sections.push(
    `# Bot: \`${data.bot_id}\` · ${data.period_start_iso} → ${data.period_end_iso}`,
    `Operator: ${data.operator} · Intent: "${data.intent_text}"`,
    `Capital: $${data.capital_usd.toLocaleString()} · DD cap: ${data.dd_cap_pct}%`,
    '',
    `## S-tier composite: **${data.s_tier_composite.toFixed(1)} / 10** — ${tier.label}`,
    '',
    `**Recommendation**: ${tier.recommendation}`,
    '',
    '---',
    '',
  )
  sections.push(await renderMultishot(data.multishot))
  sections.push('')
  sections.push(await renderWalkForward(data.walkForward))
  sections.push('')
  sections.push(renderResearch(data.research))
  sections.push('')
  sections.push(renderRobustness(data.robustness))
  sections.push('')
  sections.push(await renderCost(data.cost))
  sections.push('')
  sections.push('---')
  sections.push(`_Generated by \`evals/src/report/render.ts\` against the data sliced from ${[data.multishot && 'multishot', data.walkForward && 'walk-forward', data.research && 'research', data.robustness && 'robustness', data.cost && 'cost'].filter(Boolean).join(' · ')} evals._`)
  return sections.join('\n')
}
