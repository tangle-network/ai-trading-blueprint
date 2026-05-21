import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { run, runShell } from '../lib/process.js'
import { isoStamp, resolveRepo } from '../lib/repo.js'
import { runSelfImprovementMcpEval } from '../self-improvement/mcp-eval.js'
import { runTradingLifecycleEval } from '../trading/lifecycle-runner.js'
import { runTradingPersonaAgentEvalBridge } from '../trading/persona-agent-eval.js'

export interface FullEvalOptions {
  outputPath?: string
  livePolymarket?: boolean
}

interface GateResult {
  name: string
  passed: boolean
  duration_ms: number
  output?: string
  evidence?: unknown
  error?: string
}

export async function runFullEval(options: FullEvalOptions = {}) {
  const started = Date.now()
  const stamp = isoStamp()
  const outputPath = resolveRepo(options.outputPath ?? `.evolve/evals/full-eval-${stamp}.json`)
  const gates: GateResult[] = []

  await gate(gates, 'typescript-evals-typecheck', async () => {
    run('npm', ['run', 'typecheck:evals'])
  })
  await gate(gates, 'rust-persona-coverage-test', async () => {
    run('cargo', ['test', '-p', 'trading-runtime', 'persona_eval_suite_has_required_coverage_and_passes'])
  })
  await gate(gates, 'trading-persona-agent-eval', async () => runTradingPersonaAgentEvalBridge({
    reportPath: `.evolve/evals/full-personas-${stamp}.json`,
    traceDir: `.evolve/agent-eval/traces/full-personas-${stamp}`,
    runsJsonl: `.evolve/agent-eval/full-persona-runs-${stamp}.jsonl`,
  }))
  await gate(gates, 'trading-lifecycle-real-api', async () => runTradingLifecycleEval({
    outputPath: resolveRepo(`.evolve/evals/full-lifecycle-${stamp}.json`),
    personaReportPath: resolveRepo(`.evolve/evals/full-lifecycle-personas-${stamp}.json`),
    feedbackJsonlPath: resolveRepo(`.evolve/agent-eval/full-lifecycle-feedback-${stamp}.jsonl`),
    mode: 'real-api',
  }))
  await gate(gates, 'self-improvement-mcp-real-opencode', async () => runSelfImprovementMcpEval({
    outputPath: resolveRepo(`.evolve/evals/full-self-improvement-mcp-${stamp}.json`),
  }))
  if (options.livePolymarket) {
    await gate(gates, 'live-polymarket-price-history', async () => {
      const out = resolveRepo(`.evolve/evals/full-real-polymarket-${stamp}.json`)
      runShell(`cargo run -p trading-runtime --example polymarket_real_price_eval -- --out ${JSON.stringify(out)}`)
      return { output: out }
    })
  }

  const passed = gates.filter((gate) => gate.passed).length
  const summary = {
    suite: 'ai-trading-blueprint-full-eval',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    passed,
    failed: gates.length - passed,
    total: gates.length,
    success_rate: gates.length === 0 ? 0 : passed / gates.length,
    gates,
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { ...summary, output: outputPath }
}

async function gate(gates: GateResult[], name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  const started = Date.now()
  try {
    const evidence = await fn()
    const result: GateResult = {
      name,
      passed: true,
      duration_ms: Date.now() - started,
      evidence,
    }
    if (typeof evidence === 'object' && evidence && 'output' in evidence) {
      result.output = String(evidence.output)
    }
    gates.push(result)
  } catch (error) {
    gates.push({
      name,
      passed: false,
      duration_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
