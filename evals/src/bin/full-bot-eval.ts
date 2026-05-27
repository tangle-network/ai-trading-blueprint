#!/usr/bin/env node
/**
 * Full per-bot eval — single bin, two boot modes:
 *
 *   --boot-stack   : run runLocalProductE2E to boot anvil+operator+sidecar,
 *                    then run the full eval inside afterProvision
 *   (default)      : assume devnet is already running (e.g., booted via
 *                    `scripts/run-devnet.sh --no-ui`), auth directly to
 *                    --operator-url (default http://127.0.0.1:9200), run
 *                    the full eval against it
 *
 * Pipeline (one bot, one operator session):
 *   1. Multishot user-sim with adversarial baselines (real/null/stall),
 *      reps=5 default, dual judge (primary haiku + skeptical secondary)
 *   2. Research-depth eval across STANDARD_THESIS_QUESTIONS
 *   3. Adversarial robustness eval across ROBUSTNESS_SCENARIOS
 *   4. Compose BotReportData; render S-tier per-bot markdown report
 *   5. Build fleet-view (K=1 row for now; multi-bot fleet is N rows)
 *
 * Outputs:
 *   <out-dir>/per-bot-report.md
 *   <out-dir>/per-bot-report.json
 *   <out-dir>/fleet-view.md
 *   <out-dir>/fleet-view.json
 *   <out-dir>/full-eval-summary.json
 *   <out-dir>/multishot-raw.json + research-raw.json + robustness-raw.json
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runLocalProductE2E } from '../product/local-stack-runner.js'
import { aggregateResearchData, runResearchEval } from '../research/research-driver.js'
import { judgeAllResearchShots } from '../research/research-judge.js'
import { renderBotReport } from '../report/render.js'
import type { BotReportData, MultishotShot } from '../report/types.js'
import { runRobustnessEval } from '../robustness/robustness-driver.js'
import { buildFleetView, writeFleetView } from '../fleet/fleet-aggregator.js'
import { aggregateBotArtifacts } from '../sim/bot-artifacts.js'
import { OperatorClient } from '../sim/operator-client.js'
import { runMultishotWithBaselines } from '../sim/multishot-user-sim.js'
import { STANDARD_USER_INTENTS, getIntent } from '../sim/user-intents.js'
import { STANDARD_USER_PERSONAS, getPersona } from '../sim/user-personas.js'
import type { UserIntent } from '../sim/user-sim-driver.js'

// PUBLIC anvil default; never replace with a real key — this stays for local devnet use.
const DEFAULT_E2E_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const DEFAULT_INTENT: UserIntent = getIntent('hl-hype-tight-dd')

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

interface RunEvalOpts {
  operatorUrl: string
  token: string
  outDir: string
  intents: UserIntent[]
  /** Persona ids to cross with intents. Empty = base voice across intents only. */
  personaIds: string[]
  reps: number
  maxTurnsPerShot: number
  skipMultishot: boolean
  skipResearch: boolean
  skipRobustness: boolean
}

interface EvalPartial {
  multishot?: Awaited<ReturnType<typeof runMultishotWithBaselines>>
  research?: { shots: Awaited<ReturnType<typeof runResearchEval>>['shots']; scores: Awaited<ReturnType<typeof judgeAllResearchShots>> }
  robustness?: Awaited<ReturnType<typeof runRobustnessEval>>
}

function writeCheckpoint(outDir: string, partial: EvalPartial): void {
  // Write a phase-by-phase checkpoint so a runner kill (SSH teardown,
  // OOM, ^C) doesn't lose hours of work. The bin's final
  // `writeArtifacts` call still runs at the end and overwrites these
  // with the canonical artifacts; this is the resilience layer.
  if (partial.multishot) {
    writeFileSync(resolve(outDir, 'checkpoint-multishot.json'), JSON.stringify({
      real_aggregates: partial.multishot.real.aggregates,
      null_aggregates: partial.multishot.null_bot.aggregates,
      stall_aggregates: partial.multishot.stall_bot.aggregates,
      per_scenario_deltas: partial.multishot.per_scenario_deltas,
    }, null, 2))
  }
  if (partial.research) {
    writeFileSync(resolve(outDir, 'checkpoint-research.json'), JSON.stringify(partial.research, null, 2))
  }
  if (partial.robustness) {
    writeFileSync(resolve(outDir, 'checkpoint-robustness.json'), JSON.stringify(partial.robustness, null, 2))
  }
}

