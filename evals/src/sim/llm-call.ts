/**
 * `llmCall()` — the SINGLE LLM-invocation helper every judge + user-sim
 * call goes through (NOT a CLI subprocess). Two transports, one per owner:
 *   - `llmChatClient` — agent-runtime's `profileChatClient`: each call runs one
 *     exact `AgentProfile` through `createExecutor({ backend: 'router' })` ->
 *     `streamAgentTurn` against the model's OpenAI-compatible endpoint, so
 *     retries, usage, and the served-model check are Runtime's. Judges,
 *     user-sim turns, and the autoresearch judge use it.
 *   - `traceAnalystChatClient` — agent-eval's OpenAI-compatible `ChatClient`,
 *     for `createChatTraceEngine`, whose per-turn trace tools a fixed Runtime
 *     profile cannot declare in advance.
 *
 * Why not a CLI: spawning `claude --print` per call hit Anthropic CLI rate
 * limits during a 36-cell campaign (smoke v4). These call the providers the
 * bot itself uses (Z.AI / Moonshot).
 *
 * If you need an LLM call in this codebase, IMPORT from here. Do not spawn a
 * CLI or `fetch` an API directly. Model selection and provider routing live in
 * `model-routing.ts` and are re-exported here.
 */

import { createChatClient, type ChatClient } from '@tangle-network/agent-eval'
import { profileChatClient } from '@tangle-network/agent-runtime/kernel'
import { resolveModel, type LlmModel } from './model-routing.js'

export {
  modelExecutionIdentity,
  resolveModel,
  type LlmModel,
  type ModelRouting,
} from './model-routing.js'

/** Default model — Kimi K2.6. Cheap, fast, and on Moonshot rate-limit
 *  budget separate from Anthropic / Z.AI so a Claude rate-limit hit
 *  doesn't kill an eval campaign mid-run. */
const DEFAULT_MODEL: LlmModel = 'kimi-k2'

/** An OpenAI-compatible endpoint: a `model-routing.ts` entry, or an explicit
 *  one (e.g. the Tangle Router) for a model outside that table. */
export interface LlmEndpoint {
  baseUrl: string
  apiKey: string
  modelId: string
  /** Provider identity Runtime records for the profile, e.g. `tangle-router`. */
  provider: string
}

function routedEndpoint(model: LlmModel): LlmEndpoint {
  const { baseUrl, apiKey, modelId, executionIdentity } = resolveModel(model)
  return { baseUrl, apiKey: apiKey(), modelId, provider: executionIdentity.split('/')[0] ?? model }
}

/** The exact profile one Runtime chat client executes; requests must match it. */
export interface LlmChatOptions {
  model?: LlmModel
  endpoint?: LlmEndpoint
  system?: string
  temperature?: number
  maxOutputTokens?: number
}

/** Build the Runtime-backed chat client for a routed model or an explicit endpoint. */
export function llmChatClient(opts: LlmChatOptions = {}): ChatClient {
  const cfg = opts.endpoint ?? routedEndpoint(opts.model ?? DEFAULT_MODEL)
  return profileChatClient({
    profile: {
      name: 'eval-llm-call',
      harness: 'cli-base',
      model: {
        provider: cfg.provider,
        default: cfg.modelId,
        ...(opts.maxOutputTokens !== undefined ? { maxVisibleOutputTokens: opts.maxOutputTokens } : {}),
        ...(opts.temperature !== undefined ? { metadata: { temperature: opts.temperature } } : {}),
      },
      ...(opts.system ? { prompt: { systemPrompt: opts.system } } : {}),
    },
    executor: { backend: 'router', routerBaseUrl: cfg.baseUrl, routerKey: cfg.apiKey },
    context: 'evals llm-call',
  })
}

/** Chat client for agent-eval's trace-analysis engine (tool-carrying turns). */
export function traceAnalystChatClient(model: LlmModel): ChatClient {
  const { baseUrl, apiKey, modelId } = routedEndpoint(model)
  return createChatClient({ transport: 'openai-compatible', baseUrl, apiKey, defaultModel: modelId })
}

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

/** Provider-reported token + cost usage. Zeros when the provider reported no
 *  usage (which downstream backend-integrity guards correctly read as a stub
 *  fingerprint). */
export interface LlmUsage {
  input: number
  output: number
  costUsd: number
}

export interface LlmCallUsageResult extends LlmCallResult {
  usage: LlmUsage
}

/** Core LLM call. Async — returns a promise. */
export async function llmCall(opts: LlmCallOptions): Promise<LlmCallResult> {
  const { usage: _usage, ...result } = await llmCallWithUsage(opts)
  return result
}

/** Core LLM call that ALSO reports provider-reported token + cost usage. Use
 *  this when a caller must thread real usage into a `RunRecord` /
 *  `ctx.cost.observeTokens` (the backend-integrity guard keys on nonzero token
 *  usage). */
export async function llmCallWithUsage(opts: LlmCallOptions): Promise<LlmCallUsageResult> {
  const usage: LlmUsage = { input: 0, output: 0, costUsd: 0 }
  try {
    const res = await llmChatClient(opts.model ? { model: opts.model } : {}).chat({
      messages: [{ role: 'user', content: opts.prompt }],
      timeoutMs: opts.timeoutMs ?? 180_000,
    })
    usage.input = res.usage.promptTokens
    usage.output = res.usage.completionTokens
    usage.costUsd = res.costUsd ?? 0
    const output = res.content.trim()
    return { output, exitCode: 0, stderr: '', ok: output.length > 0, usage }
  } catch (e) {
    return { output: '', exitCode: 1, stderr: (e as Error).message, ok: false, usage }
  }
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
