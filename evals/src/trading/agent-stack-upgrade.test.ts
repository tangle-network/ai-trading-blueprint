import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runProfileMatrix } from '@tangle-network/agent-eval/campaign'
import { selfImprove } from '@tangle-network/agent-eval/contract'

import { dollarArg } from '../bin/trading-persona-cli.js'
import { modelExecutionIdentity } from '../sim/model-routing.js'
import {
  harnessBacktestExecutionIdentity,
  validateCandleTimeWindow,
} from './harness-dispatch.js'
import { buildPerBotWindowPlan } from './per-bot-windows.js'
import {
  deterministicExecutionIdentity,
  validateCostLimits,
} from './persona-eval-contracts.js'
import { buildTradingScorecardAgentProfile } from './scorecard-integration.js'
import type { BotContext } from './harness-types.js'

const BOT: BotContext = {
  id: 'hl-btc',
  source: 'hyperliquid',
  symbol: 'BTC',
  fee_protocol: 'hyperliquid_perp',
  venue_label: 'hyperliquid',
}

test('backtest identity hashes the exact executable bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-identity-'))
  const binary = join(dir, 'harness_backtest')
  try {
    const bytes = Buffer.from('exact executable bytes')
    writeFileSync(binary, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.equal(
      harnessBacktestExecutionIdentity(binary),
      `trading-runtime/harness-backtest@sha256:${digest}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agent Eval 0.134.1 accepts deterministic improvement with identity and no paid usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-improve-contract-'))
  try {
    const finalScenario = { id: 'final', kind: 'test' }
    const result = await selfImprove({
      model: `trading-runtime/harness-backtest@sha256:${'a'.repeat(64)}`,
      agent: async () => ({ score: 1 }),
      scenarios: [{ id: 'train', kind: 'test' }, finalScenario],
      judge: {
        name: 'deterministic-score',
        dimensions: [{ key: 'score', description: 'deterministic score' }],
        score: ({ artifact }) => ({
          dimensions: { score: artifact.score },
          composite: artifact.score,
          notes: 'deterministic contract check',
        }),
      },
      baselineSurface: '{}',
      budget: { generations: 0, holdoutScenarios: [finalScenario] },
      runDir: dir,
      captureSource: 'eval-run',
      expectUsage: 'off',
    })
    assert.equal(result.raw.baselineCampaign.cells.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('per-bot search ranges are disjoint from the final range', () => {
  const endTimeSec = 500_000 * 3_600
  const plan = buildPerBotWindowPlan(BOT, {
    trainCandlesLimit: 48,
    holdoutCandlesLimit: 12,
    windowEndTimeSec: endTimeSec,
  })

  assert.equal(plan.holdoutScenario.candleWindow.endTimeSec, endTimeSec)
  assert.equal(
    plan.holdoutScenario.candleWindow.endTimeSec -
      plan.holdoutScenario.candleWindow.startTimeSec,
    12 * 3_600,
  )
  for (const search of plan.searchScenarios) {
    assert.equal(
      search.candleWindow.endTimeSec,
      plan.holdoutScenario.candleWindow.startTimeSec,
    )
    assert.ok(search.candleWindow.endTimeSec <= plan.holdoutScenario.candleWindow.startTimeSec)
    assert.equal(
      search.candleWindow.endTimeSec - search.candleWindow.startTimeSec,
      search.candlesLimit * 3_600,
    )
  }
})

test('candle ranges reject unsafe or overlapping-by-construction inputs', () => {
  assert.throws(
    () =>
      buildPerBotWindowPlan(BOT, {
        trainCandlesLimit: 12,
        holdoutCandlesLimit: 12,
        windowEndTimeSec: 500_000 * 3_600,
      }),
    /must be greater/,
  )
  assert.throws(
    () => validateCandleTimeWindow({ startTimeSec: 100, endTimeSec: 100 }),
    /invalid candle window/,
  )
})

test('persona profiles record real provider releases without invented dates', () => {
  const identities = [
    modelExecutionIdentity('kimi-k2'),
    modelExecutionIdentity('glm-4.7'),
    modelExecutionIdentity('glm-5.1'),
  ]
  assert.deepEqual(identities, [
    'moonshot/kimi-k2.6@2.6',
    'zai/glm-4.7@4.7',
    'zai/glm-5.1@5.1',
  ])
  assert.ok(identities.every((identity) => identity.includes('@')))
})

test('deterministic persona identity is derived from a real commit', () => {
  const commit = 'a'.repeat(40)
  assert.equal(
    deterministicExecutionIdentity(commit),
    `deterministic-trading-runtime@git:${commit}`,
  )
  assert.throws(() => deterministicExecutionIdentity('2026-06-01'), /git SHA/)
})

test('profile spend requires a valid total and provider-enforced cell limit', () => {
  assert.equal(validateCostLimits(undefined, undefined), undefined)
  assert.deepEqual(validateCostLimits(10, 2), {
    costCeiling: 10,
    providerCellCostLimit: 2,
  })
  assert.throws(() => validateCostLimits(10, undefined), /supplied together/)
  assert.throws(() => validateCostLimits(undefined, 2), /supplied together/)
  assert.throws(() => validateCostLimits(Number.NaN, 1), /finite/)
  assert.throws(() => validateCostLimits(1, 2), /cannot exceed/)
})

test('runProfileMatrix enforces the dollar cap before paid work starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-cap-contract-'))
  let paidWorkStarted = false
  try {
    const result = await runProfileMatrix({
      profiles: [
        buildTradingScorecardAgentProfile({
          surfaceVersion: 1,
          runtimeVersion: 'test',
          venues: [],
          feeScheduleVersion: 'test',
          model: 'provider/model@release-1',
        }),
      ],
      scenarios: [{ id: 'cap-scenario', kind: 'test' }],
      runDir: dir,
      commitSha: 'a'.repeat(40),
      costCeiling: 1,
      integrity: 'off',
      validate: false,
      dispatch: async (_profile, _scenario, ctx) => {
        const paid = await ctx.cost.runPaidCall({
          actor: 'cap-contract-test',
          model: 'provider/model@release-1',
          maximumCharge: { externallyEnforcedMaximumUsd: 2 },
          execute: async () => {
            paidWorkStarted = true
            return {
              model: 'provider/model@release-1',
              inputTokens: 1,
              outputTokens: 1,
              actualCostUsd: 1,
              value: { ok: true },
            }
          },
          receipt: (call) => ({
            model: call.model,
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            actualCostUsd: call.actualCostUsd,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return paid.value
      },
    })

    assert.equal(paidWorkStarted, false)
    assert.deepEqual(result.records.map((record) => record.terminalOutcome), ['failed'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI dollar flags reject invalid amounts before an eval starts', () => {
  assert.equal(dollarArg(['node', 'eval', '--cost-ceiling', '12.5'], '--cost-ceiling'), 12.5)
  assert.equal(dollarArg(['node', 'eval'], '--cost-ceiling'), undefined)
  assert.throws(
    () => dollarArg(['node', 'eval', '--cost-ceiling', 'not-a-number'], '--cost-ceiling'),
    /finite/,
  )
  assert.throws(
    () => dollarArg(['node', 'eval', '--cost-ceiling', '-1'], '--cost-ceiling'),
    /non-negative/,
  )
  assert.throws(
    () => dollarArg(['node', 'eval', '--cost-ceiling'], '--cost-ceiling'),
    /requires a USD amount/,
  )
})
