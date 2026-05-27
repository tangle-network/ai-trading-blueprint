/**
 * Research-depth judge — scores a bot's research artifact against the
 * S-tier rubric (SPEC.md §5 eval #3).
 *
 * Rubric dimensions:
 *   - source_diversity: how many SourceClass buckets are covered
 *   - recency:          how recent are the cited dates
 *   - citation_accuracy: do cited URLs actually resolve and contain claimed content
 *   - narrative_coherence: does the thesis hold together
 *   - depth_score (0..10): composite — published in the report
 *
 * Citation resolution is gated behind a flag — full resolution requires
 * HTTP fetches against arbitrary URLs which a local-stack eval may not
 * have egress for. When disabled, we fall back to "looks-like-URL"
 * heuristic and an LLM-judged plausibility score.
 */

import { spawnSync } from 'node:child_process'

import type { ResearchShot } from './research-driver.js'
import type { SourceClass, ThesisQuestion } from './thesis-questions.js'

const JUDGE_MODEL = 'claude-sonnet-4-6'

export interface ResearchJudgeScore {
  question_id: string
  depth_score: number          // 0..10 composite
  source_diversity: number     // 0..1 = covered_classes / expected_classes
  recency_hours: number        // mean recency of dates referenced
  citation_resolution: number  // 0..1 — fraction of URLs that resolved
  must_engage_engaged: boolean // did the bot substantively engage the required topic
  notes: string
}

interface CitationResolveResult {
  url: string
  resolved: boolean
  status?: number
}

async function tryResolveCitation(url: string, timeoutMs = 5_000): Promise<CitationResolveResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' })
    return { url, resolved: res.ok, status: res.status }
  } catch {
    return { url, resolved: false }
  } finally {
    clearTimeout(timer)
  }
}

function judgeViaClaude(
  question: ThesisQuestion,
  responseText: string,
): {
  source_classes_covered: SourceClass[]
  mean_recency_hours: number
  must_engage_engaged: boolean
  narrative_coherence: number
  notes: string
} {
  const prompt = `You are scoring a trading bot's research artifact for the question:
"${question.question}"

Required source classes the bot SHOULD have hit: ${question.expected_source_classes.join(', ')}
Required recency: <${question.required_recency_hours}h
Must engage with: ${question.must_engage_with}

Bot's response:
---
${responseText.slice(0, 8000)}
---

Score this artifact. Be skeptical — a generic answer with no specifics is a fail. Output ONE JSON object, no prose, no fences:

{
  "source_classes_covered": ["crypto_news", ...],  // which of the expected classes the bot actually pulled from
  "mean_recency_hours": 24.0,                       // estimate from dates referenced in text (use ${question.required_recency_hours * 2} if no dates given)
  "must_engage_engaged": true,                      // did the bot substantively address "${question.must_engage_with}"?
  "narrative_coherence": 0.7,                       // 0..1 — does the thesis hold together logically?
  "notes": "<1-2 sentence skeptical critique>"
}`
  const proc = spawnSync('claude', ['--print', '--model', JUDGE_MODEL, '--output-format', 'text'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (proc.status !== 0) {
    return {
      source_classes_covered: [],
      mean_recency_hours: question.required_recency_hours * 4,
      must_engage_engaged: false,
      narrative_coherence: 0,
      notes: `judge_failed: ${proc.stderr.slice(0, 200)}`,
    }
  }
  const out = proc.stdout
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start < 0 || end < 0) {
    return {
      source_classes_covered: [],
      mean_recency_hours: question.required_recency_hours * 4,
      must_engage_engaged: false,
      narrative_coherence: 0,
      notes: `judge_unparseable: ${out.slice(0, 200)}`,
    }
  }
  return JSON.parse(out.slice(start, end + 1))
}

export interface JudgeShotOptions {
  resolveCitations?: boolean
}

export async function judgeResearchShot(
  shot: ResearchShot,
  opts: JudgeShotOptions = {},
): Promise<ResearchJudgeScore> {
  const llm = judgeViaClaude(shot.question, shot.bot_response_text)
  // Citation resolution
  let citationResolution = 0
  if (opts.resolveCitations && shot.cited_urls.length > 0) {
    const resolutions = await Promise.all(shot.cited_urls.slice(0, 10).map((u) => tryResolveCitation(u)))
    citationResolution = resolutions.filter((r) => r.resolved).length / resolutions.length
  } else if (shot.cited_urls.length > 0) {
    // Fallback: count URLs that *look* like real domains (not example.com etc).
    const looksReal = shot.cited_urls.filter(
      (u) => !/example\.|placeholder|todo|xxx/i.test(u) && /\.[a-z]{2,}\//i.test(u),
    ).length
    citationResolution = looksReal / shot.cited_urls.length
  }
  // Diversity = fraction of expected classes the bot actually hit
  const expected = new Set(shot.question.expected_source_classes)
  const covered = new Set(llm.source_classes_covered.filter((c) => expected.has(c)))
  const source_diversity = expected.size === 0 ? 0 : covered.size / expected.size
  // Composite: weighted (recency penalty + diversity + engagement + coherence + citations)
  const recencyScore = Math.max(0, 1 - llm.mean_recency_hours / (shot.question.required_recency_hours * 4))
  const engagementScore = llm.must_engage_engaged ? 1 : 0
  const depth_score =
    10 *
    (0.25 * source_diversity +
      0.15 * recencyScore +
      0.25 * engagementScore +
      0.20 * llm.narrative_coherence +
      0.15 * citationResolution)
  return {
    question_id: shot.question.id,
    depth_score,
    source_diversity,
    recency_hours: llm.mean_recency_hours,
    citation_resolution: citationResolution,
    must_engage_engaged: llm.must_engage_engaged,
    notes: llm.notes,
  }
}

export async function judgeAllResearchShots(shots: ResearchShot[], opts: JudgeShotOptions = {}): Promise<ResearchJudgeScore[]> {
  const out: ResearchJudgeScore[] = []
  for (const s of shots) {
    process.stderr.write(`  · judging research thesis: ${s.question.id}…\n`)
    out.push(await judgeResearchShot(s, opts))
  }
  return out
}
