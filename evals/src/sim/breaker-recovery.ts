/**
 * Breaker-recovery longitudinal scenario — does a drawdown-halted bot
 * RECOVER, or does it freeze and spam duplicate improvement intents?
 * (Production incident 2026-06: a breaker-halted bot froze for 17h with
 * 22 duplicate pending intents. Every existing eval tested the breaker
 * in the "trips on breach" direction; nothing asserted the bot comes
 * BACK after the owner acknowledges, or that the reflection loop's
 * intent cooldown actually bounds duplicates while halted.)
 *
 * Operator-API-driven end to end (no store mutation, no mocks):
 *   1. Provision a paper bot via the real create endpoint; activation
 *      hands back the per-bot trading-API access.
 *   2. Seed a drawdown breach HONESTLY: post NAV-drop metrics snapshots
 *      to the trading API — hwm/drawdown are server-computed
 *      (record_snapshot_for_bot), so the breach is real state, not a
 *      forged drawdown field (which the server ignores anyway).
 *   3. Assert (a) the breaker trips (`/circuit-breaker/check`);
 *      (b) over a bounded window, pending improvement intents do NOT
 *      duplicate per cooldown_key (reflection_loop.js's
 *      INTENT_COOLDOWN_MS contract); (c) after the owner acknowledges
 *      (`/api/bots/{id}/risk/acknowledge-drawdown`), the breaker
 *      re-arms and the bot keeps ticking.
 *
 * Honesty contract: every assertion carries pass | fail | skipped.
 * Unreachable infra (no operator, activation without trading-API
 * access, sandbox exec down) yields SKIPPED with the reason — never a
 * vacuous pass. The bin maps verdicts to exit codes so CI can tell
 * "verified" from "could not verify".
 */

import { OperatorApiError, OperatorClient } from './operator-client.js'

export type AssertionStatus = 'pass' | 'fail' | 'skipped'

export interface BreakerAssertion {
  id: string
  status: AssertionStatus
  detail: string
}

export interface BreakerRecoveryReport {
  bot_id: string | null
  assertions: BreakerAssertion[]
  /** pass = all assertions verified; fail = >=1 fail; skipped = nothing
   *  could be verified; partial = some verified, some skipped. */
  verdict: 'pass' | 'fail' | 'skipped' | 'partial'
  total_wall_ms: number
}

export interface BreakerRecoveryOptions {
  operatorUrl: string
  privateKey: string
  /** Paper capital; the NAV-drop posts are derived from it. Default 10000. */
  initialCapitalUsd?: number
  /** Mandate drawdown cap the breaker is checked against. Default 5 (the
   *  seeded breach is 10%, comfortably past it). Percent, not fraction. */
  maxDrawdownPct?: number
  /** Observation window while halted, for the intent-boundedness assertion.
   *  Default 180s = 3 cycles of the 1-minute eval tick cron. */
  observeWindowMs?: number
  /** Window after acknowledge for the resumes-ticking assertion. Default 150s
   *  (same budget the #122 capture window uses for >=1 guaranteed tick). */
  postAckWindowMs?: number
  log?: (line: string) => void
}

/** Reflection-loop intent record shape (the fields this scenario reads).
 *  Source of truth: buildImprovementIntent in
 *  trading-blueprint-lib/src/prompts/tools/reflection_loop.js */
interface ImprovementIntent {
  intent_id?: string
  status?: string
  cooldown_key?: string | null
  timestamp?: string
}

interface TickArtifacts {
  decisions_jsonl?: string | null
  improvement_intents_jsonl?: string | null
}

function parseJsonl<T>(raw: string | null | undefined): T[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // partial/corrupt line — skip; boundedness is judged on parseable records
    }
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** Direct trading-API call with the bot's bearer token. The operator proxies
 *  READS for us, but the WRITE we need (metrics snapshot) and the breaker
 *  check live on the per-bot trading API — same surface the in-sandbox tick
 *  tools use, so the seeded state is indistinguishable from a real bad tick. */
