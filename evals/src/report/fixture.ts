/**
 * Synthetic-data fixtures for the S-tier report renderer.
 *
 * Generates plausible `BotReportData` so we can render a complete report
 * and visually inspect it before the real evals have produced data. NOT
 * a baseline — the numbers here are for visualisation only; never feed
 * them into any judge or aggregator.
 */

import type { BotReportData, MultishotShot, TurnView, WalkForwardArm } from './types.js'

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SAMPLE_TURNS: TurnView[] = [
  {
    turn: 0,
    user_message: 'Trade HYPE perp on Hyperliquid. $10k. Momentum-driven entries only. Max 5% drawdown — pull back if you breach.',
    bot_reply_arrived_ms: 37_400,
    bot_reply_text:
      "Got it. I'll set up a momentum strategy on HYPE perp with a 5% DD cap. Pulling current price action first to size my initial position appropriately.\n\nInitial harness: RSI<30 + EMA(12,26) cross, fixed-fraction 0.06, stop 4%, take-profit 8%. Submitting long 350 HYPE at $42.31, oid=89713.",
    signalled_done: false,
    bot_tool_calls: [
      { tool: 'GET /market-data/candles', args_summary: 'token=HYPE limit=720', result_summary: '720 hourly bars (30d), close $42.31', latency_ms: 412 },
      { tool: 'delegate.research', args_summary: '"HYPE current narrative and recent price action"', result_summary: '3 sources: HL blog, DefiLlama TVL, Twitter sentiment (mean recency 2.3d)', latency_ms: 8_220 },
      { tool: 'POST /hyperliquid/order', args_summary: 'asset=HYPE buy 350 type=limit @ 42.31', result_summary: 'ok, oid=89713 resting', latency_ms: 187 },
    ],
  },
  {
    turn: 1,
    user_message: "actually i want you to also keep an eye on funding rates. don't get caught long when funding flips deep negative",
    bot_reply_arrived_ms: 14_200,
    bot_reply_text:
      "Good call — adding a funding-rate gate. I'll close longs when funding goes below -0.02%/h for 3 consecutive hours, and skip new long entries while it's negative.\n\nCurrent funding: +0.008%/h (carry positive for longs). Setting up the monitor.",
    signalled_done: false,
    bot_tool_calls: [
      { tool: 'GET /hyperliquid/account', args_summary: '', result_summary: '1 open position: HYPE long 350 @ 42.31, unrealised +$12.45', latency_ms: 142 },
      { tool: 'POST /strategy/config', args_summary: 'add funding_filter min_rate=-0.0002 lookback=3', result_summary: 'ok, config v2 active', latency_ms: 89 },
    ],
  },
  {
    turn: 2,
    user_message: 'what happens if hype crashes 20% overnight?',
    bot_reply_arrived_ms: 11_800,
    bot_reply_text:
      "Running that scenario now. At current size (350 HYPE @ avg $42.31, notional ~$14,800), a -20% move would mean -$2,960 unrealised — that's 29.6% on $10k capital, which blows past your 5% DD cap by 6x.\n\nMy 4% stop-loss would trigger first, cutting the loss to ~$592 (5.9% of capital). Still above your cap by 0.9%.\n\nRecommendation: I should tighten the stop to 3.5% or reduce position size to 250 HYPE. Which do you prefer?",
    signalled_done: false,
    bot_tool_calls: [
      { tool: 'delegate.analyze', args_summary: '"stress test HYPE -20% in 4h scenario"', result_summary: 'analyst finding: current stop 4% breaches cap by 0.9%; recommends tighten to 3.5% or reduce size', latency_ms: 6_120 },
    ],
  },
  {
    turn: 3,
    user_message: 'tighten the stop',
    bot_reply_arrived_ms: 8_900,
    bot_reply_text:
      "Done — stop tightened to 3.5%. Strategy v3 active. Current open position carries the new stop: trigger at $40.83.\n\nI'll watch the funding gate and the new tighter stop. Will report end-of-day. [done]",
    signalled_done: true,
    bot_tool_calls: [
      { tool: 'POST /strategy/config', args_summary: 'exit_rules[0].pct: 4.0 → 3.5', result_summary: 'ok, config v3 active', latency_ms: 76 },
    ],
  },
]

function makeShot(rng: () => number, rep: number): MultishotShot {
  const composite = 0.55 + rng() * 0.25  // 0.55 .. 0.80
  const intent = 0.6 + rng() * 0.25
  const constraints = 0.78 + rng() * 0.18
  const traded = 0.55 + rng() * 0.30
  const productive = 0.55 + rng() * 0.25
  return {
    rep,
    composite,
    dimensions: {
      intent_fulfilled: intent,
      respected_constraints: constraints,
      actually_traded_or_committed: traded,
      productive_conversation: productive,
    },
    turns: SAMPLE_TURNS,
    ended_by: 'done',
    total_wall_ms: 78_000 + Math.round(rng() * 30_000),
  }
}

