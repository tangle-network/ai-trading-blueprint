/**
 * `llmCall()` — the SINGLE LLM-invocation helper every judge + user-sim
 * call goes through. Backed by agent-runtime's `runAgentTaskStream` +
 * `createOpenAICompatibleBackend` (NOT a CLI subprocess).
 *
 * Why this design:
 *   - Previously this file spawned `claude --print` per call. That hit
 *     Anthropic CLI rate limits during a 36-cell campaign and every cell
 *     failed simultaneously (smoke v4). Routing through agent-runtime's
 *     backend abstraction means we (a) stay on the same model providers
 *     the bot itself uses (Z.AI / Moonshot — no extra rate-limit budget
 *     contention) and (b) inherit retry / backoff / circuit-breaker that
 *     the agent-runtime substrate already implements.
 *   - The full `defineAgent` ceremony (manifest + tools + rubric files)
 *     is overkill for one-shot judge / user-sim calls. `runAgentTaskStream`
 *     is the right primitive: it wraps the backend with proper context,
 *     emits structured `RuntimeStreamEvent`s we can accumulate, and is
 *     one async call instead of four manifest files per judge.
 *
 * SOT — every judge + user-sim turn generator routes through this file.
 *   - user-sim turns (evals/src/sim/user-sim-driver.ts)
 *   - primary user-sim judge (evals/src/sim/multishot-user-sim.ts)
 *   - skeptical secondary judge (evals/src/sim/baseline-bots.ts)
 *   - research judge (evals/src/research/research-judge.ts)
 *   - robustness judge (evals/src/robustness/robustness-driver.ts)
 *   - agent-in-loop walk-forward (evals/src/sim/agent-in-loop.ts)
 *
 * If you need an LLM call in this codebase, IMPORT from here. Do not
 * spawn a CLI, do not `fetch` an API directly — every model selection
 * + provider routing lives in this module's `MODEL_CONFIG` map.
 */

import { createOpenAICompatibleBackend, runAgentTaskStream } from '@tangle-network/agent-runtime'
import type { AgentTaskSpec } from '@tangle-network/agent-runtime'

/** Logical model identifiers — what callers ask for. The concrete
 *  provider/baseUrl/api-key resolution lives in MODEL_CONFIG below. */
export type LlmModel =
  | 'kimi-k2'        // Moonshot K2.6 — fast, cheap, great for user-sim turns
  | 'glm-4.7'        // Z.AI GLM-4.7 — solid generalist
  | 'glm-5.1'        // Z.AI GLM-5.1 — sharper, prefer for judge rubrics
  | string           // fallback: anything else MODEL_CONFIG knows about

interface ModelRouting {
  /** API key resolved at call time so env updates propagate without re-import. */
  apiKey: () => string
  baseUrl: string
  /** Model name to send over the wire — provider-specific. */
  modelId: string
  /** Human label for error messages + debug. */
  label: string
}

/** Single source of truth for which provider + endpoint each logical
 *  model resolves to. Add new models here, never in the call sites. */
const MODEL_CONFIG: Record<string, ModelRouting> = {
  'kimi-k2': {
    apiKey: () => process.env.MOONSHOT_API_KEY ?? '',
    baseUrl: 'https://api.moonshot.ai/v1',
    modelId: 'kimi-k2.6',
    label: 'Moonshot Kimi K2.6',
  },
  'glm-4.7': {
    apiKey: () => process.env.ZAI_API_KEY ?? '',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    modelId: 'glm-4.7',
    label: 'Z.AI GLM-4.7',
  },
  'glm-5.1': {
    apiKey: () => process.env.ZAI_GLM_API_KEY ?? process.env.ZAI_API_KEY ?? '',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    modelId: 'glm-5.1',
    label: 'Z.AI GLM-5.1',
  },
}

/** Default model — Kimi K2.6. Cheap, fast, and on Moonshot rate-limit
 *  budget separate from Anthropic / Z.AI so a Claude rate-limit hit
 *  doesn't kill an eval campaign mid-run. */
const DEFAULT_MODEL: LlmModel = 'kimi-k2'

// Model selection moved OUT of a central const and INTO each profile
// (evals/src/profiles/*.ts carries its own `model.provider`). Callers that
// need a one-shot call still pass `model` to llmCall directly; everything
// judge/user-sim goes through runProfile and inherits the profile's pick.

export interface LlmCallOptions {
  prompt: string
  model?: LlmModel
  /** Per-call timeout (ms). Default 180s — long enough for full judge
   *  rubric responses with reasoning, short enough to surface hangs. */
  timeoutMs?: number
}

export interface LlmCallResult {
  output: string
  exitCode: number
  stderr: string
  /** True when the LLM responded successfully with non-empty content. */
  ok: boolean
}

/** Resolve a logical model id to its provider routing. Throws on unknown
 *  model id so call sites can't silently ship a typo to prod. */