async function tradingApi<T>(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new OperatorApiError(method, path, res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

async function fetchTickArtifacts(client: OperatorClient, botId: string): Promise<TickArtifacts | null> {
  try {
    return await client.get<TickArtifacts>(`/api/bots/${encodeURIComponent(botId)}/tick-artifacts`)
  } catch {
    // 502 when the sandbox is unreachable — honest absence, never fabricated
    return null
  }
}

function decisionCount(artifacts: TickArtifacts | null): number {
  if (!artifacts) return 0
  return parseJsonl<unknown>(artifacts.decisions_jsonl).length
}

/** Max number of PENDING intents sharing one cooldown_key. >1 inside a single
 *  short window is exactly the production duplicate-intent bug (the cooldown
 *  is 1h by default; this scenario's whole window is minutes). */
function maxPendingPerCooldownKey(intents: ImprovementIntent[]): { max: number; key: string | null; pending: number } {
  const counts = new Map<string, number>()
  let pending = 0
  for (const intent of intents) {
    if (intent.status !== 'pending') continue
    pending += 1
    const key = intent.cooldown_key ?? '<null>'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let max = 0
  let worst: string | null = null
  for (const [key, count] of counts) {
    if (count > max) {
      max = count
      worst = key
    }
  }
  return { max, key: worst, pending }
}

export async function runBreakerRecoveryScenario(
  opts: BreakerRecoveryOptions,
): Promise<BreakerRecoveryReport> {
  const startedAt = Date.now()
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const initialCapital = opts.initialCapitalUsd ?? 10_000
  const maxDrawdownPct = opts.maxDrawdownPct ?? 5
  const observeWindowMs = opts.observeWindowMs ?? 180_000
  const postAckWindowMs = opts.postAckWindowMs ?? 150_000
  const assertions: BreakerAssertion[] = []
  const record = (id: string, status: AssertionStatus, detail: string): void => {
    assertions.push({ id, status, detail })
    log(`  [${status.toUpperCase()}] ${id}: ${detail}`)
  }
  const skipRemaining = (reason: string, ids: string[]): void => {
    for (const id of ids) record(id, 'skipped', reason)
  }
  const finish = (botId: string | null): BreakerRecoveryReport => {
    const statuses = new Set(assertions.map((a) => a.status))
    const verdict: BreakerRecoveryReport['verdict'] = statuses.has('fail')
      ? 'fail'
      : !statuses.has('pass')
        ? 'skipped'
        : statuses.has('skipped')
          ? 'partial'
          : 'pass'
    return { bot_id: botId, assertions, verdict, total_wall_ms: Date.now() - startedAt }
  }
  const DOWNSTREAM = [
    'breach:drawdown-server-computed',
    'breaker:trips',
    'intents:bounded-while-halted',
    'ack:rearms-breaker',
    'recovery:ticking-resumes',
  ]

  // ── 1. Auth + provision ──────────────────────────────────────────────
  let client: OperatorClient
  try {
    client = await OperatorClient.authenticate(opts.operatorUrl, opts.privateKey)
    record('infra:operator-auth', 'pass', `session established @ ${opts.operatorUrl}`)
  } catch (e) {
    record('infra:operator-auth', 'skipped', `operator unreachable: ${(e as Error).message.slice(0, 200)}`)
    skipRemaining('operator unreachable', ['provision:bot-created', 'provision:trading-api-access', ...DOWNSTREAM])
    return finish(null)
  }

  let botId: string
  let tradingApiUrl: string | null
  let tradingApiToken: string | null
  try {
    const created = await client.provisionBotDetailed({
      prompt:
        'Breaker-recovery eval bot: paper-trade ETH/USDC momentum on a DEX with strict drawdown discipline.',
      name: `breaker-recovery-${Date.now()}`,
      strategy_type: 'dex',
      strategy_config: {
        initial_capital_usd: initialCapital,
        paper_trade: true,
      },
    })
    botId = created.botId
    tradingApiUrl = created.tradingApiUrl
    tradingApiToken = created.tradingApiToken
    record('provision:bot-created', 'pass', `bot ${botId} provisioned (paper, $${initialCapital})`)
  } catch (e) {
    record('provision:bot-created', 'fail', `create failed: ${(e as Error).message.slice(0, 300)}`)
    skipRemaining('bot not provisioned', ['provision:trading-api-access', ...DOWNSTREAM])
    return finish(null)
  }

  try {
    await client.waitForVaultResolved(botId)
  } catch (e) {
    // Paper bots only need the sandbox; a timeout here means the stack is
    // half-up. Downstream tick assertions will surface as skipped on their own.
    log(`  (warn) readiness wait: ${(e as Error).message.slice(0, 200)}`)
  }

  if (!tradingApiUrl || !tradingApiToken) {
    record(
      'provision:trading-api-access',
      'skipped',
      'create response carried no trading_api_url/token (activation deferred) — cannot seed an honest breach',
    )
    skipRemaining('no trading-API access', DOWNSTREAM)
    return finish(botId)
  }
  record('provision:trading-api-access', 'pass', `trading API @ ${tradingApiUrl}`)

  // ── 2. Seed the breach honestly: NAV-drop snapshots, server-side math ─
  const breachNav = initialCapital * (1 - (maxDrawdownPct * 2) / 100) // 2x the cap → unambiguous breach
  try {
    await tradingApi(tradingApiUrl, tradingApiToken, 'POST', '/metrics/snapshot', {
      account_value_usd: String(initialCapital),
      unrealized_pnl: '0',
      realized_pnl: '0',
    })
    await tradingApi(tradingApiUrl, tradingApiToken, 'POST', '/metrics/snapshot', {
      account_value_usd: String(breachNav),
      unrealized_pnl: String(breachNav - initialCapital),
      realized_pnl: '0',
    })
  } catch (e) {
    record(
      'breach:drawdown-server-computed',
      'skipped',
      `trading API unreachable from eval host: ${(e as Error).message.slice(0, 200)}`,
    )
    skipRemaining('breach not seeded', DOWNSTREAM.slice(1))
    return finish(botId)
  }

  // Read the drawdown back through the OPERATOR (its own trading-API proxy):
  // proves the server computed the breach, not that we posted a number.
  const expectedDrawdownPct = maxDrawdownPct * 2 // (initial − breachNav)/initial · 100
  try {
    const history = await client.get<Array<{ drawdown_pct?: string }>>(
      `/api/bots/${encodeURIComponent(botId)}/metrics/history?limit=10`,
    )
    const latest = history[history.length - 1]
    const drawdown = Number.parseFloat(latest?.drawdown_pct ?? 'NaN')
    if (Number.isFinite(drawdown) && drawdown >= expectedDrawdownPct - 0.5) {
      record(
        'breach:drawdown-server-computed',
        'pass',
        `server-computed drawdown ${drawdown.toFixed(2)}% after NAV ${initialCapital}→${breachNav} (client sent NO drawdown field)`,
      )
    } else {
      record(
        'breach:drawdown-server-computed',
        'fail',
        `expected drawdown ≈${expectedDrawdownPct}%, server reports ${latest?.drawdown_pct ?? '<no snapshot>'}`,
      )
    }
  } catch (e) {
    record('breach:drawdown-server-computed', 'skipped', `metrics history unreadable: ${(e as Error).message.slice(0, 200)}`)
  }

  // ── 3a. Breaker trips ────────────────────────────────────────────────
  try {
    const check = await tradingApi<{ should_break: boolean; current_drawdown_pct: string }>(
      tradingApiUrl,
      tradingApiToken,
      'POST',
      '/circuit-breaker/check',
      { max_drawdown_pct: maxDrawdownPct },
    )
    if (check.should_break) {
      record('breaker:trips', 'pass', `should_break=true at drawdown ${check.current_drawdown_pct}% (cap ${maxDrawdownPct}%)`)
    } else {
      record(
        'breaker:trips',
        'fail',
        `should_break=false at drawdown ${check.current_drawdown_pct}% despite cap ${maxDrawdownPct}% — the production halt condition is unreachable`,
      )
    }
  } catch (e) {
    record('breaker:trips', 'skipped', `circuit-breaker/check unreachable: ${(e as Error).message.slice(0, 200)}`)
  }

  // ── 3b. Improvement intents stay bounded while halted ────────────────
  // Observe over >=3 tick cycles. The boundedness claim is only meaningful if
  // the deterministic loop actually ran (>=1 decision recorded); otherwise the
  // assertion is UNVERIFIABLE, not vacuously true.
  log(`  observing ${Math.round(observeWindowMs / 1000)}s for tick activity + intent growth…`)
  const observeDeadline = Date.now() + observeWindowMs
  let lastArtifacts: TickArtifacts | null = null
  while (Date.now() < observeDeadline) {
    lastArtifacts = (await fetchTickArtifacts(client, botId)) ?? lastArtifacts
    await sleep(15_000)
  }
  const decisionsWhileHalted = decisionCount(lastArtifacts)
  const intents = parseJsonl<ImprovementIntent>(lastArtifacts?.improvement_intents_jsonl)
  if (lastArtifacts === null) {
    record('intents:bounded-while-halted', 'skipped', 'tick-artifacts endpoint unreachable (sandbox exec down) — intent growth UNVERIFIABLE')
  } else if (decisionsWhileHalted === 0) {
    record(
      'intents:bounded-while-halted',
      'skipped',
      `no tick decision landed within ${Math.round(observeWindowMs / 1000)}s — loop never ran, boundedness UNVERIFIABLE (not a pass)`,
    )
  } else {
    const { max, key, pending } = maxPendingPerCooldownKey(intents)
    if (max <= 1) {
      record(
        'intents:bounded-while-halted',
        'pass',
        `${decisionsWhileHalted} tick decision(s), ${pending} pending intent(s), max 1 per cooldown_key — no duplicate growth`,
      )
    } else {
      record(
        'intents:bounded-while-halted',
        'fail',
        `cooldown_key "${key}" has ${max} pending intents inside one short window (cooldown is 1h) — the 22-duplicate production bug`,
      )
    }
  }

  // ── 3c. Acknowledge → breaker re-arms → ticking resumes ──────────────
  try {
    await client.post(`/api/bots/${encodeURIComponent(botId)}/risk/acknowledge-drawdown`, {})
    const recheck = await tradingApi<{ should_break: boolean; current_drawdown_pct: string }>(
      tradingApiUrl,
      tradingApiToken,
      'POST',
      '/circuit-breaker/check',
      { max_drawdown_pct: maxDrawdownPct },
    )
    if (!recheck.should_break) {
      record('ack:rearms-breaker', 'pass', `post-acknowledge drawdown ${recheck.current_drawdown_pct}%, should_break=false (baseline rebased)`)
    } else {
      record(
        'ack:rearms-breaker',
        'fail',
        `breaker still tripped after acknowledge (drawdown ${recheck.current_drawdown_pct}%) — the 17h-frozen-bot failure mode`,
      )
    }
  } catch (e) {
    record('ack:rearms-breaker', 'skipped', `acknowledge path unreachable: ${(e as Error).message.slice(0, 200)}`)
  }

  if (lastArtifacts === null) {
    record('recovery:ticking-resumes', 'skipped', 'tick-artifacts endpoint unreachable — resumption UNVERIFIABLE')
    return finish(botId)
  }
  log(`  waiting ${Math.round(postAckWindowMs / 1000)}s for post-acknowledge ticks…`)
  const ackDeadline = Date.now() + postAckWindowMs
  let postAckArtifacts: TickArtifacts | null = null
  while (Date.now() < ackDeadline) {
    postAckArtifacts = (await fetchTickArtifacts(client, botId)) ?? postAckArtifacts
    if (decisionCount(postAckArtifacts) > decisionsWhileHalted) break
    await sleep(15_000)
  }
  const decisionsAfterAck = decisionCount(postAckArtifacts)
  if (postAckArtifacts === null) {
    record('recovery:ticking-resumes', 'skipped', 'tick-artifacts unreachable post-acknowledge — resumption UNVERIFIABLE')
  } else if (decisionsAfterAck > decisionsWhileHalted) {
    record(
      'recovery:ticking-resumes',
      'pass',
      `decisions ${decisionsWhileHalted} → ${decisionsAfterAck} after acknowledge — the bot is ticking again, not frozen`,
    )
  } else {
    record(
      'recovery:ticking-resumes',
      'fail',
      `no new tick decision within ${Math.round(postAckWindowMs / 1000)}s of acknowledge (stuck at ${decisionsAfterAck}) — bot did not resume`,
    )
  }

  // Best-effort teardown: stop the eval bot so the fleet roster isn't polluted.
  try {
    await client.post(`/api/bots/${encodeURIComponent(botId)}/stop`, {})
  } catch {
    log(`  (warn) could not stop eval bot ${botId} — clean up manually`)
  }

  return finish(botId)
}
