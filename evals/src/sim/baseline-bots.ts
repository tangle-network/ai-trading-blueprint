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

import { llmCallJson } from './llm-call.js'
import type { UserIntent, UserSimSessionResult, UserSimTurn } from './user-sim-driver.js'

const POLL_INTERVAL_MS = 100  // local-stub bots reply instantly; just a placeholder

interface StubBotOptions {
  intent: UserIntent
  maxTurns: number
  perTurnTimeoutMs: number
  /** The function that generates the next user-sim turn (typically the same
   *  claude-driven nextUserTurn from user-sim-driver.ts, exposed via the
   *  callback so this module stays generator-agnostic). */
  nextUserTurn: (intent: UserIntent, priorTurns: UserSimTurn[]) => string
  /** The function that generates the bot's "reply" given the user message. */
  botReply: (userMessage: string) => string
  botKindLabel: 'null' | 'stall'
}

async function runStubSession(opts: StubBotOptions): Promise<UserSimSessionResult> {
  const startedAt = Date.now()
  const turns: UserSimTurn[] = []
  let ended: UserSimSessionResult['ended_by'] = 'max_turns'
  for (let i = 0; i < opts.maxTurns; i++) {
    const userMessage = opts.nextUserTurn(opts.intent, turns)
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
  }
}

/** Null-bot: echoes the user's own message back. Should score near 0 on
 *  every dimension — if the judge says otherwise, the judge is broken. */
export async function runNullBotSession(
  intent: UserIntent,
  nextUserTurn: (intent: UserIntent, priorTurns: UserSimTurn[]) => string,
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
  nextUserTurn: (intent: UserIntent, priorTurns: UserSimTurn[]) => string,
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

const SECONDARY_JUDGE_MODEL = 'claude-sonnet-4-6'

/** Calls a second LLM judge with a more skeptical system prompt and a
 *  different model. Returns its scores so the renderer can show
 *  agreement/disagreement vs the primary haiku judge.
 *
 *  Truly cross-FAMILY (GPT/Gemini) is the right long-term answer — gated
 *  on SPEC.md Q1. For now we use a different Claude model with a stricter
 *  system prompt as the cross-perspective lens. Documents the agreement
 *  ceiling that within-family judging can give us; landing the real
 *  cross-family judge later only tightens the bound. */
export function judgeViaSkepticalSecondary(
  intent: UserIntent,
  artifact: UserSimSessionResult,
): { intent_fulfilled: number; respected_constraints: number; actually_traded_or_committed: number; productive_conversation: number; notes: string } {
  const turnsView = artifact.turns
    .map((t) => `  TURN ${t.turn}:\n    USER: ${t.user_message}\n    BOT:  ${t.bot_reply_text.slice(0, 1200)}`)
    .join('\n')
  const prompt = `You are an adversarial secondary judge auditing a primary judge's scoring of a trading-bot conversation. Be skeptical. Penalise bots that:
- agree with everything the user says without pushback
- claim to "set up" or "configure" things without observable evidence
- give long verbose replies that don't reduce to a trade or a config change
- accept obviously bad ideas without flagging them
- say "I'll think about it" / hedge / stall

User's intent: "${intent.text}"
Hard constraints: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues allowed: ${intent.venues.join(', ')}.
Session ended by: ${artifact.ended_by} after ${artifact.turns.length} turns.

Transcript:
${turnsView}

Score four dimensions, each 0.0 to 1.0, using STRICT criteria:
  intent_fulfilled: did the bot OBSERVABLY do what was asked, not just claim it would?
  respected_constraints: did it visibly respect every constraint? Silent compliance ≠ visible compliance.
  actually_traded_or_committed: a single concrete action (place order, set config, write strategy file) shipped?
  productive_conversation: was every turn moving toward action? Stalling, hedging, and questions without answers cost points.

Output ONE JSON object, no prose, no fences:
  {"intent_fulfilled": 0.0, "respected_constraints": 0.0, "actually_traded_or_committed": 0.0, "productive_conversation": 0.0, "notes": "<1-2 sentences, skeptical voice>"}`
  const { result, raw } = llmCallJson<{
    intent_fulfilled: number
    respected_constraints: number
    actually_traded_or_committed: number
    productive_conversation: number
    notes: string
  }>({ prompt, model: SECONDARY_JUDGE_MODEL })
  if (!result) {
    return {
      intent_fulfilled: 0,
      respected_constraints: 0,
      actually_traded_or_committed: 0,
      productive_conversation: 0,
      notes: !raw.ok ? `secondary_judge_failed: ${raw.stderr.slice(0, 200)}` : `secondary_judge_unparseable: ${raw.output.slice(0, 200)}`,
    }
  }
  return result
}
