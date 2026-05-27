#!/usr/bin/env node
/**
 * Full per-bot eval against an ALREADY-RUNNING devnet (no UI proxy).
 *
 * Drives a devnet booted manually via `scripts/run-devnet.sh --no-ui`.
 * Skips the UI-proxy layer that `runLocalProductE2E` assumes and talks
 * directly to the fleet operator-api at e.g. http://127.0.0.1:9200.
 *
 * Auth flow (same as local-stack-runner.ts::createOperatorSession):
 *   1. POST $operator/api/auth/challenge   → {nonce, message}
 *   2. cast wallet sign --private-key X <message>
 *   3. POST $operator/api/auth/session {nonce, signature} → {token, expires_at}
 *
 * Then runs:
 *   - multishot user-sim + adversarial baselines (multishot-user-sim.ts)
 *   - research-depth (research-driver.ts)
 *   - adversarial robustness (robustness-driver.ts)
 *   - renders the S-tier per-bot report + the fleet view
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { aggregateResearchData, runResearchEval } from '../research/research-driver.js'
import { judgeAllResearchShots } from '../research/research-judge.js'
import { renderBotReport } from '../report/render.js'
import type { BotReportData, MultishotShot } from '../report/types.js'
import { runRobustnessEval } from '../robustness/robustness-driver.js'
import { buildFleetView, writeFleetView } from '../fleet/fleet-aggregator.js'
import { runMultishotWithBaselines } from '../sim/multishot-user-sim.js'
import type { UserIntent } from '../sim/user-sim-driver.js'

const DEFAULT_E2E_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil[0]

const DEFAULT_INTENT: UserIntent = {
  id: 'hl-hype-momentum-conservative',
  text: 'Trade HYPE perp on Hyperliquid. $10k capital. Momentum-driven entries only. Max 5% drawdown — pull back if you breach.',
  capital_usd: 10_000,
  dd_cap_pct: 5,
  venues: ['hyperliquid'],
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function createOperatorSession(operatorUrl: string, privateKey: string): Promise<{ token: string; expires_at: number }> {
  const challenge = await postJson<{ nonce: string; message: string }>(`${operatorUrl}/api/auth/challenge`, {})
  const signProc = spawnSync('cast', ['wallet', 'sign', '--private-key', privateKey, challenge.message], {
    encoding: 'utf8',
  })
  if (signProc.status !== 0) {
    throw new Error(`cast wallet sign failed: ${signProc.stderr}`)
  }
  const signature = signProc.stdout.trim()
  return postJson<{ token: string; expires_at: number }>(`${operatorUrl}/api/auth/session`, {
    nonce: challenge.nonce,
    signature,
  })
}

async function main(): Promise<void> {
  const operatorUrl = argValue('--operator-url') ?? 'http://127.0.0.1:9200'
  const privateKey = process.env.ARENA_E2E_PRIVATE_KEY ?? DEFAULT_E2E_PRIVATE_KEY
  const outDir = argValue('--out-dir') ?? `/tmp/full-eval-${Date.now()}`
  mkdirSync(outDir, { recursive: true })
  const intent = DEFAULT_INTENT
  const skipMultishot = process.argv.includes('--skip-multishot')
  const skipResearch = process.argv.includes('--skip-research')
  const skipRobustness = process.argv.includes('--skip-robustness')
  const reps = Number.parseInt(argValue('--reps') ?? '2', 10)
  const maxTurns = Number.parseInt(argValue('--max-turns') ?? '5', 10)

  process.stderr.write(
    `Full eval → ${outDir}\n  operator: ${operatorUrl}\n  reps=${reps} max_turns=${maxTurns}\n  multishot=${!skipMultishot} research=${!skipResearch} robustness=${!skipRobustness}\n\n`,
  )

  process.stderr.write('── Auth: operator session ──\n')
  const session = await createOperatorSession(operatorUrl, privateKey)
  process.stderr.write(`  token acquired (expires in ${Math.round((session.expires_at - Date.now() / 1000) / 60)}min)\n`)

  let multishot: Awaited<ReturnType<typeof runMultishotWithBaselines>> | undefined
  let researchPart: { shots: Awaited<ReturnType<typeof runResearchEval>>['shots']; scores: Awaited<ReturnType<typeof judgeAllResearchShots>> } | undefined
  let robustness: Awaited<ReturnType<typeof runRobustnessEval>> | undefined

  if (!skipMultishot) {
    process.stderr.write('── Multishot user-sim + adversarial baselines ──\n')
    multishot = await runMultishotWithBaselines({
      intents: [intent],
      operatorUrl,
      token: session.token,
      runDir: `${outDir}/multishot`,
      reps,
      maxTurnsPerShot: maxTurns,
    })
  }
  if (!skipResearch) {
    process.stderr.write('── Research depth eval ──\n')
    const r = await runResearchEval({ operatorUrl, token: session.token })
    const scores = await judgeAllResearchShots(r.shots, { resolveCitations: false })
    researchPart = { shots: r.shots, scores }
  }
  if (!skipRobustness) {
    process.stderr.write('── Adversarial robustness eval ──\n')
    robustness = await runRobustnessEval({ operatorUrl, token: session.token })
  }

  // Compose BotReportData
  const multishotShots: MultishotShot[] = []
  let baselineCmp: BotReportData['multishot'] extends { baselineComparison?: infer B } ? B : never
  let multishotReps = 0
  if (multishot) {
    multishotReps = multishot.real.aggregates.byJudge['user-sim-outcome']?.n ?? 0
    for (const [scenId, agg] of Object.entries(multishot.real.aggregates.byScenario)) {
      if (scenId !== intent.id) continue
      multishotShots.push({
        rep: 0,
        composite: agg.meanComposite,
        dimensions: {
          intent_fulfilled: agg.meanComposite,
          respected_constraints: agg.meanComposite,
          actually_traded_or_committed: agg.meanComposite,
          productive_conversation: agg.meanComposite,
        },
        turns: [],
        ended_by: 'done',
        total_wall_ms: 0,
      })
    }
    baselineCmp = {
      null_bot_composite: multishot.null_bot.aggregates.byScenario[intent.id]?.meanComposite ?? 0,
      stall_bot_composite: multishot.stall_bot.aggregates.byScenario[intent.id]?.meanComposite ?? 0,
      frontier_bot_composite: 0,
    } as never
  }
  // Composite weights — renormalised across the slices that actually
  // ran. Without renormalisation, a "perfect" bot would cap at 8.0
  // because the walkforward slice (weight 0.2) is missing in this
  // pipeline, contributing zero. Operator would then see
  // "iterate (A-tier)" for a bot that's actually S-tier on what was
  // measured.
  const w = { multishot: 0.3, research: 0.25, robustness: 0.25, walkforward: 0.2 }
  const multishotMean = multishotShots.length === 0
    ? 0
    : multishotShots.reduce((a, s) => a + s.composite, 0) / multishotShots.length
  const researchData = researchPart ? aggregateResearchData(researchPart.shots, researchPart.scores) : undefined
  // Each slice's contribution in 0..10 (multishot 0..1 * 10, research is already 0..10, robustness 0..1 * 10).
  const sliceContribs: Array<{ weight: number; score: number; present: boolean }> = [
    { weight: w.multishot, score: 10 * multishotMean, present: multishot !== undefined },
    { weight: w.research, score: researchData?.depth_score ?? 0, present: researchData !== undefined },
    { weight: w.robustness, score: 10 * (robustness?.summary.pass_rate ?? 0), present: robustness !== undefined },
    // walkforward is structurally absent in this pipeline today; flag it
    // so the renderer can note "WF not run" and the composite isn't capped.
    { weight: w.walkforward, score: 0, present: false },
  ]
  const activeSum = sliceContribs.filter((s) => s.present).reduce((acc, s) => acc + s.weight, 0)
  const sTier = activeSum === 0
    ? 0
    : sliceContribs.filter((s) => s.present).reduce((acc, s) => acc + s.weight * s.score, 0) / activeSum
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000)
  const reportData: BotReportData = {
    bot_id: intent.id,
    operator: 'drew',
    period_start_iso: periodStart.toISOString().slice(0, 10),
    period_end_iso: periodEnd.toISOString().slice(0, 10),
    intent_text: intent.text,
    capital_usd: intent.capital_usd,
    dd_cap_pct: intent.dd_cap_pct,
    s_tier_composite: sTier,
    ...(multishot
      ? { multishot: { reps: multishotReps, shots: multishotShots, ...(baselineCmp! ? { baselineComparison: baselineCmp! } : {}) } }
      : {}),
    ...(researchData ? { research: researchData } : {}),
    ...(robustness ? { robustness: robustness.summary } : {}),
  }
  const md = await renderBotReport(reportData)
  writeFileSync(resolve(outDir, 'per-bot-report.md'), md, 'utf8')
  writeFileSync(resolve(outDir, 'per-bot-report.json'), JSON.stringify(reportData, null, 2), 'utf8')
  // raw eval outputs (for the next pass to debug from)
  if (multishot) {
    writeFileSync(resolve(outDir, 'multishot-raw.json'), JSON.stringify({
      real_aggregates: multishot.real.aggregates,
      null_aggregates: multishot.null_bot.aggregates,
      stall_aggregates: multishot.stall_bot.aggregates,
      per_scenario_deltas: multishot.per_scenario_deltas,
    }, null, 2))
  }
  if (researchPart) writeFileSync(resolve(outDir, 'research-raw.json'), JSON.stringify(researchPart, null, 2))
  if (robustness) writeFileSync(resolve(outDir, 'robustness-raw.json'), JSON.stringify(robustness, null, 2))
  const fleet = buildFleetView([reportData])
  writeFleetView(fleet, resolve(outDir, 'fleet-view.md'), resolve(outDir, 'fleet-view.json'))
  const summary = {
    bot_id: intent.id,
    s_tier_composite: reportData.s_tier_composite,
    recommendation: fleet.leaderboard[0]?.recommendation,
    gaps: fleet.leaderboard[0]?.gap_summary,
    artifacts: {
      report_md: resolve(outDir, 'per-bot-report.md'),
      report_json: resolve(outDir, 'per-bot-report.json'),
      fleet_md: resolve(outDir, 'fleet-view.md'),
      fleet_json: resolve(outDir, 'fleet-view.json'),
    },
  }
  writeFileSync(resolve(outDir, 'full-eval-summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

await main()