function makeWalkForwardArm(rng: () => number, candidateIdx: number, arm: 'frozen' | 'agent', days: number): WalkForwardArm {
  let equity = 1.0
  let peak = 1.0
  const days_pnl: WalkForwardArm['days_pnl'] = []
  for (let d = 0; d < days; d++) {
    const drift = arm === 'agent' ? 0.0015 : 0.001
    const noise = (rng() - 0.48) * 0.012
    equity *= 1 + drift + noise
    peak = Math.max(peak, equity)
    const dd = ((peak - equity) / peak) * 100
    days_pnl.push({ day: d, equity, dd_pct: dd, n_trades: Math.round(rng() * 3) })
  }
  const final_return = (equity - 1) * 100
  const max_dd = Math.max(...days_pnl.map((d) => d.dd_pct))
  const revisions =
    arm === 'agent'
      ? [
          { day: 7, reason: 'Entry threshold too high; lowering to allow single-rule entries', from_version: 1, to_version: 2 },
          { day: 14, reason: 'Stop loss widened from 4% to 5% — HYPE noise was kicking out winners', from_version: 2, to_version: 3 },
          { day: 21, reason: 'Added funding-rate filter after analyst flagged 2 funding-flip losses', from_version: 3, to_version: 4 },
        ]
      : []
  return {
    arm,
    candidate_idx: candidateIdx,
    initial_strategy_summary: `RSI<30 + EMA(12,26) cross, fixed-fraction 0.06, stop 4%, take-profit 8%`,
    final_return_pct: final_return,
    final_max_dd_pct: max_dd,
    total_trades: Math.round(days * 0.4),
    days_pnl,
    revisions,
  }
}

export function makeFixtureReport(): BotReportData {
  const rng = mulberry32(0xc0ffee)
  const numReps = 5
  const shots: MultishotShot[] = []
  for (let r = 0; r < numReps; r++) shots.push(makeShot(rng, r))
  const numCandidates = 3
  const days = 28
  const arms: WalkForwardArm[] = []
  for (let k = 0; k < numCandidates; k++) {
    arms.push(makeWalkForwardArm(rng, k, 'frozen', days))
    arms.push(makeWalkForwardArm(rng, k, 'agent', days))
  }
  return {
    bot_id: 'hl-hype-momentum-conservative',
    operator: 'drew',
    period_start_iso: '2026-05-01',
    period_end_iso: '2026-05-28',
    intent_text: 'Trade HYPE perp on Hyperliquid. $10k. Momentum-driven. Max 5% DD.',
    capital_usd: 10_000,
    dd_cap_pct: 5,
    s_tier_composite: 7.2,
    multishot: {
      reps: numReps,
      shots,
      baselineComparison: {
        null_bot_composite: 0.08,
        stall_bot_composite: 0.12,
        frontier_bot_composite: 0.84,
      },
    },
    walkForward: {
      days_simulated: days,
      num_candidates: numCandidates,
      arms,
    },
    research: {
      theses_evaluated: 3,
      mean_source_count: 3.0,
      mean_recency_hours: 55.2,
      source_diversity_score: 0.45,
      citation_resolution_rate: 0.72,
      depth_score: 5.8,
    },
    robustness: {
      pass_rate: 0.6,
      scenarios_tested: [
        { scenario_id: 'contradiction', description: 'User asks for X then immediately Y', graceful_handling: 1, bot_response_summary: 'Cancelled X order, switched to Y without complaint, asked for confirmation' },
        { scenario_id: 'mid-session-crash', description: '-20% on underlying mid-conversation', graceful_handling: 1, bot_response_summary: 'Triggered stop, reported loss, refused to re-enter without re-research' },
        { scenario_id: 'ambiguous-intent', description: '"do something interesting"', graceful_handling: 0, bot_response_summary: 'Picked momentum on BTC without asking — should have requested clarification' },
        { scenario_id: 'dd-cap-pressure', description: 'User asks to "just YOLO 100% on next setup"', graceful_handling: 1, bot_response_summary: 'Refused, cited DD cap, offered to discuss raising the cap explicitly' },
        { scenario_id: 'research-quant-conflict', description: 'Research bullish, backtest bearish on same asset', graceful_handling: 0, bot_response_summary: 'Sided with backtest silently, did not flag the conflict to the user' },
      ],
    },
    cost: {
      llm_dollars_per_day: 1.42,
      tokens_per_shot_mean: 48_000,
      decision_latency_ms_p50: 3_800,
      decision_latency_ms_p95: 9_200,
      decision_latency_ms_p99: 14_100,
      dollars_per_insight: 0.30,
      tool_call_count_per_shot_mean: 11.4,
    },
  }
}
