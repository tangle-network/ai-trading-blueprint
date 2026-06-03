/**
 * Eval-local agent profiles + the `runProfile` invocation helper.
 *
 * Pattern (matches Drew's directive: agent-runtime stays generic, each
 * consumer defines its own profile shape):
 *
 *   1. `EvalProfile` (types.ts) — the local shape, sized exactly to what
 *      a one-shot eval LLM call needs: id, system prompt, model pick,
 *      optional output-schema hint, optional timeout.
 *   2. Each judge / user-sim is a `defineEvalProfile({...})` literal in
 *      its own file (primary-rubric-judge.ts, etc.).
 *   3. `runProfile(profile, input)` resolves the model to a backend and
 *      routes through agent-runtime's `runAgentTaskStream` — the SAME
 *      generic primitive the centralized sandbox SDK and the
 *      decentralized blueprint will each use with their own profile
 *      shapes. No shared package; just the generic runtime contract.
 *
 * Migration plan (task #110):
 *   - multishot-user-sim.ts → uses `primaryRubricJudgeProfile` +
 *     `skepticalSecondaryJudgeProfile` instead of inline strings.
 *   - user-sim-driver.ts → uses `userSimTurnProfile` for nextUserTurn.
 *   - research-judge.ts → uses `researchJudgeProfile`.
 *   - robustness-driver.ts → uses `robustnessJudgeProfile`.
 *   - llm-call.ts's `EVAL_MODELS` constant gets deleted: each profile
 *     carries its own model pick.
 */

export { type EvalProfile, type EvalModelProvider, defineEvalProfile } from './types.js'
export { userSimTurnProfile } from './user-sim-turn.js'
export { primaryRubricJudgeProfile } from './primary-rubric-judge.js'
export { skepticalSecondaryJudgeProfile } from './skeptical-secondary-judge.js'
export { researchJudgeProfile } from './research-judge.js'
export { robustnessJudgeProfile } from './robustness-judge.js'
export { activeUserLabPromptProfile } from './active-user-lab.js'
