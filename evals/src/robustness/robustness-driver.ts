/**
 * Adversarial robustness eval driver (SPEC.md §5 eval #5).
 *
 * For each `RobustnessScenario`:
 *   1. Provisions a fresh bot through the shared OperatorClient
 *   2. Plays the scripted user turns
 *   3. Captures the bot's responses (NEW assistant message per user turn)
 *   4. Hands the transcript to the judge for graceful-handling verdict
 *
 * The judge is adversarial — it checks the scenario's `failure_signature`
 * against the bot's actual responses. A bot whose prose says "I respect
 * your DD cap" while placing an oversized order STILL fails.
 */

import type { RobustnessEvalData } from '../report/types.js'
import { inspectBotArtifacts, type BotArtifacts } from '../sim/bot-artifacts.js'
import { runProfileJson } from '../sim/llm-call.js'
import { robustnessJudgeProfile } from '../profiles/robustness-judge.js'
import { deterministicAgentEnv, OperatorClient } from '../sim/operator-client.js'
import { inferStrategyTypeFromVenues } from '../sim/strategy-type.js'
import { ROBUSTNESS_SCENARIOS, type RobustnessScenario } from './scenarios.js'

export interface RobustnessShotResult {
  scenario: RobustnessScenario
  bot_responses: string[]
  total_wall_ms: number
  graceful_handling: 0 | 1
  bot_response_summary: string
  judge_rationale: string
  bot_artifacts: BotArtifacts | null
}

interface RunRobustnessEvalOptions {
  operatorUrl: string
  token: string
  scenarios?: RobustnessScenario[]
  perTurnTimeoutMs?: number
}

interface JudgeVerdict {
  graceful_handling: number | string | boolean
  bot_response_summary?: string
  judge_rationale?: string
}

async function judgeGracefulHandling(
  scenario: RobustnessScenario,
  responses: string[],
): Promise<{ graceful: 0 | 1; summary: string; rationale: string }> {
  const transcript = scenario.user_turns
    .map((u, i) => `USER: ${u}\nBOT: ${(responses[i] ?? '(no reply)').slice(0, 1500)}`)
    .join('\n\n')
  // Rubric + model live in the profile (evals/src/profiles/robustness-judge.ts);
  // per-scenario data rides in the user message.
  const message = `Scenario: ${scenario.description}
Bot's stated constraints: $${scenario.capital_usd} capital, ${scenario.dd_cap_pct}% DD cap, venues: ${scenario.venues.join(', ')}.

Expected behaviour: ${scenario.expected_behaviour}
Failure signature: ${scenario.failure_signature}

Transcript:
${transcript}`
  const { result, raw } = await runProfileJson<JudgeVerdict>(robustnessJudgeProfile, { message })
  if (!result) {
    return {
      graceful: 0,
      summary: '(judge unavailable)',
      rationale: !raw.ok ? `judge_failed: ${raw.stderr.slice(0, 200)}` : `judge_unparseable: ${raw.output.slice(0, 200)}`,
    }
  }
  // Coerce — the LLM might emit number 1, string '1', boolean true, etc.
  const g = result.graceful_handling
  const graceful: 0 | 1 = g === 1 || g === '1' || g === true || Number(g) === 1 ? 1 : 0
  return {
    graceful,
    summary: result.bot_response_summary ?? '',
    rationale: result.judge_rationale ?? '',
  }
}

export async function runRobustnessEval(opts: RunRobustnessEvalOptions): Promise<{ shots: RobustnessShotResult[]; summary: RobustnessEvalData }> {
  const client = new OperatorClient({ operatorUrl: opts.operatorUrl, token: opts.token })
  const scenarios = opts.scenarios ?? ROBUSTNESS_SCENARIOS
  const shots: RobustnessShotResult[] = []
  for (const scenario of scenarios) {
    process.stderr.write(`  · robustness scenario: ${scenario.id}…\n`)
    const startedAt = Date.now()
    // Generic provisioning prompt — NOT the first scenario turn (would
    // double-send via prompt then chat). strategy_type derived from
    // venues so e.g. polymarket scenarios get a 'prediction' bot.
    const provisioningPrompt =
      `Robustness scenario ${scenario.id}: ${scenario.description}. Operator constraints: $${scenario.capital_usd} capital, ${scenario.dd_cap_pct}% max DD, venues ${scenario.venues.join(',')}.`
    const botId = await client.provisionBot({
      prompt: provisioningPrompt,
      name: `robustness:${scenario.id}`,
      strategy_type: inferStrategyTypeFromVenues(scenario.venues),
    })
    await client.waitForVaultResolved(botId)
    await client.configureSecrets(botId, deterministicAgentEnv())
    const sessionId = await client.createSession(botId, `robustness:${scenario.id}`)
    const responses: string[] = []
    let lastSeenAssistantId: string | null = null
    for (const userTurn of scenario.user_turns) {
      await client.sendMessage(botId, sessionId, userTurn)
      const reply = await client.waitForAssistantReply({
        botId,
        sessionId,
        sinceMessageId: lastSeenAssistantId,
        timeoutMs: opts.perTurnTimeoutMs ?? 180_000,
      })
      responses.push(reply.text)
      lastSeenAssistantId = reply.latestAssistantId
    }
    const verdict = await judgeGracefulHandling(scenario, responses)
    let artifacts: BotArtifacts | null = null
    try {
      artifacts = await inspectBotArtifacts(client, botId)
    } catch (e) {
      process.stderr.write(`    ! artifact inspection failed for ${scenario.id}: ${(e as Error).message.slice(0, 200)}\n`)
    }
    shots.push({
      scenario,
      bot_responses: responses,
      total_wall_ms: Date.now() - startedAt,
      graceful_handling: verdict.graceful,
      bot_response_summary: verdict.summary,
      judge_rationale: verdict.rationale,
      bot_artifacts: artifacts,
    })
  }
  const passed = shots.filter((s) => s.graceful_handling === 1).length
  const summary: RobustnessEvalData = {
    pass_rate: shots.length === 0 ? 0 : passed / shots.length,
    scenarios_tested: shots.map((s) => ({
      scenario_id: s.scenario.id,
      description: s.scenario.description,
      graceful_handling: s.graceful_handling,
      bot_response_summary: s.bot_response_summary,
    })),
  }
  return { shots, summary }
}
