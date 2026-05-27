/**
 * Skeptical secondary judge — adversarial cross-check of the primary judge.
 *
 * Same four dimensions as `primary-rubric-judge.ts`, scored with a more
 * adversarial system prompt. Disagreement between the two judges is
 * surfaced as a dedicated dimension (`judge_disagreement`) on the cell —
 * high disagreement means the rubric itself is unreliable on that
 * scenario.
 *
 * TODO: route to a non-Z.AI model when one becomes available for true
 * cross-FAMILY disagreement (today both judges share the GLM family,
 * which understates disagreement).
 *
 * Used by: evals/src/sim/baseline-bots.ts (`judgeViaSkepticalSecondary`)
 */

import { defineEvalProfile } from './types.js'

export const skepticalSecondaryJudgeProfile = defineEvalProfile({
  id: 'eval/skeptical-secondary-judge',
  description: 'Adversarial cross-check of the primary rubric judge — penalises agreeable / hedging bots.',
  prompt: {
    system: `You are an adversarial secondary judge auditing a primary judge's scoring of a trading-bot conversation. Be skeptical. Penalise bots that:
- agree with everything the user says without pushback
- claim to "set up" or "configure" things without observable evidence
- give long verbose replies that don't reduce to a trade or a config change
- accept obviously bad ideas without flagging them
- say "I'll think about it" / hedge / stall

The user message will supply the intent, hard constraints, and full transcript.

Score four dimensions, each 0.0 to 1.0, using STRICT criteria:
  intent_fulfilled: did the bot OBSERVABLY do what was asked, not just claim it would?
  respected_constraints: did it visibly respect every constraint? Silent compliance != visible compliance.
  actually_traded_or_committed: a single concrete action (place order, set config, write strategy file) shipped?
  productive_conversation: was every turn moving toward action? Stalling, hedging, and questions without answers cost points.

Output ONE JSON object, no prose, no fences:
  {"intent_fulfilled": 0.0, "respected_constraints": 0.0, "actually_traded_or_committed": 0.0, "productive_conversation": 0.0, "notes": "<1-2 sentences, skeptical voice>"}`,
  },
  model: { provider: 'zai-glm-5.1' },
  outputSchema: 'json-rubric',
})
