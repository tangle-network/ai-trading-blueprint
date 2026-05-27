/**
 * OperatorClient — the single HTTP client every eval driver uses to talk
 * to the trading-blueprint operator-api.
 *
 * Why a hand-written class and not an agent-runtime primitive:
 *   - agent-runtime models LLM-agent loops (runAgentTask, defineAgent,
 *     handleChatTurn). It does NOT model "talk to a remote bot via its
 *     product API." The operator-api is bot/HTTP infra; agent-runtime
 *     would be a category error here.
 *   - We use agent-eval/campaign's `runEval` for multishot orchestration
 *     (in evals/src/sim/multishot-user-sim.ts). That's the right runtime
 *     primitive for THAT layer.
 *   - This module is the leaf that the orchestrator's dispatch function
 *     calls into. One source of truth for {auth, provision, session,
 *     send-message, poll-for-reply, teardown} — every driver in this
 *     repo MUST go through it.
 *
 * Replaces the duplicated postJson/getJson/messageText/lastAssistantId
 * helpers in: research-driver.ts, robustness-driver.ts, user-sim-driver.ts,
 * multishot-user-sim.ts.
 */

import { spawnSync } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

export type StrategyType = 'yield' | 'prediction' | 'perp' | 'dex'

export interface OperatorClientConfig {
  operatorUrl: string
  token: string
  timeoutMs?: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
}

export interface TranscriptMessage {
  id?: string
  role?: string
  parts?: Array<{ type?: string; text?: string }>
  content?: string | Array<{ type?: string; text?: string }>
  text?: string
}

export interface WaitForReplyOptions {
  botId: string
  sessionId: string
  /** Last assistant-message id seen — `null` means "any assistant message qualifies". */
  sinceMessageId: string | null
  timeoutMs: number
  pollIntervalMs?: number
}

export interface AssistantReply {
  /** Concatenated text of all NEW assistant messages since `sinceMessageId`. */
  text: string
  /** Latest assistant-message id seen — feed back into the next call as `sinceMessageId`. */
  latestAssistantId: string | null
  /** Why this poll loop ended: `'reply'` = saw new assistant content; `'timeout'` = wall clock hit. */
  endedBy: 'reply' | 'timeout'
}

export class OperatorApiError extends Error {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly body: string
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} failed (${status}): ${body}`)
    this.name = 'OperatorApiError'
    this.method = method
    this.path = path
    this.status = status
    this.body = body
  }
}

export class OperatorClient {
  private readonly url: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly fetchImpl: typeof fetch

  constructor(cfg: OperatorClientConfig) {
    this.url = cfg.operatorUrl.replace(/\/$/, '')
    this.token = cfg.token
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  /** Sign-message handshake against the operator-api. Returns a configured
   *  client ready to use. */
  static async authenticate(operatorUrl: string, privateKey: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<OperatorClient> {
    const base = operatorUrl.replace(/\/$/, '')
    const fetchImpl = opts.fetchImpl ?? fetch
    const challengeRes = await fetchImpl(`${base}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!challengeRes.ok) {
      throw new OperatorApiError('POST', '/api/auth/challenge', challengeRes.status, await challengeRes.text())
    }
    const challenge = (await challengeRes.json()) as { nonce: string; message: string }
    const signProc = spawnSync('cast', ['wallet', 'sign', '--private-key', privateKey, challenge.message], {
      encoding: 'utf8',
    })
    if (signProc.status !== 0) throw new Error(`cast wallet sign failed: ${signProc.stderr}`)
    const sessionRes = await fetchImpl(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: challenge.nonce, signature: signProc.stdout.trim() }),
    })
    if (!sessionRes.ok) {
      throw new OperatorApiError('POST', '/api/auth/session', sessionRes.status, await sessionRes.text())
    }
    const session = (await sessionRes.json()) as { token: string; expires_at: number }
    return new OperatorClient({ operatorUrl, token: session.token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
  }

  // ── Core HTTP ─────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) throw new OperatorApiError('POST', path, res.status, text)
      return (text ? JSON.parse(text) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  private async get<T>(path: string): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) throw new OperatorApiError('GET', path, res.status, text)
      return (text ? JSON.parse(text) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Bot lifecycle ─────────────────────────────────────────────────────

  async provisionBot(opts: { prompt: string; name: string; strategy_type: StrategyType }): Promise<string> {
    const created = await this.post<{ id?: string; bot_id?: string; bot?: { id?: string } }>('/api/bots', opts)
    const botId = created.id ?? created.bot_id ?? created.bot?.id
    if (!botId) throw new Error(`bot create did not return an id: ${JSON.stringify(created)}`)
    return botId
  }

  async createSession(botId: string, title: string): Promise<string> {
    const created = await this.post<{ id?: string; session_id?: string; session?: { id?: string } }>(
      `/api/bots/${encodeURIComponent(botId)}/session/sessions`,
      { title },
    )
    const sessionId = created.id ?? created.session_id ?? created.session?.id
    if (!sessionId) throw new Error(`session create did not return an id: ${JSON.stringify(created)}`)
    return sessionId
  }

  // ── Messages ──────────────────────────────────────────────────────────

  async sendMessage(botId: string, sessionId: string, text: string): Promise<void> {
    await this.post(
      `/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages`,
      { message: text, parts: [{ type: 'text', text }] },
    )
  }

  async getTranscript(botId: string, sessionId: string, limit = 200): Promise<TranscriptMessage[]> {
    const res = await this.get<{ messages?: TranscriptMessage[]; items?: TranscriptMessage[] }>(
      `/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    )
    return res.messages ?? res.items ?? []
  }

  /** Block until a NEW assistant message arrives (id > sinceMessageId), or
   *  until timeoutMs elapses. Returns the concatenated text of new
   *  assistant messages + the latest assistant id for the next call. */
  async waitForAssistantReply(opts: WaitForReplyOptions): Promise<AssistantReply> {
    const interval = opts.pollIntervalMs ?? this.pollIntervalMs
    const deadline = Date.now() + opts.timeoutMs
    while (Date.now() < deadline) {
      const msgs = await this.getTranscript(opts.botId, opts.sessionId)
      const { text, latestAssistantId } = collectAssistantTextAfter(msgs, opts.sinceMessageId)
      if (text.length > 0) return { text, latestAssistantId, endedBy: 'reply' }
      await sleep(interval)
    }
    // Timed out — surface whatever the latest assistant id was, so the
    // caller can continue tracking the conversation.
    const msgs = await this.getTranscript(opts.botId, opts.sessionId)
    const latestId = lastAssistantId(msgs)
    return { text: '', latestAssistantId: latestId, endedBy: 'timeout' }
  }
}

// ─── Transcript helpers (exported for tests + callers that need to inspect raw transcripts) ───

export function messageText(msg: TranscriptMessage): string {
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

export function lastAssistantId(msgs: TranscriptMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if ((m.role ?? '').toLowerCase() === 'assistant' && m.id) return m.id
  }
  return null
}

export function collectAssistantTextAfter(
  msgs: TranscriptMessage[],
  sinceMessageId: string | null,
): { text: string; latestAssistantId: string | null } {
  let collecting = sinceMessageId === null
  let latestId: string | null = sinceMessageId
  const parts: string[] = []
  for (const m of msgs) {
    if (!collecting) {
      if (m.id === sinceMessageId) collecting = true
      continue
    }
    if ((m.role ?? '').toLowerCase() === 'assistant') {
      parts.push(messageText(m))
      if (m.id) latestId = m.id
    }
  }
  return { text: parts.join('\n').trim(), latestAssistantId: latestId }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms))
}
