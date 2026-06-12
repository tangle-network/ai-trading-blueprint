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

// 180s default — most operator-api calls return in <1s, but session creation
// triggers sandbox-agent container spin-up which can take 30-60s on a cold
// devnet, and message-send + transcript-poll can stretch when the bot is
// mid-reply on a long turn. Earlier ceilings (15s, then 90s) both surfaced as
// AbortError ("This operation was aborted") on real-arm cells; 180s clears
// every observed slow path while still failing fast on genuinely hung
// requests (anything past 3min IS a hang, not a slow reply).
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Fast-tick cron for eval-provisioned bots — every minute (6-field cron with
 *  seconds, the same format as the production every-5-minutes default).
 *  create_bot reads it from `strategy_config.trading_loop_cron` and validates
 *  it with the workflow scheduler's own cron parser (operator_api.rs
 *  `trading_loop_cron_from_config`); activation honors it for the fast
 *  workflow (jobs/activate.rs). Exported so capture-window consumers can
 *  derive their wait budget from the actual cadence. */
export const EVAL_TRADING_LOOP_CRON = '0 * * * * *'

// StrategyType SOT lives in strategy-type.ts (the venue→pack inference module).
// Imported + re-exported here so existing importers of `OperatorClient`'s
// StrategyType keep working, but there is now ONE definition, not two that drift.
import type { StrategyType } from './strategy-type.js'
export type { StrategyType }

export interface OperatorClientConfig {
  operatorUrl: string
  token: string
  /** Epoch seconds when `token` expires. If omitted, refresh is disabled and
   *  expired tokens will surface as 401. Supplied by `authenticate()`. */
  tokenExpiresAt?: number
  /** Callback to acquire a fresh token. Used when the current token is within
   *  60s of expiry, OR when a request returns 401 with PASETO ClaimValidation.
   *  Returns the new token + its expiry. `authenticate()` wires this for you. */
  refreshToken?: () => Promise<{ token: string; expiresAt: number }>
  timeoutMs?: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
}

export interface TranscriptMessage {
  // Some operator-api endpoints return id/role at the top level; the trading
  // blueprint's session endpoint nests them under `info`. Accept both.
  id?: string
  role?: string
  info?: { id?: string; role?: string; timestamp?: string }
  parts?: Array<{ type?: string; text?: string }>
  content?: string | Array<{ type?: string; text?: string }>
  text?: string
}

function msgId(m: TranscriptMessage): string | undefined {
  return m.id ?? m.info?.id
}

