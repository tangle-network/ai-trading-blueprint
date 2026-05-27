/**
 * `llmCall()` — the SINGLE LLM-invocation helper every judge + user-sim
 * call goes through. Wraps `claude --print --model X` today; designed to
 * swap to agent-runtime's `createIterableBackend` + `runAgentTaskStream`
 * later without changing call sites.
 *
 * Why not `defineAgent` + `collectAgentRun` (agent-runtime/agent) today:
 *   - `defineAgent` requires AgentManifest with file-based system-prompt,
 *     tools, rubric, knowledge, personas. Overhead is ~4 files per
 *     judge × 5+ judges in the eval substrate = 20+ files for one-shot
 *     LLM calls. The runtime overhead earns its keep when (a) we want
 *     substrate-level trace capture per judge, (b) we want A/B the
 *     judge's system prompt via the surface mechanism, or (c) we want
 *     `measureOutcome` to score the judges themselves. None of those
 *     are today's bottleneck — duplication of the spawn invocation is.
 *
 * Migration path:
 *   When `ANTHROPIC_API_KEY` is configured AND we want judge-level trace
 *   capture, swap the spawnSync claude-print path for:
 *     const backend = createOpenAICompatibleBackend({
 *       apiKey: env.ANTHROPIC_API_KEY,
 *       baseUrl: 'https://api.anthropic.com/v1',
 *       model,
 *     })
 *     for await (const ev of runAgentTaskStream({ backend, task: {prompt} })) { ... }
 *   The signature of `llmCall()` stays identical — call sites don't move.
 */

import { spawnSync } from 'node:child_process'

export type LlmModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | string

export interface LlmCallOptions {
  prompt: string
  model?: LlmModel
  /** Max output buffer size; bumped from default 1MB to 8MB to handle
   *  research-bot artifacts that can run long. */
  maxBufferBytes?: number
}

export interface LlmCallResult {
  output: string
  exitCode: number
  stderr: string
  /** True when the LLM responded successfully; subscribe to this for
   *  judge-fallback paths. */
  ok: boolean
}

export function llmCall(opts: LlmCallOptions): LlmCallResult {
  const model = opts.model ?? 'claude-haiku-4-5'
  const proc = spawnSync('claude', ['--print', '--model', model, '--output-format', 'text'], {
    input: opts.prompt,
    encoding: 'utf8',
    maxBuffer: opts.maxBufferBytes ?? 8 * 1024 * 1024,
  })
  return {
    output: proc.stdout ?? '',
    exitCode: proc.status ?? -1,
    stderr: proc.stderr ?? '',
    ok: proc.status === 0,
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

/** Convenience: call LLM, extract a JSON object, return null on any failure.
 *  Judges use this to defer error handling to the call site instead of
 *  duplicating spawn-stderr + try-catch + slice-bounds-check in every
 *  judge function. */
export function llmCallJson<T>(opts: LlmCallOptions): { result: T | null; raw: LlmCallResult } {
  const raw = llmCall(opts)
  if (!raw.ok) return { result: null, raw }
  return { result: extractJson<T>(raw.output), raw }
}
