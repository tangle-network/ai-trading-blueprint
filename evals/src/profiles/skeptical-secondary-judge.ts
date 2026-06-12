/**
 * Skeptical secondary judge — adversarial cross-check of the primary judge.
 *
 * Same four dimensions as `primary-rubric-judge.ts`, scored with a more
 * adversarial system prompt. Disagreement between the two judges is
 * surfaced as a dedicated dimension (`judge_disagreement`) on the cell —
 * high disagreement means the rubric itself is unreliable on that
 * scenario.
 *
 * Cross-FAMILY by default: the primary judge runs on Z.AI GLM, so this
 * profile routes to Moonshot Kimi K2 (`kimi-k2` in llm-call.ts's
 * MODEL_CONFIG). Same-family judge pairs systematically understate
 * disagreement, which is the one signal this judge exists to produce.
 *
 * Degradation contract: when MOONSHOT_API_KEY is not set,
 * `resolveSkepticalSecondaryJudgeProfile()` falls back to the previous
 * GLM-5.1 routing and the caller MUST surface the fallback in the cell's
 * notes (baseline-bots.ts does) — never a silent vacuous pass, never a
 * crashed campaign.
 *
 * Used by: evals/src/sim/baseline-bots.ts (`judgeViaSkepticalSecondary`)
 */

import { defineEvalProfile, type EvalProfile } from './types.js'

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
  model: { provider: 'kimi-k2' },
  outputSchema: 'json-rubric',
})

/** Routing the secondary judge actually ran on — callers stamp this into the
 *  cell notes so a fallback is visible in every scored artifact. */
export interface SkepticalSecondaryJudgeRouting {
  profile: EvalProfile
  /** True when MOONSHOT_API_KEY was missing and the judge fell back to the
   *  GLM family (same family as the primary — disagreement is understated). */
  crossFamilyDegraded: boolean
}

let warnedAboutFallback = false

/** Resolve the profile with the documented MOONSHOT_API_KEY fallback.
 *  kimi-k2 when the Moonshot key is present; otherwise the previous
 *  zai-glm-5.1 routing (prompt unchanged) + a one-time stderr warning. */
export function resolveSkepticalSecondaryJudgeProfile(): SkepticalSecondaryJudgeRouting {
  if (process.env.MOONSHOT_API_KEY) {
    return { profile: skepticalSecondaryJudgeProfile, crossFamilyDegraded: false }
  }
  if (!warnedAboutFallback) {
    warnedAboutFallback = true
    process.stderr.write(
      'skeptical-secondary-judge: MOONSHOT_API_KEY not set — falling back to zai-glm-5.1 ' +
        '(same family as the primary judge; judge_disagreement will be understated)\n',
    )
  }
  return {
    profile: { ...skepticalSecondaryJudgeProfile, model: { provider: 'zai-glm-5.1' } },
    crossFamilyDegraded: true,
  }
}