function msgRole(m: TranscriptMessage): string {
  return (m.role ?? m.info?.role ?? '').toLowerCase()
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
  private token: string
  private tokenExpiresAt: number
  private readonly refreshFn: (() => Promise<{ token: string; expiresAt: number }>) | undefined
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly fetchImpl: typeof fetch

  constructor(cfg: OperatorClientConfig) {
    this.url = cfg.operatorUrl.replace(/\/$/, '')
    this.token = cfg.token
    // If no expiry passed, assume the token is fresh enough that proactive
    // refresh isn't needed; falls back to reactive refresh on 401.
    this.tokenExpiresAt = cfg.tokenExpiresAt ?? Number.MAX_SAFE_INTEGER
    this.refreshFn = cfg.refreshToken
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  /** Refresh the token if within 60s of expiry. No-op if no refresh callback
   *  was wired in (e.g. tests). Called before every request. */
  private async ensureFreshToken(): Promise<void> {
    if (!this.refreshFn) return
    const nowSec = Date.now() / 1000
    if (nowSec + 60 < this.tokenExpiresAt) return
    const fresh = await this.refreshFn()
    this.token = fresh.token
    this.tokenExpiresAt = fresh.expiresAt
  }

  /** Re-auth and retry once on 401. The operator-api uses PASETO tokens that
   *  return 401 "PASETO decryption failed: ClaimValidation" when expired —
   *  surface that as a transparent refresh so multi-hour campaigns don't die. */
  private isAuthExpired(status: number, body: string): boolean {
    return status === 401 && /PASETO|ClaimValidation|expired|unauthorized/i.test(body)
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  /** Sign-message handshake against the operator-api. Returns a configured
   *  client ready to use. */
  static async authenticate(operatorUrl: string, privateKey: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<OperatorClient> {
    const base = operatorUrl.replace(/\/$/, '')
    const fetchImpl = opts.fetchImpl ?? fetch
    // The challenge+sign+session dance; reusable so the client can refresh
    // its token mid-campaign without forcing the caller to re-construct.
    const doAuth = async (): Promise<{ token: string; expiresAt: number }> => {
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
      // expires_at is epoch seconds.
      return { token: session.token, expiresAt: session.expires_at }
    }
    const first = await doAuth()
    return new OperatorClient({
      operatorUrl,
      token: first.token,
      tokenExpiresAt: first.expiresAt,
      refreshToken: doAuth,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
  }

  // ── Core HTTP (exposed so bot-artifacts.ts can probe arbitrary
  //    operator-api paths without having to re-implement auth+timeout). ──

  async post<T>(path: string, body: unknown): Promise<T> {
    await this.ensureFreshToken()
    const send = async (): Promise<{ status: number; text: string }> => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        const res = await this.fetchImpl(`${this.url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        return { status: res.status, text: await res.text() }
      } finally {
        clearTimeout(timer)
      }
    }
    let { status, text } = await send()
    if (this.isAuthExpired(status, text) && this.refreshFn) {
      const fresh = await this.refreshFn()
      this.token = fresh.token
      this.tokenExpiresAt = fresh.expiresAt
      ;({ status, text } = await send())
    }
    if (status < 200 || status >= 300) throw new OperatorApiError('POST', path, status, text)
    return (text ? JSON.parse(text) : {}) as T
  }

  async get<T>(path: string): Promise<T> {
    await this.ensureFreshToken()
    const send = async (): Promise<{ status: number; text: string }> => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        const res = await this.fetchImpl(`${this.url}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}` },
          signal: ctrl.signal,
        })
        return { status: res.status, text: await res.text() }
      } finally {
        clearTimeout(timer)
      }
    }
    let { status, text } = await send()
    if (this.isAuthExpired(status, text) && this.refreshFn) {
      const fresh = await this.refreshFn()
      this.token = fresh.token
      this.tokenExpiresAt = fresh.expiresAt
      ;({ status, text } = await send())
    }
    if (status < 200 || status >= 300) throw new OperatorApiError('GET', path, status, text)
    return (text ? JSON.parse(text) : {}) as T
  }

  // ── Bot lifecycle ─────────────────────────────────────────────────────

  async provisionBot(opts: {
    prompt: string
    name: string
    strategy_type: StrategyType
    strategy_config?: Record<string, unknown>
  }): Promise<string> {
    const { botId } = await this.provisionBotDetailed(opts)
    return botId
  }

  /** Provision + return the trading-API access the create response carries
   *  (set when activation ran inline). The per-bot trading API is how an eval
   *  drives HONEST state changes — e.g. NAV-drop metrics snapshots whose
   *  hwm/drawdown the server computes — instead of mutating stores directly.
   *  `tradingApiUrl`/`tradingApiToken` are null when activation was deferred. */
  async provisionBotDetailed(opts: {
    prompt: string
    name: string
    strategy_type: StrategyType
    strategy_config?: Record<string, unknown>
  }): Promise<{ botId: string; tradingApiUrl: string | null; tradingApiToken: string | null }> {
    // Eval-provisioned bots tick every minute instead of the production
    // 5-minute default (#122): the post-session side-effect capture window is
    // ~2.5min, so a 5-min cron usually missed it and the analyst drowned in
    // UNVERIFIABLE cells. OperatorClient is eval-only, so this never changes
    // production cadence; an explicit caller strategy_config still wins.
    const body = {
      ...opts,
      strategy_config: {
        trading_loop_cron: EVAL_TRADING_LOOP_CRON,
        ...(opts.strategy_config ?? {}),
      },
    }
    const created = await this.post<{
      id?: string
      bot_id?: string
      bot?: { id?: string }
      trading_api_url?: string | null
      trading_api_token?: string | null
    }>('/api/bots', body)
    const botId = created.id ?? created.bot_id ?? created.bot?.id
    if (!botId) throw new Error(`bot create did not return an id: ${JSON.stringify(created)}`)
    return {
      botId,
      // The operator hands sidecars `host.docker.internal`; from the eval host
      // that's 127.0.0.1 (same normalization the operator's own trading-api
      // proxy applies in fetch_trading_api_json).
      tradingApiUrl:
        typeof created.trading_api_url === 'string' && created.trading_api_url.trim().length > 0
          ? created.trading_api_url.replace('host.docker.internal', '127.0.0.1')
          : null,
      tradingApiToken:
        typeof created.trading_api_token === 'string' && created.trading_api_token.trim().length > 0
          ? created.trading_api_token
          : null,
    }
  }

  /** Block until the bot is READY to chat. Two readiness paths:
   *
   *   - LIVE mode: the on-chain vault must resolve (vault_address goes
   *     0x0000… → real address). configureSecrets returns 500 without it
   *     ("Refusing to trade with unresolved vault address").
   *   - PAPER mode: paper bots NEVER get an on-chain vault (vault_address
   *     stays 0x0 by design) — readiness is the sandbox being provisioned
   *     (sandbox_id present). Gating on a non-zero vault here hangs forever
   *     on paper bots; that was the Gen-2 paper-mode regression.
   *
   *  Returns the resolved vault address, or '' for a ready paper bot.
   *  Blueprint factory is async (30-60s on devnet); polls every 5s. */
  async waitForVaultResolved(botId: string, timeoutMs = 240_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let lastSeen = ''
    let lastSandbox = ''
    while (Date.now() < deadline) {
      try {
        const res = await this.get<{
          bots?: Array<{ id?: string; vault_address?: string; paper_trade?: boolean; sandbox_id?: string }>
        }>(`/api/bots?limit=200`)
        const bot = res.bots?.find((b) => b.id === botId)
        const va = bot?.vault_address ?? ''
        lastSeen = va
        lastSandbox = bot?.sandbox_id ?? ''
        // Live readiness: real vault resolved.
        if (va && !/^0x0+$/i.test(va)) return va
        // Paper readiness: paper bot with a provisioned sandbox is ready;
        // it will never get a non-zero vault, so don't wait for one.
        if (bot?.paper_trade === true && lastSandbox) return ''
      } catch {
        // transient; retry
      }
      await sleep(5_000)
    }
    throw new Error(
      `waitForVaultResolved timeout for ${botId} after ${timeoutMs}ms ` +
        `(last vault_address=${lastSeen || '<missing>'}, sandbox=${lastSandbox || '<none>'})`,
    )
  }

  /** Provision a bot's sandbox-agent LLM credentials. Without this the
   *  bot's chat endpoint accepts messages but the agent inside the
   *  sidecar has no LLM credentials and never replies (we found this
   *  the hard way on the first smoke). Mirrors the existing
   *  `configureDeterministicEvalSecrets` in chat-mcp-strategy-runner.ts.
   *
   *  Retries on "no such container" (sandbox still booting) up to 5×. */
  async configureSecrets(botId: string, envJson: Record<string, string>): Promise<void> {
    const url = `${this.url}/api/bots/${encodeURIComponent(botId)}/secrets`
    let lastError = ''
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // DELETE first to clear any stale config — same pattern the existing runner uses.
      await this.fetchImpl(url, { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } }).catch(() => undefined)
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_json: envJson }),
      })
      if (res.ok) return
      lastError = `${res.status} ${await res.text()}`
      // Retry only on sandbox-still-booting errors.
      if (!lastError.includes('No such container') && !lastError.includes('load_container failed')) break
      await new Promise<void>((r) => setTimeout(r, 2_000 * attempt))
    }
    throw new Error(`configureSecrets failed for ${botId}: ${lastError}`)
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
    // The trading-blueprint operator-api returns this endpoint as a bare JSON
    // array. Earlier sandbox-runtime builds wrapped it in `{messages: [...]}`
    // or `{items: [...]}`. Accept all three shapes so the eval doesn't break
    // when run against a different operator-api version.
    const res = await this.get<TranscriptMessage[] | { messages?: TranscriptMessage[]; items?: TranscriptMessage[] }>(
      `/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    )
    if (Array.isArray(res)) return res
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
    const id = msgId(m)
    if (msgRole(m) === 'assistant' && id) return id
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
    const id = msgId(m)
    if (!collecting) {
      if (id === sinceMessageId) collecting = true
      continue
    }
    if (msgRole(m) === 'assistant') {
      parts.push(messageText(m))
      if (id) latestId = id
    }
  }
  return { text: parts.join('\n').trim(), latestAssistantId: latestId }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** Build the LLM-credential env the sandbox agent needs to function.
 *  Without these the chat endpoint accepts user messages but the
 *  in-sandbox agent (opencode/gemini/etc.) has no LLM credentials and
 *  never replies. Mirrors `deterministicAgentEnv` in
 *  chat-mcp-strategy-runner.ts so the eval substrate uses the same
 *  bot-side LLM the existing chat-* runners use. */
export function deterministicAgentEnv(): Record<string, string> {
  const zaiKey = process.env.ZAI_API_KEY
  if (zaiKey) {
    return {
      ZAI_API_KEY: zaiKey,
      OPENCODE_MODEL_PROVIDER: 'zai-coding-plan',
      OPENCODE_MODEL_NAME: 'glm-4.7',
      OPENCODE_MODEL_API_KEY: zaiKey,
      // opencode's CLI defaults the `build` and `title` agents to its bundled
      // model (currently `openrouter/google/gemini-3-pro-image-preview`),
      // which requires a Gemini key the eval substrate doesn't ship. Setting
      // OPENCODE_MODEL pins every agent (build, title, plan, ...) to the
      // provider/model the configureSecrets payload actually has credentials
      // for. Confirmed via the bot's `/home/agent/.local/share/opencode/log/`
      // session log: without this the build agent fails with "Missing
      // Authentication header" and the conversation tick never produces a reply.
      OPENCODE_MODEL: 'zai-coding-plan/glm-4.7',
      SIDECAR_DEFAULT_HARNESS: 'opencode',
    }
  }
  const geminiKey = process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY
  if (geminiKey) {
    return {
      GEMINI_API_KEY: geminiKey,
      GOOGLE_API_KEY: geminiKey,
      SIDECAR_DEFAULT_HARNESS: 'gemini',
    }
  }
  throw new Error(
    'sandbox-agent eval requires GOOGLE_AI_KEY, GEMINI_API_KEY, or ZAI_API_KEY for the in-sandbox agent. ' +
      'Without one the bot accepts messages but cannot reply.',
  )
}
