/**
 * Per-run `AgentProfileCell` builder for trading-blueprint evals — mirrors
 * `creative-agent/eval/agent-profile-cell.ts`.
 *
 * Each (bot, harness, seed) row in a campaign carries an `AgentProfileCell`.
 * The cell is the agent-eval's unit of variation: it identifies WHICH
 * profile + harness + persona-suite was exercised, so `recordRunsToScorecard`
 * can key results by `(scenarioId, profileHash)` and `diffScorecard` can
 * answer "did this change regress any bot on the same profile?".
 *
 * The PROFILE half of the identity (model, venues, fee schedule version) is
 * stable across a campaign and lives in
 * `buildTradingScorecardAgentProfile`. This cell extends that with the
 * RUN-LEVEL identity (harness version, prompt hash, backend, persona suite,
 * reasoning level) — anything that varies per cell.
 */

import {
  type AgentProfileCell,
  type AgentProfileJson,
  buildAgentProfileCell,
} from '@tangle-network/agent-eval'

export interface BuildTradingAgentProfileCellInput {
  /** Trading-runtime semver — same as in the scorecard profile. */
  runtimeVersion: string
  /** HarnessConfig surface schema version. */
  harnessVersion: number
  /** Model id — deterministic engine label by default; swap when the
   *  dispatch becomes LLM-driven. */
  model?: string
  /** SHA-256 over the serialised HarnessConfig (the prompt-equivalent). */
  promptHash: string
  /** Persona suite — `"trading-bots"` for the harness loop, `"trading-personas"` for the persona eval, etc. */
  personaSuite: string
  /** Backend label — the candle-source venue id (`"hyperliquid"`, `"binance"`, …) or `"deterministic-runtime"`. */
  backend: string
  /** Optional reasoning level — `"none"` for deterministic, `"low"|"medium"|"high"` for LLM-driven. */
  reasoningLevel?: string
  /** Optional name — defaults to `"ai-trading-blueprint"`. */
  profileName?: string
  /** Optional sandbox-agent-profile-style serialisation — when this dispatch
   *  is run through `agent-runtime`'s `runChatThroughRuntime` path, the
   *  caller passes the full agent profile here. For deterministic dispatch
   *  (the Rust harness_backtest CLI) we pass a minimal stand-in. */
  sourceProfile?: AgentProfileJson
}

export async function buildTradingAgentProfileCell(
  input: BuildTradingAgentProfileCellInput,
): Promise<AgentProfileCell> {
  const profileName = input.profileName ?? 'ai-trading-blueprint'
  const sourceProfile: AgentProfileJson =
    input.sourceProfile ??
    ({
      name: profileName,
      version: `harness-v${input.harnessVersion}/runtime-v${input.runtimeVersion}`,
      metadata: {
        kind: 'deterministic-trading-runtime',
        runtimeVersion: input.runtimeVersion,
        harnessVersion: input.harnessVersion,
      },
    } as unknown as AgentProfileJson)
  return await buildAgentProfileCell({
    profileId: `${profileName}@harness-v${input.harnessVersion}/${input.runtimeVersion}`,
    sourceProfile: {
      kind: 'sandbox-agent-profile',
      profile: sourceProfile,
    },
    harness: {
      id: 'ai-trading-blueprint-eval',
      version: `harness-v${input.harnessVersion}/runtime-v${input.runtimeVersion}`,
    },
    model: input.model ?? `trading-runtime@${input.runtimeVersion}`,
    promptHash: input.promptHash,
    dimensions: {
      backend: input.backend,
      personaSuite: input.personaSuite,
      ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
    },
  })
}
