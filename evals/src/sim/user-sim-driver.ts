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
import { runProfile } from './llm-call.js'
import { userSimTurnProfile } from '../profiles/user-sim-turn.js'
import { OperatorClient } from './operator-client.js'
import type { StrategyType } from './strategy-type.js'
import type { UserPersona } from './user-personas.js'

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
  /** Explicit strategy_type → pack override. REQUIRED when venue-inference
   *  picks the wrong pack — e.g. market-making on a DEX venue (aerodrome,
   *  uniswap) infers 'dex' (swap-routing) but needs 'mm' (the market-maker
   *  pack); a multi-venue portfolio intent needs 'multi'. When omitted,
   *  the dispatch falls back to inferStrategyTypeFromVenues(venues). */
  strategy_type?: StrategyType
}

export interface UserSimSessionOptions {
  intent: UserIntent
  /** Optional persona — when set, the user-sim's voice is the persona's
   *  system prompt prepended to the base instructions. When null, the
   *  base "demanding user" voice runs. */
  persona?: UserPersona | null
  operatorUrl: string
  token: string
  /** If set, use OperatorClient.authenticate() (auto-refresh) instead of the
   *  raw-token constructor. Required for sessions longer than ~50min. */
  privateKey?: string
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
  /** Deterministic-tick side effects read out of the bot's sandbox
   *  (decisions.jsonl, metrics, strategy files) via the operator
   *  `/api/bots/{id}/tick-artifacts` endpoint. null = not captured (sandbox
   *  unreachable / endpoint absent) — the RLM analyst treats absence as
   *  UNVERIFIABLE, never as proof the tick didn't run. */
  tick_side_effects: TickSideEffects | null
}

/** Raw tick side effects pulled from the sandbox. Shape mirrors the operator
 *  endpoint's JSON exactly so otlp-capture can emit it verbatim. */
export interface TickSideEffects {
  decisions_jsonl?: string | null
  metrics_latest?: unknown
  strategies?: Record<string, string>
}

// ─── User-sim turn generation ──────────────────────────────────────────

/** Persona voice for the user-message portion. The base user-sim rules
 *  live in the profile's system prompt (evals/src/profiles/user-sim-turn.ts);
 *  the persona voice is per-call so it rides in the message. */
function personaVoice(persona: UserPersona | null | undefined): string {
  if (persona) return persona.system_prompt
  return 'You are a concise, direct, demanding user chatting with an autonomous trading bot.'
}

export async function nextUserTurn(
  intent: UserIntent,
  priorTurns: UserSimTurn[],
  persona?: UserPersona | null,
): Promise<string> {
  if (priorTurns.length === 0) {
    // Opening turn IS the intent text, verbatim — closest possible
    // simulation of a real user typing their first message. (The persona
    // shows up on turn 2+, when there's something for it to react to.)
    return intent.text
  }
  const convo = priorTurns
    .map((t) => `USER: ${t.user_message}\nBOT: ${t.bot_reply_text.slice(0, 800)}`)
    .join('\n\n')
  const message = `Your persona's voice: ${personaVoice(persona)}

Your persona's goal: "${intent.text}"
Constraints you care about: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues you allow: ${intent.venues.join(', ')}.

Conversation so far:
${convo}

Your next message (just the message, nothing else):`
  const res = await runProfile(userSimTurnProfile, { message })
  if (!res.ok) throw new Error(`user-sim turn generation failed: ${res.stderr.slice(0, 200)}`)
  return res.output.trim()
}

// ─── Driver ────────────────────────────────────────────────────────────

export async function runUserSimSession(opts: UserSimSessionOptions): Promise<UserSimSessionResult> {
  const startedAt = Date.now()
  const client = opts.privateKey
    ? await OperatorClient.authenticate(opts.operatorUrl, opts.privateKey)
    : new OperatorClient({ operatorUrl: opts.operatorUrl, token: opts.token })
  const turns: UserSimTurn[] = []
  let lastSeenAssistantId: string | null = null
  let ended: UserSimSessionResult['ended_by'] = 'max_turns'

  for (let i = 0; i < opts.maxTurns; i++) {
    const userMessage = await nextUserTurn(opts.intent, turns, opts.persona ?? null)
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
  // Pull the deterministic-tick side effects out of the sandbox so the RLM
  // analyst can adjudicate real execution vs prose. Best-effort: a missing
  // endpoint / unreachable sandbox leaves this null (analyst → UNVERIFIABLE),
  // never a fabricated "captured" flag.
  let tickSideEffects: TickSideEffects | null = null
  try {
    tickSideEffects = await client.get<TickSideEffects>(`/api/bots/${opts.botId}/tick-artifacts`)
  } catch {
    // swallow — capture is observational; absence is honestly reported
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
    tick_side_effects: tickSideEffects,
  }
}
