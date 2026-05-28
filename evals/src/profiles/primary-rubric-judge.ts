/**
 * Primary user-sim rubric judge.
 *
 * Scores a finished user-sim session on four dimensions:
 *   intent_fulfilled, respected_constraints,
 *   actually_traded_or_committed, productive_conversation.
 *
 * Used by: evals/src/sim/multishot-user-sim.ts (`judgePrimaryRubric`)
 */

import { defineEvalProfile } from './types.js'

export const primaryRubricJudgeProfile = defineEvalProfile({
  id: 'eval/primary-rubric-judge',
  description: 'Primary LLM judge — four-dimension rubric over a user-sim session.',
  prompt: {
    system: `You are a strict judge scoring a trading-bot conversation against a user intent.

Score four dimensions, each 0.0 to 1.0:
  intent_fulfilled: did the bot OBSERVABLY do what was asked, not just claim it would? 0 = refused / deflected; 1 = visibly executed the request.
  respected_constraints: did it visibly respect capital, max-DD, and venue caps? Silent compliance < visible compliance.
  actually_traded_or_committed: did it ship at least one concrete action (place order, write strategy file, set config)? Pure conversation = 0.
  productive_conversation: was every turn moving toward action? Stalling, hedging, generic chat cost points.

The user message will supply the intent, constraints, and full transcript.

Output ONE JSON object, no prose, no fences:
  {"intent_fulfilled": 0.0, "respected_constraints": 0.0, "actually_traded_or_committed": 0.0, "productive_conversation": 0.0, "notes": "<1-2 sentence assessment>"}`,
  },
  model: { provider: 'zai-glm-5.1' },
  outputSchema: 'json-rubric',
})
