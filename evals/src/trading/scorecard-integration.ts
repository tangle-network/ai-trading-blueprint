/**
 * Scorecard wiring for trading-blueprint — mirrors
 * `creative-agent/eval/scorecard-integration.ts`.
 *
 * Bridges any benchmark's `RunRecord[]` into the agent-eval 0.34+
 * `(scenarioId × profileHash)` scorecard timeline. `recordRunsToScorecard`
 * folds runs into per-cell lines; `loadScorecard` + `diffScorecard` answer
 * "did this commit regress any persona / bot on the same profile?" — the
 * question a single run's pass/fail ship-gate cannot. Per-cell verdicts
 * use Cohen's d + Welch's t-test, the keystone CI guard.
 *
 * The regression diff is informational by default. Wire it as a CI hard
 * gate by passing `failOnRegression: true` (or `EVAL_FAIL_ON_REGRESSION=1`
 * in the CLI bin).
 */

import {
  type AgentProfile,
  type RunRecord,
  type ScorecardDiff,
  agentProfileHash,
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRunsToScorecard,
} from '@tangle-network/agent-eval'

/**
 * Derive the eval-harness `AgentProfile` that keys this run's scorecard
 * lines. Behaviour-bearing fields only: the strategy surface (`HarnessConfig`
 * version), the candle-source venues in play, the calibrated fee schedules,
 * the runtime model id (the Rust BacktestEngine identifier). The
 * harness/backend/personaSuite identity already lives in each per-run
 * `AgentProfileCell` (`buildTradingAgentProfileCell`); this profile is the
 * scorecard's BEHAVIOUR key and stays stable as long as the engine + the
 * surface schema versions don't move.
 */
export function buildTradingScorecardAgentProfile(input: {
  /** HarnessConfig schema major version (`HarnessConfig.version` field). */
  surfaceVersion: number
  /** Trading-runtime semver (matches the Cargo.toml of the engine). */
  runtimeVersion: string
  /** Venues this run could route through. Sorted before hash. */
  venues: readonly string[]
  /** Calibrated taker fee schedule version id (`protocol_fees::SCHEDULES`). */
  feeScheduleVersion: string
  /** Optional: human label for the model field — defaults to the deterministic
   *  backtest engine. Swap in an LLM model id when the dispatch becomes
   *  LLM-driven. */
  model?: string
}): AgentProfile {
  const surfaceId = `harness-v${input.surfaceVersion}/${input.runtimeVersion}/${input.feeScheduleVersion}`
  const venues = [...input.venues].sort()
  // `name` is a label and is NOT hash-bearing under agent-interface 0.10.x.
  // The behaviour identity that used to live in the old `id` / `promptVersion`
  // / `skills` / `tools` fields now rides the hash-bearing fields `version`,
  // `prompt`, `resources.skills`, and `tools` so the scorecard keys stably per
  // surface / fee / venue revision.
  return {
    name: `ai-trading-blueprint@${surfaceId}`,
    version: surfaceId,
    model: { default: input.model ?? `trading-runtime@${input.runtimeVersion}` },
    prompt: {
      instructions: [`harness-config/v${input.surfaceVersion}/fees/${input.feeScheduleVersion}`],
    },
    resources: {
      skills: venues.map((venue) => ({ kind: 'inline', name: venue, content: venue })),
    },
    tools: Object.fromEntries(venues.map((venue) => [venue, true])),
    metadata: {
      profileName: 'ai-trading-blueprint',
      surfaceVersion: input.surfaceVersion,
      runtimeVersion: input.runtimeVersion,
      feeScheduleVersion: input.feeScheduleVersion,
    },
  }
}

export interface ScorecardWiringInput {
  scorecardPath: string
  runs: RunRecord[]
  profile: AgentProfile
  commitSha: string
  /** Defaults to `new Date().toISOString()`. */
  timestamp?: string
}

export interface ScorecardWiringResult {
  /** Number of cell entries appended to the log this run (one per scenario). */
  appendedCells: number
  /** Profile hash this run keyed into. */
  profileHash: string
  /** Diff of the latest entries against their predecessors. */
  diff: ScorecardDiff
  /** Human-readable diff block — what a PR / CI run prints. */
  formatted: string
  /** True when any cell's verdict is `regressed`. */
  regressed: boolean
}

/**
 * Append the run to the scorecard, fold the log, diff, and surface a
 * regression flag. Pure I/O over the JSONL log — no LLM calls.
 *
 * Concurrent eval campaigns are safe: appends are line-atomic and
 * `loadScorecard` skips malformed lines rather than failing closed.
 */
export function recordScorecardAndDiff(input: ScorecardWiringInput): ScorecardWiringResult {
  const lines = recordRunsToScorecard(input.scorecardPath, input.runs, {
    profile: input.profile,
    commitSha: input.commitSha,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  })
  const scorecard = loadScorecard(input.scorecardPath)
  const diff = diffScorecard(scorecard)
  const regressed = diff.cells.some((c) => c.verdict === 'regressed')
  return {
    appendedCells: lines.length,
    profileHash: agentProfileHash(input.profile),
    diff,
    formatted: formatScorecardDiff(diff),
    regressed,
  }
}
