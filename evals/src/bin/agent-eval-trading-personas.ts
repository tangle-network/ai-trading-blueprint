#!/usr/bin/env node
import {
  runTradingPersonaAgentEvalBridge,
  type TradingPersonaBridgeOptions,
} from '../trading/persona-agent-eval.js'
import {
  runTradingProfileMatrix,
  type TradingProfileMatrixOptions,
} from '../trading/persona-profile-matrix.js'
import {
  runTradingConversationMatrix,
  type ConversationMatrixOptions,
} from '../trading/persona-conversation-matrix.js'
import { runTradingDecisionLoop } from '../trading/persona-decision-loop.js'
import { defaultScenarios } from '../trading/personas/scenarios.js'
import { STANDARD_USER_INTENTS } from '../sim/user-intents.js'
import { STANDARD_USER_PERSONAS } from '../sim/user-personas.js'
import type { LlmModel } from '../sim/llm-call.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

// CONVERSATION path: the OFFICIAL `runPersonaDispatch` adoption — sweep the
// worker-model PROFILE × persona scenarios as multi-turn conversations via
// `runProfileMatrix`. Opt-in via `TRADING_CONVERSATION_MATRIX=1` or `--conversation`.
if (process.env.TRADING_CONVERSATION_MATRIX === '1' || hasFlag('--conversation')) {
  const options: ConversationMatrixOptions = { intents: STANDARD_USER_INTENTS.slice(0, 3) }
  const runDir = argValue('--run-dir')
  const reps = argValue('--reps')
  const models = argValue('--models')
  const costCeiling = argValue('--cost-ceiling')
  const maxTurns = argValue('--max-turns')
  if (runDir) options.runDir = runDir
  if (reps) options.reps = Number(reps)
  if (models) options.models = models.split(',').map((m) => m.trim()) as LlmModel[]
  if (costCeiling) options.costCeiling = Number(costCeiling)
  if (maxTurns) options.maxTurns = Number(maxTurns)
  if (process.env.TRADING_CONVERSATION_MATRIX_INTEGRITY === 'warn') options.integrity = 'warn'
  options.personas = STANDARD_USER_PERSONAS.slice(0, 3)

  const summary = await runTradingConversationMatrix(options)
  console.log(JSON.stringify(summary, null, 2))
  const blind = summary.integrity.verdict === 'stub'
  const noWinner = summary.best === null
  if (blind || noWinner) process.exit(1)
}
// DECISION-LOOP path: the OFFICIAL `runPersonified` + `loopUntil` adoption — run
// a single operator persona through a multi-round decision-refinement loop whose
// `until` gate reads trace-derived findings. Opt-in via `--decision-loop`.
else if (process.env.TRADING_DECISION_LOOP === '1' || hasFlag('--decision-loop')) {
  const scenarioId = argValue('--scenario')
  const model = (argValue('--model') as LlmModel | undefined) ?? 'glm-5.1'
  const maxRounds = argValue('--max-rounds')
  const scenarios = defaultScenarios()
  const scenario = scenarioId ? scenarios.find((s) => s.id === scenarioId) : scenarios[0]
  if (!scenario) {
    console.error(`unknown scenario "${scenarioId}". Known: ${scenarios.map((s) => s.id).join(', ')}`)
    process.exit(2)
  }
  const summary = await runTradingDecisionLoop({
    scenario,
    model,
    ...(maxRounds ? { maxRounds: Number(maxRounds) } : {}),
  })
  console.log(JSON.stringify(summary, null, 2))
  // Non-zero exit when the loop produced no deliverable (fail-loud, never a
  // vacuous done).
  if (summary.kind !== 'winner' || summary.decision === null) process.exit(1)
}
// MATRIX path: sweep the PROFILE axis (model variants) × persona scenarios via
// `runProfileMatrix`. Opt-in via `TRADING_PERSONA_MATRIX=1` or `--matrix`.
else if (process.env.TRADING_PERSONA_MATRIX === '1' || hasFlag('--matrix')) {
  const options: TradingProfileMatrixOptions = {}
  const runDir = argValue('--run-dir')
  const scorecard = argValue('--scorecard')
  const reps = argValue('--reps')
  const models = argValue('--models')
  const costCeiling = argValue('--cost-ceiling')
  if (runDir) options.runDir = runDir
  if (scorecard) options.scorecardPath = scorecard
  if (reps) options.reps = Number(reps)
  if (models) options.models = models.split(',').map((m) => m.trim()) as LlmModel[]
  if (costCeiling) options.costCeiling = Number(costCeiling)
  // 'warn' lets a dry run proceed without LLM keys; default 'assert' fails loud
  // when a profile ran stub (the matrix would otherwise report a blind board).
  if (process.env.TRADING_PERSONA_MATRIX_INTEGRITY === 'warn') options.integrity = 'warn'

  const summary = await runTradingProfileMatrix(options)
  console.log(JSON.stringify(summary, null, 2))
  // Non-zero exit when any profile ran stub or no profile cleared the suite gate.
  const blind = summary.integrity.verdict === 'stub'
  const noWinner = summary.best === null
  if (blind || noWinner) process.exit(1)
} else {
  const options: TradingPersonaBridgeOptions = {}
  const reportPath = argValue('--out')
  const traceDir = argValue('--trace-dir')
  const runsJsonl = argValue('--runs-jsonl') ?? argValue('--runs')
  if (reportPath) options.reportPath = reportPath
  if (traceDir) options.traceDir = traceDir
  if (runsJsonl) options.runsJsonl = runsJsonl

  const summary = await runTradingPersonaAgentEvalBridge(options)
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed > 0) process.exit(1)
}
