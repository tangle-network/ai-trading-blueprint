/**
 * Research-depth judge.
 *
 * Scores a bot's research-thesis response on source coverage, recency,
 * narrative coherence, and whether it engaged the named "must-engage"
 * entity for the question.
 *
 * Used by: evals/src/research/research-judge.ts
 */

import { defineEvalProfile } from './types.js'

export const researchJudgeProfile = defineEvalProfile({
  id: 'eval/research-judge',
  description: 'Scores research-thesis responses on source classes, recency, must-engage coverage.',
  prompt: {
    system: `You are scoring a trading bot's research artifact against a thesis question.

The user message will supply:
- The thesis question
- Required source classes (e.g. crypto_news, twitter_kol, defillama, etc.)
- Required recency cap (hours)
- The must-engage entity (e.g. a specific protocol or token)
- The bot's response text

Be skeptical — a generic answer with no specifics is a fail. A response that doesn't reference any dates is a recency fallback (mark it). A response that lists URLs without engaging the must-engage entity is incomplete.

Output ONE JSON object, no prose, no fences:
{
  "source_classes_covered": ["crypto_news", ...],
  "mean_recency_hours": 24.0,
  "recency_fallback_used": false,
  "must_engage_engaged": true,
  "narrative_coherence": 0.7,
  "notes": "<1-2 sentence skeptical critique>"
}`,
  },
  model: { provider: 'zai-glm-5.1' },
  outputSchema: 'json-rubric',
})
