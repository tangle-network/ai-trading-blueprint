/**
 * Research-depth eval — eval #3 from SPEC.md §5.
 *
 * For each `ThesisQuestion`, asks a provisioned bot to research and
 * answer. Captures the bot's full response + cited sources from its
 * transcript. Returns a `ResearchEvalData` slice that plugs into the
 * S-tier per-bot report renderer.
 *
 * HTTP-to-operator-API goes through `OperatorClient` (single source of
 * truth for {auth, provision, session, send-message, poll-for-reply}).
 * LLM calls (judge) go through `llmCall()` from `evals/src/sim/llm-call.ts`.
 * Both replace the previously-duplicated postJson / getJson / spawnSync
 * pattern that this file used to inline.
 */

import type { ResearchEvalData } from '../report/types.js'
import { inspectBotArtifacts, type BotArtifacts } from '../sim/bot-artifacts.js'
import { OperatorClient } from '../sim/operator-client.js'
import { inferStrategyTypeFromSourceClasses } from '../sim/strategy-type.js'
import { STANDARD_THESIS_QUESTIONS, type ThesisQuestion } from './thesis-questions.js'

export interface ResearchShot {
  question: ThesisQuestion
  bot_response_text: string
  duration_ms: number
  /** Sources cited in the response — extracted via URL regex from the bot's reply. */
  cited_urls: string[]
  /** Work-product artifacts inspected from the bot's operator-api state
   *  AFTER the research session ends. null if inspection failed. */
  bot_artifacts: BotArtifacts | null
}

export interface RunResearchEvalOptions {
  operatorUrl: string
  token: string
  questions?: ThesisQuestion[]
  perQuestionTimeoutMs?: number
}

const URL_REGEX = /https?:\/\/[^\s)\]<>"']+/g

export async function runResearchEval(opts: RunResearchEvalOptions): Promise<{ shots: ResearchShot[] }> {
  const client = new OperatorClient({ operatorUrl: opts.operatorUrl, token: opts.token })
  const questions = opts.questions ?? STANDARD_THESIS_QUESTIONS
  const shots: ResearchShot[] = []
  for (const q of questions) {
    process.stderr.write(`  · research thesis: ${q.id}…\n`)
    // strategy_type must match the question's asset class — a Polymarket
    // research question handed to a 'dex' bot gets the wrong tool surface
    // and can't research prediction markets.
    const strategyType = inferStrategyTypeFromSourceClasses(q.expected_source_classes)
    const botId = await client.provisionBot({ prompt: q.question, name: q.id, strategy_type: strategyType })
    const sessionId = await client.createSession(botId, `research:${q.id}`)
    const startedAt = Date.now()
    await client.sendMessage(botId, sessionId, q.question)
    // Wait for the bot's reply — first NEW assistant message after this
    // user turn. Replaces the previous magic `text.length > 100` heuristic
    // that returned short acks as research or looped forever on short
    // legitimate answers.
    const reply = await client.waitForAssistantReply({
      botId,
      sessionId,
      sinceMessageId: null,
      timeoutMs: opts.perQuestionTimeoutMs ?? 180_000,
    })
    const urls = Array.from(new Set(reply.text.match(URL_REGEX) ?? []))
    // Inspect bot's work-product artifacts AFTER the research session
    // ends — strategies created, backtests run, self-improvement
    // cycles, trades, PnL. Best-effort: null if the inspection itself
    // fails (judge falls back; doesn't crash the eval).
    let artifacts: BotArtifacts | null = null
    try {
      artifacts = await inspectBotArtifacts(client, botId)
    } catch (e) {
      process.stderr.write(`    ! artifact inspection failed for ${q.id}: ${(e as Error).message.slice(0, 200)}\n`)
    }
    shots.push({
      question: q,
      bot_response_text: reply.text,
      duration_ms: Date.now() - startedAt,
      cited_urls: urls,
      bot_artifacts: artifacts,
    })
  }
  return { shots }
}

/** Aggregate research shots into the report renderer's `ResearchEvalData` slice. */
export function aggregateResearchData(
  shots: ResearchShot[],
  judgeScores: Array<{ depth_score: number; recency_hours: number; source_diversity: number; citation_resolution: number }>,
): ResearchEvalData {
  const n = shots.length
  if (n === 0) {
    return {
      theses_evaluated: 0,
      mean_source_count: 0,
      mean_recency_hours: 0,
      source_diversity_score: 0,
      citation_resolution_rate: 0,
      depth_score: 0,
    }
  }
  const totalSources = shots.reduce((acc, s) => acc + s.cited_urls.length, 0)
  const mean = (key: keyof typeof judgeScores[number]) =>
    judgeScores.reduce((a, b) => a + (b[key] as number), 0) / Math.max(judgeScores.length, 1)
  return {
    theses_evaluated: n,
    mean_source_count: totalSources / n,
    mean_recency_hours: mean('recency_hours'),
    source_diversity_score: mean('source_diversity'),
    citation_resolution_rate: mean('citation_resolution'),
    depth_score: mean('depth_score'),
  }
}