async function runEvals(args: RunEvalOpts): Promise<EvalPartial> {
  const partial: EvalPartial = {}
  if (!args.skipMultishot) {
    const personas = args.personaIds.length > 0 ? args.personaIds.map(getPersona) : []
    const cellsDescription = personas.length > 0
      ? `${personas.length} personas × ${args.intents.length} intents × 3 arms × ${args.reps} reps = ${personas.length * args.intents.length * 3 * args.reps} cells`
      : `${args.intents.length} intents × 3 arms × ${args.reps} reps = ${args.intents.length * 3 * args.reps} cells`
    process.stderr.write(`── Multishot user-sim + adversarial baselines (${cellsDescription}) ──\n`)
    partial.multishot = await runMultishotWithBaselines({
      intents: args.intents,
      ...(personas.length > 0 ? { personas } : {}),
      operatorUrl: args.operatorUrl,
      token: args.token,
      runDir: `${args.outDir}/multishot`,
      reps: args.reps,
      maxTurnsPerShot: args.maxTurnsPerShot,
    })
    writeCheckpoint(args.outDir, partial)
    process.stderr.write(`  ✓ multishot complete, checkpoint written\n`)
  }
  if (!args.skipResearch) {
    process.stderr.write('── Research depth eval ──\n')
    const r = await runResearchEval({ operatorUrl: args.operatorUrl, token: args.token })
    const scores = await judgeAllResearchShots(r.shots, { resolveCitations: false })
    partial.research = { shots: r.shots, scores }
    writeCheckpoint(args.outDir, partial)
    process.stderr.write(`  ✓ research complete, checkpoint written\n`)
  }
  if (!args.skipRobustness) {
    process.stderr.write('── Adversarial robustness eval ──\n')
    partial.robustness = await runRobustnessEval({ operatorUrl: args.operatorUrl, token: args.token })
    writeCheckpoint(args.outDir, partial)
    process.stderr.write(`  ✓ robustness complete, checkpoint written\n`)
  }
  return partial
}