export type { ModelRouting }

/** Resolve a model alias to its provider routing, validating the API key is
 *  set. Exported so other eval surfaces (e.g. the RLM trace analyst) reuse the
 *  single provider table instead of duplicating it. Throws on unknown model or
 *  missing key. */
export function resolveModel(model: LlmModel): ModelRouting {
  const cfg = MODEL_CONFIG[model]
  if (!cfg) {
    const known = Object.keys(MODEL_CONFIG).join(', ')
    throw new Error(`unknown LLM model "${model}"; known: ${known}`)
  }
  if (!cfg.apiKey()) {
    throw new Error(`${cfg.label} requires env var (MOONSHOT_API_KEY / ZAI_API_KEY etc.) — not set`)
  }
  return cfg
}

/** Core LLM call. Async — returns a promise. */
export async function llmCall(opts: LlmCallOptions): Promise<LlmCallResult> {
  const cfg = resolveModel(opts.model ?? DEFAULT_MODEL)
  const backend = createOpenAICompatibleBackend({
    apiKey: cfg.apiKey(),
    baseUrl: cfg.baseUrl,
    model: cfg.modelId,
  })
  const task: AgentTaskSpec = {
    id: `eval-llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    intent: 'one-shot eval LLM call (judge or user-sim turn)',
    domain: 'eval',
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000)
  const parts: string[] = []
  let backendError: string | null = null
  try {
    for await (const ev of runAgentTaskStream({
      task,
      backend,
      input: { message: opts.prompt },
      signal: controller.signal,
    })) {
      if (ev.type === 'text_delta') parts.push(ev.text)
      else if (ev.type === 'backend_error') backendError = ev.message
    }
  } catch (e) {
    return { output: parts.join('').trim(), exitCode: 1, stderr: (e as Error).message, ok: false }
  } finally {
    clearTimeout(timer)
  }
  if (backendError) {
    return { output: parts.join('').trim(), exitCode: 1, stderr: backendError, ok: false }
  }
  const output = parts.join('').trim()
  return { output, exitCode: 0, stderr: '', ok: output.length > 0 }
}

/** Extract the first JSON object from an LLM response. Tolerates code
 *  fences and prose around the JSON. Returns null on unrecoverable
 *  parse failure — judges fall back gracefully instead of crashing the
 *  whole eval. */
export function extractJson<T>(text: string): T | null {
  // Strip ```json … ``` fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenceMatch?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/** Convenience: call LLM, extract a JSON object, return null on any failure.
 *  Judges use this to defer error handling to the call site instead of
 *  duplicating spawn-stderr + try-catch + slice-bounds-check in every
 *  judge function. */
export async function llmCallJson<T>(opts: LlmCallOptions): Promise<{ result: T | null; raw: LlmCallResult }> {
  const raw = await llmCall(opts)
  if (!raw.ok) return { result: null, raw }
  return { result: extractJson<T>(raw.output), raw }
}

// ─── Profile-based invocation ─────────────────────────────────────────
//
// The profile-driven entry point. Callers import a profile object from
// evals/src/profiles/ and pass it to `runProfile(profile, {message})`.
// No inline prompts, no model-name hardcodes at call sites.

import type { EvalProfile, EvalModelProvider } from '../profiles/types.js'

/** Map an EvalModelProvider to the concrete LlmModel routing in
 *  MODEL_CONFIG above. Centralized so both `llmCall(model=...)` and
 *  `runProfile(profile)` resolve to the same backend. */
const PROVIDER_TO_LLM_MODEL: Record<EvalModelProvider, LlmModel> = {
  'kimi-k2': 'kimi-k2',
  'zai-glm-4.7': 'glm-4.7',
  'zai-glm-5.1': 'glm-5.1',
}

/** Invoke an `EvalProfile` with a user message. The profile carries the
 *  system prompt + model pick; the caller passes the per-call user
 *  input. Wraps `llmCall` so output-schema-aware variants share the
 *  same backend wiring + timeout handling. */
export async function runProfile(
  profile: EvalProfile,
  input: { message: string },
): Promise<LlmCallResult> {
  return llmCall({
    prompt: `${profile.prompt.system}\n\n---\n\n${input.message}`,
    model: PROVIDER_TO_LLM_MODEL[profile.model.provider],
    ...(profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}),
  })
}

/** Profile-driven variant of `llmCallJson` — invokes the profile,
 *  extracts a JSON object from the response. Returns null on any
 *  failure so judge sites can fall back gracefully. */
export async function runProfileJson<T>(
  profile: EvalProfile,
  input: { message: string },
): Promise<{ result: T | null; raw: LlmCallResult }> {
  const raw = await runProfile(profile, input)
  if (!raw.ok) return { result: null, raw }
  return { result: extractJson<T>(raw.output), raw }
}
