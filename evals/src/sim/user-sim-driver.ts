/**
 * User-sim turn-loop driver.
 *
 * One shot of the multishot eval = one fresh bot provisioned through the
 * real product API + one user-sim LLM driving a chat session against it
 * via the same operator chat endpoints a human user would hit.
 *
 * Composition:
 *   - HTTP-to-operator-api → `OperatorClient` (single source of truth)
 *   - User-sim LLM turn generation → `llmCall` (single wrapper around
 *     `claude --print`, migration path documented to agent-runtime
 *     backends when ANTHROPIC_API_KEY is configured)
 *
 * Stop conditions:
 *   - `[done]` literal in the user-sim's latest message
 *   - max user-sim turns reached
 *   - wall-clock budget exceeded
 *   - bot stops responding for > stallMs (timeout in OperatorClient)
 */

import type { BotArtifacts } from './bot-artifacts.js'
import { llmCall } from './llm-call.js'
import { OperatorClient } from './operator-client.js'
import type { UserPersona } from './user-personas.js'

const USER_SIM_MODEL = 'claude-haiku-4-5'

export interface UserIntent {
  /** Stable id used as the scenario id + cell id. */
  id: string
  /** The freeform "what I want a bot to do" text the user-sim opens with. */
  text: string
  /** Hard constraints the judge enforces post-hoc. */
  capital_usd: number
  dd_cap_pct: number
  /** Allow-listed venues; the judge flags trades outside this list. */
  venues: string[]
}

export interface UserSimSessionOptions {
  intent: UserIntent
  /** Optional persona — when set, the user-sim's voice is the persona's
   *  system prompt prepended to the base instructions. When null, the
   *  base "demanding user" voice runs. */
  persona?: UserPersona | null
  operatorUrl: string
  token: string
  botId: string
  sessionId: string
  maxTurns: number
  perTurnTimeoutMs: number
  stallMs: number
}

export interface UserSimTurn {
  /** 0-indexed turn number. Turn 0 is the user-sim's opening intent. */
  turn: number
  user_message: string
  /** Bot reply text — joined assistant message bodies in the order they
   *  arrived after this user message. */
  bot_reply_text: string
  bot_reply_arrived_ms: number
  /** True when the user-sim emitted `[done]` to signal it got what it wanted. */
  signalled_done: boolean
}

export interface UserSimSessionResult {
  intent: UserIntent
  bot_id: string
  session_id: string
  turns: UserSimTurn[]
  /** Final transcript (last poll) — opaque shape; the judge reads it generically. */
  final_transcript: unknown
  ended_by: 'done' | 'max_turns' | 'wall_clock' | 'stall'
  total_wall_ms: number
  /** Work-product artifacts inspected from operator-api state at session
   *  end — self-improvement lineage, trades, PnL. null = not inspected. */
  bot_artifacts: BotArtifacts | null
}

// ─── User-sim turn generation ──────────────────────────────────────────

const BASE_USER_SIM_INSTRUCTIONS = `Stay in character as a user — never describe the bot's internal state, never analyse the bot's strategy in technical terms unless your persona explicitly would, never apologise for being an AI.

Rules:
- Each turn is ONE chat message you would send. No prose around it. No quotes. No labels like "user:".
- Push the bot toward your goal in the way YOUR PERSONA would.
- When you have what you wanted (the bot is trading, has set up a strategy, has answered your question to your persona's satisfaction), emit the literal token [done] anywhere in your message and stop.
- Cap each message at ~200 characters unless your persona genuinely needs more.`

/** Build the full system prompt: persona-specific voice + base instructions. */
function buildSystemPrompt(persona: UserPersona | null | undefined): string {
  if (persona) return `${persona.system_prompt}\n\n${BASE_USER_SIM_INSTRUCTIONS}`
  return `You are simulating a user chatting with an autonomous trading bot. Concise, direct, demanding.\n\n${BASE_USER_SIM_INSTRUCTIONS}`
}

export function nextUserTurn(
  intent: UserIntent,
  priorTurns: UserSimTurn[],
  persona?: UserPersona | null,
): string {
  if (priorTurns.length === 0) {
    // Opening turn IS the intent text, verbatim — closest possible
    // simulation of a real user typing their first message. (The persona
    // shows up on turn 2+, when there's something for it to react to.)
    return intent.text
  }
  const systemPrompt = buildSystemPrompt(persona)
  const convo = priorTurns
    .map((t) => `USER: ${t.user_message}\nBOT: ${t.bot_reply_text.slice(0, 800)}`)
    .join('\n\n')
  const prompt = `${systemPrompt}

Your persona's goal: "${intent.text}"
Constraints you care about: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues you allow: ${intent.venues.join(', ')}.

Conversation so far:
${convo}

Your next message (just the message, nothing else):`
  const res = llmCall({ prompt, model: USER_SIM_MODEL })
  if (!res.ok) throw new Error(`user-sim turn generation failed: ${res.stderr.slice(0, 200)}`)
  return res.output.trim()
}

// ─── Driver ────────────────────────────────────────────────────────────

export async function runUserSimSession(opts: UserSimSessionOptions): Promise<UserSimSessionResult> {
  const startedAt = Date.now()
  const client = new OperatorClient({ operatorUrl: opts.operatorUrl, token: opts.token })
  const turns: UserSimTurn[] = []
  let lastSeenAssistantId: string | null = null
  let ended: UserSimSessionResult['ended_by'] = 'max_turns'

  for (let i = 0; i < opts.maxTurns; i++) {
    const userMessage = nextUserTurn(opts.intent, turns, opts.persona ?? null)
    const signalledDone = userMessage.toLowerCase().includes('[done]')

    const turnStart = Date.now()
    await client.sendMessage(opts.botId, opts.sessionId, userMessage)
    const reply = await client.waitForAssistantReply({
      botId: opts.botId,
      sessionId: opts.sessionId,
      sinceMessageId: lastSeenAssistantId,
      timeoutMs: opts.perTurnTimeoutMs,
    })
    const arrivedAt = Date.now()
    lastSeenAssistantId = reply.latestAssistantId

    turns.push({
      turn: i,
      user_message: userMessage,
      bot_reply_text: reply.text,
      bot_reply_arrived_ms: arrivedAt - turnStart,
      signalled_done: signalledDone,
    })

    if (signalledDone) { ended = 'done'; break }
    if (reply.endedBy === 'timeout') { ended = 'stall'; break }
    if (Date.now() - startedAt > opts.perTurnTimeoutMs * opts.maxTurns) { ended = 'wall_clock'; break }
  }

  const finalTranscript = await client.getTranscript(opts.botId, opts.sessionId)
  // Inspect work-product artifacts at session end (best-effort; the
  // session result is still returned even if inspection fails).
  let artifacts: import('./bot-artifacts.js').BotArtifacts | null = null
  try {
    const { inspectBotArtifacts } = await import('./bot-artifacts.js')
    artifacts = await inspectBotArtifacts(client, opts.botId)
  } catch {
    // swallow — artifact inspection is observational, not load-bearing
  }
  return {
    intent: opts.intent,
    bot_id: opts.botId,
    session_id: opts.sessionId,
    turns,
    final_transcript: finalTranscript,
    ended_by: ended,
    total_wall_ms: Date.now() - startedAt,
    bot_artifacts: artifacts,
  }
}
