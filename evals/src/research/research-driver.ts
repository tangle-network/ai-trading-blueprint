/**
 * Research-depth eval — eval #3 from SPEC.md §5.
 *
 * For each `ThesisQuestion`, asks a provisioned bot to research and
 * answer. Captures the bot's full response + cited sources from its
 * transcript. Returns a `ResearchEvalData` slice that plugs into the
 * S-tier per-bot report renderer.
 *
 * Mechanics mirror the multishot user-sim driver: a user-sim agent
 * (here: a single question, single response — no multi-turn loop)
 * posts to the operator's chat API, waits for the bot's reply, returns
 * the captured transcript for the judge.
 */

import type { ResearchEvalData } from '../report/types.js'
import { STANDARD_THESIS_QUESTIONS, type ThesisQuestion } from './thesis-questions.js'

const POLL_INTERVAL_MS = 5_000

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

interface TranscriptMessage {
  id?: string
  role?: string
  parts?: Array<{ type?: string; text?: string }>
  content?: string | Array<{ type?: string; text?: string }>
  text?: string
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

export interface ResearchShot {
  question: ThesisQuestion
  bot_response_text: string
  duration_ms: number
  /** Sources cited in the response — extracted via URL regex from the bot's reply. */
  cited_urls: string[]
}

export interface RunResearchEvalOptions {
  operatorUrl: string
  token: string
  questions?: ThesisQuestion[]
  perQuestionTimeoutMs?: number
}

const URL_REGEX = /https?:\/\/[^\s)\]<>"']+/g

export async function runResearchEval(opts: RunResearchEvalOptions): Promise<{ shots: ResearchShot[] }> {
  const questions = opts.questions ?? STANDARD_THESIS_QUESTIONS
  const shots: ResearchShot[] = []
  for (const q of questions) {
    process.stderr.write(`  · research thesis: ${q.id}…\n`)
    // 1. Provision a fresh research-mode bot through the operator API.
    const created = await postJson<{ id?: string; bot_id?: string; bot?: { id?: string } }>(
      `${opts.operatorUrl}/api/bots`,
      opts.token,
      { prompt: q.question, name: q.id, strategy_type: 'dex' /* generic */ },
    )
    const botId = created.id ?? created.bot_id ?? created.bot?.id
    if (!botId) throw new Error(`bot create failed: ${JSON.stringify(created)}`)
    const session = await postJson<{ id?: string; session_id?: string; session?: { id?: string } }>(
      `${opts.operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions`,
      opts.token,
      { title: `research:${q.id}` },
    )
    const sessionId = session.id ?? session.session_id ?? session.session?.id
    if (!sessionId) throw new Error(`session create failed`)
    const messagesUrl = `${opts.operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages`
    const startedAt = Date.now()
    await postJson(messagesUrl, opts.token, {
      message: q.question,
      parts: [{ type: 'text', text: q.question }],
    })
    // 2. Wait for the bot's response.
    const deadline = startedAt + (opts.perQuestionTimeoutMs ?? 180_000)
    let responseText = ''
    while (Date.now() < deadline) {
      const t = await getJson<{ messages?: TranscriptMessage[]; items?: TranscriptMessage[] }>(
        `${messagesUrl}?limit=200`,
        opts.token,
      )
      const msgs = t.messages ?? t.items ?? []
      const lastAssistant = [...msgs].reverse().find((m) => (m.role ?? '').toLowerCase() === 'assistant')
      if (lastAssistant) {
        const text = messageText(lastAssistant)
        if (text.length > 100) {
          responseText = text
          break
        }
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    const urls = Array.from(new Set(responseText.match(URL_REGEX) ?? []))
    shots.push({
      question: q,
      bot_response_text: responseText,
      duration_ms: Date.now() - startedAt,
      cited_urls: urls,
    })
  }
  return { shots }
}

/** Aggregate research shots into the report renderer's `ResearchEvalData` slice. */
export function aggregateResearchData(shots: ResearchShot[], judgeScores: Array<{ depth_score: number; recency_hours: number; source_diversity: number; citation_resolution: number }>): ResearchEvalData {
  const n = shots.length
  if (n === 0) {
    return {
      theses_evaluated: 0, mean_source_count: 0, mean_recency_hours: 0,
      source_diversity_score: 0, citation_resolution_rate: 0, depth_score: 0,
    }
  }
  const totalSources = shots.reduce((acc, s) => acc + s.cited_urls.length, 0)
  const meanScores = (key: keyof typeof judgeScores[number]) =>
    judgeScores.reduce((a, b) => a + (b[key] as number), 0) / judgeScores.length
  return {
    theses_evaluated: n,
    mean_source_count: totalSources / n,
    mean_recency_hours: meanScores('recency_hours'),
    source_diversity_score: meanScores('source_diversity'),
    citation_resolution_rate: meanScores('citation_resolution'),
    depth_score: meanScores('depth_score'),
  }
}
