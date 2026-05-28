/**
 * EvalProfile — eval-substrate-local agent definition.
 *
 * Why this shape (and not @tangle-network/sandbox's `AgentProfile`):
 *   - agent-runtime is already generic over `TInput extends AgentBackendInput`.
 *     We don't need a SHARED struct between this eval, the centralized
 *     sandbox SDK, and the decentralized blueprint — we need each consumer
 *     to define its OWN shape sized to its domain, and route through the
 *     same generic runtime primitives (`runAgentTaskStream`,
 *     `createOpenAICompatibleBackend`).
 *   - This profile only needs the minimum to (a) build a backend (model
 *     provider + name) and (b) prime the LLM (system prompt). Everything
 *     else the sandbox SDK profile carries (tools, mcp, subagents,
 *     resources, hooks, modes) is irrelevant for an LLM-as-judge or a
 *     user-sim turn generator.
 *   - Local definition keeps the eval substrate decoupled from sandbox
 *     SDK churn. A breaking change in `@tangle-network/sandbox`'s
 *     `AgentProfile` doesn't touch this codebase.
 *
 * Discipline:
 *   - One file per profile under `evals/src/profiles/<id>.ts`
 *   - Profile defines: id, system prompt, model pick, optional output schema
 *   - Drivers IMPORT a profile and call `runProfile(profile, {message})`
 *   - Drivers do NOT write inline prompt strings or hardcode model names
 */

export type EvalModelProvider =
  /** Moonshot Kimi — fast, cheap, independent rate-limit budget. Good for
   *  user-sim turn generation and high-volume judge calls. */
  | 'kimi-k2'
  /** Z.AI GLM 4.7 — solid generalist, what the bot itself uses. */
  | 'zai-glm-4.7'
  /** Z.AI GLM 5.1 — sharper reasoning, prefer for judge rubrics. */
  | 'zai-glm-5.1'

export interface EvalProfile {
  /** Stable identifier; doubles as the run-record provenance key. */
  id: string
  /** Short description of what this profile does. Surfaced in trace
   *  metadata; never shown to the model. */
  description?: string
  /** System prompt — primes the LLM's role. The user message is supplied
   *  at invocation time by the caller. */
  prompt: { system: string }
  /** Which logical model to use. Resolved to a backend in `runProfile`. */
  model: { provider: EvalModelProvider }
  /** Optional output-shape hint. `json-rubric` = profile expects a JSON
   *  object back; `runProfile` exposes a JSON-extracting variant.
   *  `free-text` = anything goes. Default: `free-text`. */
  outputSchema?: 'json-rubric' | 'free-text'
  /** Optional per-call timeout override (ms). Default: 180_000. */
  timeoutMs?: number
}

/** Identity-typed declaration helper. The const-narrowed return type
 *  means callers see the literal `id` / `model.provider` in autocomplete
 *  + IDE hover, which catches typos at the call site. */
export function defineEvalProfile<T extends EvalProfile>(profile: T): T {
  return profile
}
