/**
 * User-sim turn-loop driver.
 *
 * One shot of the multishot eval = one fresh bot provisioned through the
 * real product API + one user-sim LLM driving a chat session against it
 * via the same operator chat endpoints a human user would hit.
 *
 * The user-sim never reaches into the bot's state. It sees what a real
 * user would see (transcript), and types what a real user would type
 * (chat messages). The bot has its real tool surface — sandbox, MCP,
 * trading-http-api, `/execute`, `/trades` — and does whatever it does.
 *
 * Stop conditions:
 *   - `[done]` literal in the user-sim's latest message
 *   - max user-sim turns reached
 *   - wall-clock budget exceeded
 *   - bot stops responding for > stallMs
 *
 * Output: the captured transcript + any sandbox-side artifacts the
 * existing chat-* runners surface (mcp_tools, mcp_task evidence, etc.)
 * — same `inspectSandbox` shape so the judge can score across the same
 * surface area.
 */

import { spawnSync } from 'node:child_process'

const USER_SIM_MODEL = 'claude-haiku-4-5'
const POLL_INTERVAL_MS = 5_000

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
  /** Final transcript object returned by the operator API. Unknown shape
   *  by design — the judge reads it generically. */
  final_transcript: unknown
  ended_by: 'done' | 'max_turns' | 'wall_clock' | 'stall'
  total_wall_ms: number
}

// ─── HTTP helpers (same shape as the existing chat-* runners) ──────────

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// ─── Transcript inspection ─────────────────────────────────────────────

interface TranscriptMessage {
  id?: string
  role?: string
  parts?: Array<{ type?: string; text?: string }>
  content?: string | Array<{ type?: string; text?: string }>
  text?: string
}
interface TranscriptResponse {
  messages?: TranscriptMessage[]
  items?: TranscriptMessage[]
}

function extractMessages(t: unknown): TranscriptMessage[] {
  const obj = t as TranscriptResponse | undefined
  if (!obj) return []
  return obj.messages ?? obj.items ?? []
}

function messageText(msg: TranscriptMessage): string {
  if (typeof msg.text === 'string') return msg.text
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text ?? '')
      .join('\n')
  }
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text ?? '')
      .join('\n')
  }
  return ''
}

function assistantReplyAfter(transcript: unknown, lastAssistantId: string | null): { text: string; latestAssistantId: string | null } {
  const msgs = extractMessages(transcript)
  let text = ''
  let latest: string | null = lastAssistantId
  let collecting = lastAssistantId === null
  for (const m of msgs) {
    if (!collecting) {
      if (m.id === lastAssistantId) collecting = true
      continue
    }
    if ((m.role ?? '').toLowerCase() === 'assistant') {
      text += messageText(m) + '\n'
      if (m.id) latest = m.id
    }
  }
  return { text: text.trim(), latestAssistantId: latest }
}

function lastAssistantId(transcript: unknown): string | null {
  const msgs = extractMessages(transcript)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if ((m.role ?? '').toLowerCase() === 'assistant' && m.id) return m.id
  }
  return null
}

// ─── User-sim turn generation (claude --print) ─────────────────────────

function claudePrint(prompt: string): string {
  const proc = spawnSync('claude', ['--print', '--model', USER_SIM_MODEL, '--output-format', 'text'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (proc.status !== 0) throw new Error(`claude --print (user-sim) failed: ${proc.stderr}`)
  return proc.stdout.trim()
}

const USER_SIM_SYSTEM = `You are simulating a user chatting with an autonomous trading bot. Stay in character as a user — never describe the bot's internal state, never analyse the bot's strategy in technical terms, never apologise for being an AI. Type the way a real user with this intent would type: concise, direct, demanding, occasionally clarifying or pushing back.

Rules:
- Each turn is ONE chat message you would send. No prose around it. No quotes. No labels like "user:".
- Push the bot toward your goal. If it stalls, demand action. If it ignores constraints, repeat them. If it strategises endlessly without trading, tell it to just start.
- When you have what you wanted (the bot is trading, has set up a strategy, has answered your question), emit the literal token [done] anywhere in your message and stop.
- Cap each message at ~200 characters unless you genuinely need more.`

function nextUserTurn(intent: UserIntent, priorTurns: UserSimTurn[]): string {
  if (priorTurns.length === 0) {
    // Opening turn IS the intent text, verbatim — that's the cleanest
    // simulation of a user typing their first message.
    return intent.text
  }
  const convo = priorTurns
    .map((t) => `USER: ${t.user_message}\nBOT: ${t.bot_reply_text.slice(0, 800)}`)
    .join('\n\n')
  const prompt = `${USER_SIM_SYSTEM}

Your persona's goal: "${intent.text}"
Constraints you care about: $${intent.capital_usd} capital, ${intent.dd_cap_pct}% max drawdown, venues you allow: ${intent.venues.join(', ')}.

Conversation so far:
${convo}

Your next message (just the message, nothing else):`
  return claudePrint(prompt)
}

// ─── Driver ────────────────────────────────────────────────────────────

export async function runUserSimSession(opts: UserSimSessionOptions): Promise<UserSimSessionResult> {
  const startedAt = Date.now()
  const messagesUrl = `${opts.operatorUrl}/api/bots/${encodeURIComponent(opts.botId)}/session/sessions/${encodeURIComponent(opts.sessionId)}/messages`
  const turns: UserSimTurn[] = []
  let lastSeenAssistantId: string | null = null
  let ended: UserSimSessionResult['ended_by'] = 'max_turns'

  for (let i = 0; i < opts.maxTurns; i++) {
    const userMessage = nextUserTurn(opts.intent, turns)
    const signalledDone = userMessage.toLowerCase().includes('[done]')

    // Post the user-sim message exactly the way a real user would
    await postJson<unknown>(messagesUrl, opts.token, {
      message: userMessage,
      parts: [{ type: 'text', text: userMessage }],
    })

    // Poll until either a new assistant message arrives or stall/timeout
    const turnStart = Date.now()
    let replyText = ''
    let arrivedAt = 0
    let stalled = false
    while (true) {
      const elapsed = Date.now() - turnStart
      if (elapsed > opts.perTurnTimeoutMs) { stalled = true; break }
      const transcript = await getJson<unknown>(`${messagesUrl}?limit=200`, opts.token)
      const { text, latestAssistantId } = assistantReplyAfter(transcript, lastSeenAssistantId)
      if (text.length > 0) {
        replyText = text
        arrivedAt = Date.now()
        lastSeenAssistantId = latestAssistantId
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }

    turns.push({
      turn: i,
      user_message: userMessage,
      bot_reply_text: replyText,
      bot_reply_arrived_ms: arrivedAt - turnStart,
      signalled_done: signalledDone,
    })

    if (signalledDone) { ended = 'done'; break }
    if (stalled) { ended = 'stall'; break }
    if (Date.now() - startedAt > opts.perTurnTimeoutMs * opts.maxTurns) { ended = 'wall_clock'; break }
  }

  const finalTranscript = await getJson<unknown>(`${messagesUrl}?limit=200`, opts.token)
  return {
    intent: opts.intent,
    bot_id: opts.botId,
    session_id: opts.sessionId,
    turns,
    final_transcript: finalTranscript,
    ended_by: ended,
    total_wall_ms: Date.now() - startedAt,
  }
}