function composeBotReportData(headerIntent: UserIntent, partial: EvalPartial): BotReportData {
  const multishotShots: MultishotShot[] = []
  let multishotReps = 0
  let baselineComparison: { null_bot_composite: number; stall_bot_composite: number; frontier_bot_composite: number } | undefined
  if (partial.multishot) {
    multishotReps = partial.multishot.real.aggregates.byJudge['user-sim-outcome']?.n ?? 0
    // CampaignResult.cells carries per-cell artifact + judge scores —
    // the per-rep transcript data lives here, NOT in aggregates.byScenario
    // (which was the audit HIGH #4 bug). Walk cells directly.
    for (const cell of partial.multishot.real.cells) {
      // Failed cells (dispatch threw) carry null artifact + error. Surface
      // them as a stub shot so the operator sees the failure in the
      // report instead of silently dropping it.
      if (!cell.artifact) {
        process.stderr.write(`  ! cell ${cell.cellId} (${cell.scenarioId} rep ${cell.rep}) FAILED: ${cell.error ?? 'unknown error'}\n`)
        multishotShots.push({
          rep: cell.rep,
          composite: 0,
          dimensions: { intent_fulfilled: 0, respected_constraints: 0, actually_traded_or_committed: 0, productive_conversation: 0 },
          turns: [],
          ended_by: 'stall',
          total_wall_ms: cell.durationMs,
        })
        continue
      }
      const artifact = cell.artifact as import('../sim/user-sim-driver.js').UserSimSessionResult
      const judgeScore = cell.judgeScores['user-sim-outcome']
      const dims = (judgeScore?.dimensions ?? {}) as Record<string, number>
      multishotShots.push({
        rep: cell.rep,
        composite: judgeScore?.composite ?? 0,
        dimensions: {
          intent_fulfilled: dims.intent_fulfilled ?? 0,
          respected_constraints: dims.respected_constraints ?? 0,
          actually_traded_or_committed: dims.actually_traded_or_committed ?? 0,
          productive_conversation: dims.productive_conversation ?? 0,
        },
        turns: artifact.turns ?? [],
        ended_by: artifact.ended_by ?? 'done',
        total_wall_ms: artifact.total_wall_ms ?? 0,
      })
    }
    // Baselines: aggregate the null/stall mean across all scenarios for the
    // top-line bot-quality comparison.
    const meanAcross = (camp: typeof partial.multishot.real): number => {
      const vals = Object.values(camp.aggregates.byScenario).map((a) => a.meanComposite)
      return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length
    }
    baselineComparison = {
      null_bot_composite: meanAcross(partial.multishot.null_bot),
      stall_bot_composite: meanAcross(partial.multishot.stall_bot),
      frontier_bot_composite: 0,
    }
  }

  // Aggregate bot-artifacts across every cell that captured them. This is
  // the "did the bot do the work" surface — self-improvement runs, trades,
  // PnL. Surfaces ahead of conversation judges in the report.
  const allBotArtifacts = [
    // Multishot real-arm cells carry bot_artifacts via UserSimSessionResult.
    // Skip failed cells (null artifact).
    ...(partial.multishot?.real.cells
      .filter((c) => c.artifact !== null && c.artifact !== undefined)
      .map((c) => (c.artifact as import('../sim/user-sim-driver.js').UserSimSessionResult).bot_artifacts ?? null) ?? []),
    ...(partial.research?.shots.map((s) => s.bot_artifacts) ?? []),
    ...(partial.robustness?.shots.map((s) => s.bot_artifacts) ?? []),
  ]
  const artifactsAggregate = aggregateBotArtifacts(allBotArtifacts)

  // Composite weights — renormalised across the slices that actually ran
  // so a perfect bot scores 10.00 even when WF is absent (audit fix #5).
  const w = { multishot: 0.3, research: 0.25, robustness: 0.25, walkforward: 0.2 }
  const multishotMean = multishotShots.length === 0
    ? 0
    : multishotShots.reduce((a, s) => a + s.composite, 0) / multishotShots.length
  const researchData = partial.research ? aggregateResearchData(partial.research.shots, partial.research.scores) : undefined
  const sliceContribs = [
    { weight: w.multishot, score: 10 * multishotMean, present: partial.multishot !== undefined },
    { weight: w.research, score: researchData?.depth_score ?? 0, present: researchData !== undefined },
    { weight: w.robustness, score: 10 * (partial.robustness?.summary.pass_rate ?? 0), present: partial.robustness !== undefined },
    { weight: w.walkforward, score: 0, present: false },
  ]
  const activeSum = sliceContribs.filter((s) => s.present).reduce((a, s) => a + s.weight, 0)
  const sTier = activeSum === 0
    ? 0
    : sliceContribs.filter((s) => s.present).reduce((a, s) => a + s.weight * s.score, 0) / activeSum

  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000)
  return {
    bot_id: headerIntent.id,
    operator: 'drew',
    period_start_iso: periodStart.toISOString().slice(0, 10),
    period_end_iso: periodEnd.toISOString().slice(0, 10),
    intent_text: headerIntent.text,
    capital_usd: headerIntent.capital_usd,
    dd_cap_pct: headerIntent.dd_cap_pct,
    s_tier_composite: sTier,
    ...(partial.multishot
      ? {
          multishot: {
            reps: multishotReps,
            shots: multishotShots,
            ...(baselineComparison ? { baselineComparison } : {}),
          },
        }
      : {}),
    ...(researchData ? { research: researchData } : {}),
    ...(partial.robustness ? { robustness: partial.robustness.summary } : {}),
    ...(artifactsAggregate.cells_inspected > 0 ? { artifacts: artifactsAggregate } : {}),
  }
}

