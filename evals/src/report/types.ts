/**
 * The canonical data shape the S-tier per-bot weekly report consumes.
 *
 * Each eval populates one or more fields here:
 *   - multishot user-sim eval        → `multishot`
 *   - agent-in-loop walk-forward     → `walkForward`
 *   - research depth eval (eval #3)  → `research`
 *   - report quality eval (eval #4)  → `reportQuality`
 *   - robustness eval (eval #5)      → `robustness`
 *   - cost/efficiency eval (eval #6) → `cost`
 *   - fleet consistency eval (eval #7) → `consistency`
 *
 * The renderer in `render.ts` is forgiving — missing sections become "not
 * yet evaluated" stubs in the markdown rather than throwing. This lets us
 * ship the renderer ahead of all 7 evals being built.
 */

export interface BotReportData {
  // ── Metadata ───────────────────────────────────────────────────────
  bot_id: string
  operator: string
  period_start_iso: string
  period_end_iso: string
  intent_text: string
  capital_usd: number
  dd_cap_pct: number
  /** Composite score across all evals — surfaced in the exec summary. */
  s_tier_composite: number

  // ── Per-eval slices (any subset may be present) ────────────────────
  multishot?: MultishotEvalData
  walkForward?: WalkForwardEvalData
  research?: ResearchEvalData
  reportQuality?: ReportQualityEvalData
  robustness?: RobustnessEvalData
  cost?: CostEvalData
  consistency?: ConsistencyEvalData

  /** Work-product artifact rollup across all cells — self-improvement
   *  lineage, trades placed, PnL. Surfaces the "did the bot do the
   *  job" measurement alongside conversation judges (SPEC.md §1 — bot
   *  is supposed to self-improve, so we evaluate evidence of that). */
  artifacts?: BotArtifactsAggregate
}

// ─── Bot work-product artifacts (aggregate across cells) ────────────

export interface BotArtifactsAggregate {
  /** How many cells we inspected after the conversation ended. */
  cells_inspected: number
  /** Sum of self-improvement runs across all cells. */
  total_self_improvement_runs: number
  /** Sum of revisions promoted across all cells. */
  total_revisions_promoted: number
  /** Sum of revisions rejected by the gate across all cells. */
  total_revisions_rejected: number
  /** Mean Sharpe delta across promoted revisions where both before/after are known. */
  mean_sharpe_delta_on_promotion: number | null
  /** Total trades placed (paper + live) across cells. */
  total_trades: number
  /** Sum of realized PnL across cells (USD). */
  total_realized_pnl_usd: number
  /** Cells that placed at least one trade. */
  cells_with_trades: number
  /** Cells that fired ≥1 self-improvement cycle. */
  cells_with_self_improvement: number
  /** Top-5 flag counts across all cells (e.g., "no-trades-placed", "self-improvement-never-fired"). */
  top_flags: Array<{ flag: string; count: number }>
}

// ─── Eval #1: multishot user-sim ─────────────────────────────────────

export interface MultishotEvalData {
  reps: number
  shots: MultishotShot[]
  baselineComparison?: {
    null_bot_composite: number
    stall_bot_composite: number
    frontier_bot_composite: number
  }
}

export interface MultishotShot {
  rep: number
  composite: number
  dimensions: {
    intent_fulfilled: number
    respected_constraints: number
    actually_traded_or_committed: number
    productive_conversation: number
  }
  turns: TurnView[]
  ended_by: 'done' | 'max_turns' | 'wall_clock' | 'stall'
  total_wall_ms: number
}

export interface TurnView {
  turn: number
  user_message: string
  bot_reply_text: string
  bot_reply_arrived_ms: number
  signalled_done: boolean
  /** Tool calls the bot made between this user message and its reply, in order.
   *  Populated when the dispatch inspects the bot's sandbox trace. */
  bot_tool_calls?: BotToolCall[]
}

export interface BotToolCall {
  tool: string
  args_summary: string
  result_summary: string
  latency_ms: number
}

// ─── Eval #2: agent-in-loop walk-forward ─────────────────────────────

export interface WalkForwardEvalData {
  days_simulated: number
  num_candidates: number
  arms: WalkForwardArm[]
}

export interface WalkForwardArm {
  arm: 'frozen' | 'agent'
  candidate_idx: number
  initial_strategy_summary: string
  final_return_pct: number
  final_max_dd_pct: number
  total_trades: number
  /** Daily equity (multiplicative tracker, day 0 = 1.0) — used for the equity-curve chart. */
  days_pnl: Array<{ day: number; equity: number; dd_pct: number; n_trades: number }>
  revisions: Array<{ day: number; reason: string; from_version: number; to_version: number }>
}

// ─── Eval #3: research depth ─────────────────────────────────────────

export interface ResearchEvalData {
  theses_evaluated: number
  mean_source_count: number
  mean_recency_hours: number
  source_diversity_score: number
  citation_resolution_rate: number
  depth_score: number
}

// ─── Eval #4: report quality ─────────────────────────────────────────

export interface ReportQualityEvalData {
  sample_report_excerpt: string
  composite: number
  dimensions: {
    clarity: number
    accuracy: number
    actionable_outlook: number
    honest_uncertainty: number
  }
}

// ─── Eval #5: adversarial robustness ─────────────────────────────────

export interface RobustnessEvalData {
  scenarios_tested: RobustnessScenario[]
  pass_rate: number
}

export interface RobustnessScenario {
  scenario_id: string
  description: string
  graceful_handling: 0 | 1
  bot_response_summary: string
}

// ─── Eval #6: cost & efficiency ──────────────────────────────────────

export interface CostEvalData {
  llm_dollars_per_day: number
  tokens_per_shot_mean: number
  decision_latency_ms_p50: number
  decision_latency_ms_p95: number
  decision_latency_ms_p99: number
  dollars_per_insight: number
  tool_call_count_per_shot_mean: number
}

// ─── Eval #7: fleet consistency ──────────────────────────────────────

export interface ConsistencyEvalData {
  days_observed: number
  composite_per_day: number[]
  max_drift: number
  judge_agreement_pct: number
}
