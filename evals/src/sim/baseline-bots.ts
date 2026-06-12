/**
 * Adversarial baseline bots for the multishot user-sim eval.
 *
 * Two stub "bots" that don't use a real LLM or the trading-http-api at all,
 * so we can answer the most adversarial question about our judge:
 *
 *   "Does the judge give a high composite to a bot that obviously did
 *    nothing? If yes, the judge is broken."
 *
 * If null-bot or stall-bot score > ~0.3 composite on the same intents the
 * real bot is judged against, we have an unusable judge. Surfacing those
 * comparisons in the report (`baselineComparison` slice) makes the
 * judge's validity an empirical question that updates every eval run.
 *
 * Frontier-bot lives elsewhere — it requires swapping the operator's
 * underlying LLM config and a real product stack, which is a follow-up.
 */

import { runProfileJson } from './llm-call.js'
import { resolveSkepticalSecondaryJudgeProfile } from '../profiles/skeptical-secondary-judge.js'
import type { UserIntent, UserSimSessionResult, UserSimTurn } from './user-sim-driver.js'

const POLL_INTERVAL_MS = 100  // local-stub bots reply instantly; just a placeholder

interface StubBotOptions {
  intent: UserIntent
  maxTurns: number
  perTurnTimeoutMs: number
  /** The function that generates the next user-sim turn (typically the same
   *  claude-driven nextUserTurn from user-sim-driver.ts, exposed via the
   *  callback so this module stays generator-agnostic). */
  nextUserTurn: (intent: UserIntent, priorTurns: UserSimTurn[]) => Promise<string>
  /** The function that generates the bot's "reply" given the user message. */
  botReply: (userMessage: string) => string
  botKindLabel: 'null' | 'stall'
}

async function runStubSession(opts: StubBotOptions): Promise<UserSimSessionResult> {
  const startedAt = Date.now()
  const turns: UserSimTurn[] = []
  let ended: UserSimSessionResult['ended_by'] = 'max_turns'
  for (let i = 0; i < opts.maxTurns; i++) {
    const userMessage = await opts.nextUserTurn(opts.intent, turns)
    const signalledDone = userMessage.toLowerCase().includes('[done]')
    const reply = opts.botReply(userMessage)
    turns.push({
      turn: i,
      user_message: userMessage,
      bot_reply_text: reply,
      bot_reply_arrived_ms: 50,
      signalled_done: signalledDone,
    })
    if (signalledDone) {
      ended = 'done'
      break
    }
    // tiny throttle so we don't tail-spam claude --print in the user-sim turn loop
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return {
    intent: opts.intent,
    bot_id: `stub-${opts.botKindLabel}-bot`,
    session_id: `stub-${opts.botKindLabel}-${Date.now()}`,
    turns,
    final_transcript: { messages: turns.flatMap((t) => [
      { role: 'user', text: t.user_message },
      { role: 'assistant', text: t.bot_reply_text },
    ]) },
    ended_by: ended,
    total_wall_ms: Date.now() - startedAt,
    bot_artifacts: null, // stub bots don't have artifact state
    tick_side_effects: null, // stub bots never touch a sandbox
  }
}

/** Null-bot: echoes the user's own message back. Should score near 0 on
 *  every dimension — if the judge says otherwise, the judge is broken. */
export async function runNullBotSession(
  intent: UserIntent,
  nextUserTurn: (intent: UserIntent, priorTurns: UserSimTurn[]) => Promise<string>,
  opts: { maxTurns?: number; perTurnTimeoutMs?: number } = {},
): Promise<UserSimSessionResult> {
  return runStubSession({
    intent,
    maxTurns: opts.maxTurns ?? 8,
    perTurnTimeoutMs: opts.perTurnTimeoutMs ?? 60_000,
    nextUserTurn,
    botReply: (msg) => `(echoing your message back): ${msg}`,
    botKindLabel: 'null',
  })
}

/** Stall-bot: always says "I'll think about it" — never acts, never asks. */
export async function runStallBotSession(
  intent: UserIntent,
  nextUserTurn: (intent: UserIntent, priorTurns: UserSimTurn[]) => Promise<string>,
  opts: { maxTurns?: number; perTurnTimeoutMs?: number } = {},
): Promise<UserSimSessionResult> {
  const stallReplies = [
    "I'll think about that and get back to you.",
    "Let me consider that carefully.",
    "Interesting — I'll need to look into this.",
    "Noted. I'm thinking about the best approach.",
    "I'll consider all the angles on this.",
    "Let me reflect on what you've said.",
    "I'll need to ponder that before acting.",
    "Thanks for the input — I'm processing.",
  ]
  let i = 0
  return runStubSession({
    intent,
    maxTurns: opts.maxTurns ?? 8,
    perTurnTimeoutMs: opts.perTurnTimeoutMs ?? 60_000,
    nextUserTurn,
    botReply: () => stallReplies[i++ % stallReplies.length]!,
    botKindLabel: 'stall',
  })
}

// ─── Cross-perspective secondary judge ────────────────────────────────

/** Calls a second LLM judge with a more skeptical system prompt. Returns
 *  its scores so the renderer can show agreement/disagreement vs the
 *  primary judge. Rubric + model live in the profile
 *  (evals/src/profiles/skeptical-secondary-judge.ts).
 *
 *  Cross-FAMILY by default: the secondary runs on Moonshot Kimi K2 while
 *  the primary runs on Z.AI GLM. When MOONSHOT_API_KEY is missing the
 *  profile resolver degrades to GLM-5.1 and the degradation is stamped
 *  into the returned notes so no cell silently pretends to be
 *  cross-family. */
export async function judgeViaSkepticalSecondary(
  intent: UserIntent,
  artifact: UserSimSessionResult,
): Promise<{ intent_fulfilled: number; respected_constraints: number; actually_traded_or_committed: number; productive_conversation: number; notes: string }> {
  const turnsView = artifact.turns
    .map((t) => `  TURN ${t.turn}:\n    USER: ${t.user_message}\n    BOT:  ${t.bot_reply_text.slice(0, 1200)}`)
    .join('\n')
  const message = `User's intent: "${intent.text}"
Hard constraints: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues allowed: ${intent.venues.join(', ')}.
Session ended by: ${artifact.ended_by} after ${artifact.turns.length} turns.

Transcript:
${turnsView}`
  const routing = resolveSkepticalSecondaryJudgeProfile()
  const degradedTag = routing.crossFamilyDegraded
    ? ' [degraded: MOONSHOT_API_KEY unset — secondary ran on zai-glm-5.1, same family as primary; disagreement understated]'
    : ''
  const { result, raw } = await runProfileJson<{
    intent_fulfilled: number
    respected_constraints: number
    actually_traded_or_committed: number
    productive_conversation: number
    notes: string
  }>(routing.profile, { message })
  if (!result) {
    return {
      intent_fulfilled: 0,
      respected_constraints: 0,
      actually_traded_or_committed: 0,
      productive_conversation: 0,
      notes: (!raw.ok ? `secondary_judge_failed: ${raw.stderr.slice(0, 200)}` : `secondary_judge_unparseable: ${raw.output.slice(0, 200)}`) + degradedTag,
    }
  }
  return { ...result, notes: `${result.notes}${degradedTag}` }
}