async function writeArtifacts(outDir: string, headerIntent: UserIntent, partial: EvalPartial): Promise<void> {
  const reportData = composeBotReportData(headerIntent, partial)
  const md = await renderBotReport(reportData)
  writeFileSync(resolve(outDir, 'per-bot-report.md'), md, 'utf8')
  writeFileSync(resolve(outDir, 'per-bot-report.json'), JSON.stringify(reportData, null, 2), 'utf8')
  if (partial.multishot) {
    writeFileSync(resolve(outDir, 'multishot-raw.json'), JSON.stringify({
      real_aggregates: partial.multishot.real.aggregates,
      null_aggregates: partial.multishot.null_bot.aggregates,
      stall_aggregates: partial.multishot.stall_bot.aggregates,
      per_scenario_deltas: partial.multishot.per_scenario_deltas,
    }, null, 2))
  }
  if (partial.research) writeFileSync(resolve(outDir, 'research-raw.json'), JSON.stringify(partial.research, null, 2))
  if (partial.robustness) writeFileSync(resolve(outDir, 'robustness-raw.json'), JSON.stringify(partial.robustness, null, 2))
  const fleet = buildFleetView([reportData])
  writeFleetView(fleet, resolve(outDir, 'fleet-view.md'), resolve(outDir, 'fleet-view.json'))
  const summary = {
    bot_id: headerIntent.id,
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

function parseList(arg: string | undefined): string[] {
  if (!arg) return []
  return arg.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

async function main(): Promise<void> {
  const outDir = argValue('--out-dir') ?? `/tmp/full-eval-${Date.now()}`
  mkdirSync(outDir, { recursive: true })
  // Intents — explicit comma-separated ids OR a single intent id OR the
  // header default. Use --intents all to run the full STANDARD catalog.
  const intentsArg = argValue('--intents') ?? 'hl-hype-tight-dd'
  const intents: UserIntent[] = intentsArg === 'all'
    ? STANDARD_USER_INTENTS
    : parseList(intentsArg).map(getIntent)
  // Personas — comma-separated ids; "all" for the full catalog; empty
  // for the base voice (no persona).
  const personasArg = argValue('--personas') ?? ''
  const personaIds: string[] = personasArg === 'all'
    ? STANDARD_USER_PERSONAS.map((p) => p.id)
    : parseList(personasArg)
  const headerIntent = intents[0] ?? DEFAULT_INTENT
  const skipMultishot = process.argv.includes('--skip-multishot')
  const skipResearch = process.argv.includes('--skip-research')
  const skipRobustness = process.argv.includes('--skip-robustness')
  const reps = Number.parseInt(argValue('--reps') ?? '5', 10)
  const maxTurns = Number.parseInt(argValue('--max-turns') ?? '5', 10)
  const bootStack = process.argv.includes('--boot-stack')

  const intentLabel = intents.length > 1 ? `${intents.length} intents` : intents[0]?.id ?? '(none)'
  const personaLabel = personaIds.length > 0 ? `${personaIds.length} personas` : '(base voice)'
  process.stderr.write(
    `Full eval → ${outDir}\n  boot_stack=${bootStack}\n  intents=${intentLabel} personas=${personaLabel}\n  reps=${reps} max_turns=${maxTurns}\n  multishot=${!skipMultishot} research=${!skipResearch} robustness=${!skipRobustness}\n\n`,
  )

  if (bootStack) {
    // Boot anvil+operator+sidecar via local-stack-runner; run inside afterProvision
    // so the operator session token is captured for the inner evals.
    await runLocalProductE2E({
      startStack: true,
      keepStack: process.argv.includes('--keep-stack'),
      ...(argValue('--base-url') ? { baseUrl: argValue('--base-url')! } : {}),
      ...(argValue('--operator-url') ? { operatorUrl: argValue('--operator-url')! } : {}),
      afterProvision: async (context) => {
        const partial = await runEvals({
          operatorUrl: context.operatorUrl,
          token: context.token,
          outDir,
          intents,
          personaIds,
          reps,
          maxTurnsPerShot: maxTurns,
          skipMultishot,
          skipResearch,
          skipRobustness,
        })
        await writeArtifacts(outDir, headerIntent, partial)
        return { evals_run: { multishot: !skipMultishot, research: !skipResearch, robustness: !skipRobustness } }
      },
      maxTurns: 0,
    })
    return
  }

  // No-boot path: assume devnet already running, auth directly via OperatorClient.
  const operatorUrl = argValue('--operator-url') ?? 'http://127.0.0.1:9200'
  const privateKey = process.env.ARENA_E2E_PRIVATE_KEY ?? DEFAULT_E2E_PRIVATE_KEY
  process.stderr.write(`── Auth: operator session @ ${operatorUrl} ──\n`)
  const client = await OperatorClient.authenticate(operatorUrl, privateKey)
  // We need the raw token to pass into the eval drivers (they construct
  // their own OperatorClient instances). Re-do the auth to get the token;
  // a cleaner API would expose `client.token` but we keep that private
  // for the same reason every HTTP-client library does.
  const challenge = await (await fetch(`${operatorUrl}/api/auth/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json() as { nonce: string; message: string }
  const { spawnSync } = await import('node:child_process')
  const sig = spawnSync('cast', ['wallet', 'sign', '--private-key', privateKey, challenge.message], { encoding: 'utf8' })
  if (sig.status !== 0) throw new Error(`cast sign failed: ${sig.stderr}`)
  const session = await (await fetch(`${operatorUrl}/api/auth/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: challenge.nonce, signature: sig.stdout.trim() }),
  })).json() as { token: string; expires_at: number }
  process.stderr.write(`  token acquired (expires in ${Math.round((session.expires_at - Date.now() / 1000) / 60)}min)\n`)
  // Silence the unused-warning on `client` — it was constructed to validate
  // the auth flow; the eval drivers construct their own clients with the token.
  void client

  const partial = await runEvals({
    operatorUrl,
    token: session.token,
    outDir,
    intents,
    personaIds,
    reps,
    maxTurnsPerShot: maxTurns,
    skipMultishot,
    skipResearch,
    skipRobustness,
  })
  await writeArtifacts(outDir, headerIntent, partial)
}

await main()
