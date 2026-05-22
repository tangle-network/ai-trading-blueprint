import { zeroAddress } from "viem";
import type { Bot } from "~/lib/types/bot";
import type { RevisionArena } from "~/lib/hooks/useBotApi";

export const DEMO_BOT_ID = "demo-paper-agent";

export function demoArenaEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_ARENA_DEMO_MODE === "1";
}

export const demoPaperBot: Bot = {
  id: DEMO_BOT_ID,
  serviceId: 0,
  name: "Paper Strategy Research Agent",
  operatorAddress: "0x000000000000000000000000000000000000dEaD",
  vaultAddress: zeroAddress,
  strategyType: "prediction",
  status: "active",
  createdAt: Date.now() - 6 * 60 * 60 * 1000,
  chainId: 84532,
  pnlPercent: 2.4,
  pnlAbsolute: 240,
  sharpeRatio: 1.3,
  maxDrawdown: 1.8,
  winRate: 58,
  totalTrades: 42,
  tvl: 10_000,
  avgValidatorScore: 91,
  sparklineData: [100, 100.3, 99.8, 100.9, 101.1, 100.7, 101.9, 102.4],
  sandboxId: "demo-sandbox-paper-agent",
  sandboxState: "running",
  lifecycleStatus: "active",
  archived: false,
  controlAvailable: true,
  tradingActive: true,
  secretsConfigured: true,
  paperTrade: true,
  strategyConfig: {
    mode: "paper",
    venue: "polymarket",
    objective: "bounded market-making research",
  },
  riskParams: {
    max_drawdown_pct: 3,
    max_position_fraction: 0.08,
    live_trading: false,
  },
  source: "demo",
  verificationState: "authoritative",
  operatorKind: null,
  operatorApiUrl: null,
  lastVerifiedAt: Date.now(),
  isUnverified: false,
  validationTrust: "envelope",
};

export const demoRevisionArena: RevisionArena = {
  bot_id: DEMO_BOT_ID,
  invariant:
    "Demo paper agent: candidates must pass backtest, paper/shadow, and validator checks before live execution can be enabled.",
  active_revision_id: "rev-0",
  live_revision_id: null,
  revisions: [
    {
      revision_id: "rev-0",
      display_name: "Revision 0",
      source: "baseline",
      status: "active",
      run_mode: "paper",
      can_execute_live: false,
      parent_revision_id: null,
      run_id: "demo-run-baseline",
      created_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      user_intent: "Initial paper-only market-making strategy with strict drawdown and position limits.",
      patch_sha256: "sha256:demo-baseline",
      files_changed: ["config/harness.json"],
      tests: ["walk-forward backtest", "paper trading guard"],
      promotion_approved: true,
      promotion_blockers: [],
      paper_evidence: {
        trades: 42,
        total_return_pct: 2.4,
        max_drawdown_pct: 1.8,
        candidate_hash: "demo-baseline",
        revision_id: "rev-0",
      },
    },
    {
      revision_id: "rev-1",
      display_name: "Revision 1",
      source: "self_improvement_candidate",
      status: "blocked",
      run_mode: "research",
      can_execute_live: false,
      parent_revision_id: "rev-0",
      run_id: "demo-run-candidate",
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      user_intent:
        "User asked for a more aggressive strategy; agent proposed tighter microstructure filters before any live promotion.",
      patch_sha256: "sha256:demo-candidate",
      files_changed: ["strategies/polymarket_mm.ts", "evals/risk_limits.json"],
      tests: ["held-out backtest", "paper shadow comparison", "validator safety review"],
      promotion_approved: false,
      promotion_blockers: [
        "Requires at least 100 paper trades before live promotion.",
        "Live execution remains blocked until validator envelope checks pass.",
        "Guaranteed profitability claims are rejected by policy.",
      ],
      paper_evidence: {
        trades: 12,
        total_return_pct: 0.6,
        max_drawdown_pct: 2.1,
        candidate_hash: "demo-candidate",
        revision_id: "rev-1",
      },
    },
  ],
  modes: [
    {
      mode: "paper",
      can_touch_funds: false,
      description: "Paper mode can research, backtest, and shadow trade without fund access.",
    },
    {
      mode: "shadow",
      can_touch_funds: false,
      description: "Shadow mode compares candidate decisions against the active strategy.",
    },
    {
      mode: "live",
      can_touch_funds: true,
      description: "Live mode requires explicit promotion evidence and validator authorization.",
    },
  ],
};
