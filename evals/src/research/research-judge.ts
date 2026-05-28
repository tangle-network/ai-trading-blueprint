/**
 * Research-depth judge — scores a bot's research artifact against the
 * S-tier rubric (SPEC.md §5 eval #3).
 *
 * Rubric:
 *   - source_diversity: covered_classes / expected_classes
 *   - recency_hours:    mean from dates referenced (fallback: penalised)
 *   - citation_resolution: fraction of cited URLs that resolve via HTTP HEAD
 *   - narrative_coherence: LLM-judged (0..1)
 *   - depth_score (0..10): weighted composite — published in the report
 *
 * LLM calls go through `llmCall` + `extractJson` from `evals/src/sim/llm-call.ts`
 * — no spawnSync inline; no JSON.parse-without-try-catch hazards.
 */

import { runProfileJson } from '../sim/llm-call.js'
import { researchJudgeProfile } from '../profiles/research-judge.js'
import type { ResearchShot } from './research-driver.js'
import type { SourceClass, ThesisQuestion } from './thesis-questions.js'

export interface ResearchJudgeScore {
  question_id: string
  depth_score: number          // 0..10 composite
  source_diversity: number     // 0..1 = covered_classes / expected_classes
  recency_hours: number        // mean recency of dates referenced
  citation_resolution: number  // 0..1 — fraction of URLs that resolved
  must_engage_engaged: boolean
  notes: string
}

interface JudgeLlmOutput {
  source_classes_covered: SourceClass[]
  mean_recency_hours: number
  recency_fallback_used: boolean
  must_engage_engaged: boolean
  narrative_coherence: number
  notes: string
}

async function tryResolveCitation(url: string, timeoutMs = 5_000): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Per-shot user message; rubric + model live in the profile
 *  (evals/src/profiles/research-judge.ts). */
function judgeMessageFor(question: ThesisQuestion, responseText: string): string {
  return `Thesis question: "${question.question}"

Required source classes the bot SHOULD have hit: ${question.expected_source_classes.join(', ')}
Required recency: <${question.required_recency_hours}h
Must engage with: ${question.must_engage_with}

Bot's response:
---
${responseText.slice(0, 8000)}
---`
}

function fallbackJudgement(question: ThesisQuestion, reason: string): JudgeLlmOutput {
  return {
    source_classes_covered: [],
    mean_recency_hours: question.required_recency_hours * 4,
    recency_fallback_used: true,
    must_engage_engaged: false,
    narrative_coherence: 0,
    notes: reason,
  }
}

export interface JudgeShotOptions {
  resolveCitations?: boolean
}

export async function judgeResearchShot(
  shot: ResearchShot,
  opts: JudgeShotOptions = {},
): Promise<ResearchJudgeScore> {
  // ── LLM judge call (with safe JSON extraction) ─────────────────────
  const { result: llm, raw } = await runProfileJson<JudgeLlmOutput>(
    researchJudgeProfile,
    { message: judgeMessageFor(shot.question, shot.bot_response_text) },
  )
  const j = llm ?? fallbackJudgement(
    shot.question,
    !raw.ok ? `judge_call_failed: ${raw.stderr.slice(0, 200)}` : `judge_output_unparseable: ${raw.output.slice(0, 200)}`,
  )

  // ── Citation resolution ───────────────────────────────────────────
  let citationResolution = 0
  if (opts.resolveCitations && shot.cited_urls.length > 0) {
    const resolutions = await Promise.all(shot.cited_urls.slice(0, 10).map((u) => tryResolveCitation(u)))
    citationResolution = resolutions.filter(Boolean).length / resolutions.length
  } else if (shot.cited_urls.length > 0) {
    // Fallback: count URLs that *look* like real domains (not example.com etc).
    const looksReal = shot.cited_urls.filter(
      (u) => !/example\.|placeholder|todo|xxx/i.test(u) && /\.[a-z]{2,}\//i.test(u),
    ).length
    citationResolution = looksReal / shot.cited_urls.length
  }

  // ── Composite ─────────────────────────────────────────────────────
  const expected = new Set(shot.question.expected_source_classes)
  const covered = new Set(j.source_classes_covered.filter((c) => expected.has(c)))
  const source_diversity = expected.size === 0 ? 0 : covered.size / expected.size
  // Recency: hard zero when the LLM had to fall back (no dates referenced).
  // Previously this gave half-credit, which let no-citation answers
  // squeak past the recency dimension.
  const recencyScore = j.recency_fallback_used
    ? 0
    : Math.max(0, 1 - j.mean_recency_hours / (shot.question.required_recency_hours * 4))
  const engagementScore = j.must_engage_engaged ? 1 : 0
  const depth_score =
    10 *
    (0.25 * source_diversity +
      0.15 * recencyScore +
      0.25 * engagementScore +
      0.2 * j.narrative_coherence +
      0.15 * citationResolution)
  return {
    question_id: shot.question.id,
    depth_score,
    source_diversity,
    recency_hours: j.mean_recency_hours,
    citation_resolution: citationResolution,
    must_engage_engaged: j.must_engage_engaged,
    notes: j.notes,
  }
}

export async function judgeAllResearchShots(
  shots: ResearchShot[],
  opts: JudgeShotOptions = {},
): Promise<ResearchJudgeScore[]> {
  const out: ResearchJudgeScore[] = []
  for (const s of shots) {
    process.stderr.write(`  · judging research thesis: ${s.question.id}…\n`)
    out.push(await judgeResearchShot(s, opts))
  }
  return out
}
