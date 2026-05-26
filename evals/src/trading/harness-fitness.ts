/**
 * Composite fitness over a `BacktestArtifact` — the production promotion
 * gate, single source of truth for both the developer and per-bot loops.
 *
 *   score = 1.0 * Sharpe-CI-low
 *         + 0.5 * OOS Sharpe
 *         − 0.1 * max drawdown %
 *         − 0.4 * max(0, IS−OOS gap)        // overfit penalty
 *         + 0.05 * min(trades, 30) / 30     // trade-count bonus
 *
 *   floor = −10 when n_trades < 5  (never promote a no-trade variant)
 *
 * The `JudgeConfig` plugs straight into `runCampaign` / `runImprovementLoop`.
 */

import type { JudgeConfig } from '@tangle-network/agent-eval/campaign'
import type { Scenario } from '@tangle-network/agent-eval/campaign'
import type { BacktestArtifact } from './harness-types.js'

export interface HarnessFitness {
  composite: number
  dimensions: Record<string, number>
  notes: string
}

const MIN_TRADES_FOR_FITNESS = 5
const TRADE_BONUS_SATURATION = 30

const W_SHARPE = 1.0
const W_OOS = 0.5
const W_DRAWDOWN = 0.1
const W_OVERFIT = 0.4
const W_TRADES = 0.05

export function harnessFitness(artifact: BacktestArtifact): HarnessFitness {
  if (artifact.n_trades < MIN_TRADES_FOR_FITNESS) {
    return {
      composite: -10,
      dimensions: { n_trades: artifact.n_trades },
      notes: `insufficient_trades(${artifact.n_trades}<${MIN_TRADES_FOR_FITNESS})`,
    }
  }
  const ciLow = Number.isFinite(artifact.sharpe_ci_lo)
    ? (artifact.sharpe_ci_lo ?? artifact.sharpe)
    : artifact.sharpe
  const overfitPenalty = Math.max(0, artifact.is_oos_gap)
  const tradeBonus = Math.min(artifact.n_trades, TRADE_BONUS_SATURATION) / TRADE_BONUS_SATURATION
  const composite =
    W_SHARPE * ciLow +
    W_OOS * artifact.oos_sharpe_70_30 -
    W_DRAWDOWN * artifact.max_drawdown_pct -
    W_OVERFIT * overfitPenalty +
    W_TRADES * tradeBonus
  return {
    composite,
    dimensions: {
      sharpe: artifact.sharpe,
      sharpe_ci_lo: ciLow,
      oos_sharpe: artifact.oos_sharpe_70_30,
      max_drawdown_pct: artifact.max_drawdown_pct,
      is_oos_gap: artifact.is_oos_gap,
      n_trades: artifact.n_trades,
      win_rate_pct: artifact.win_rate_pct,
      total_return_pct: artifact.total_return_pct,
    },
    notes: `sharpe=${artifact.sharpe.toFixed(2)} oos=${artifact.oos_sharpe_70_30.toFixed(2)} dd=${artifact.max_drawdown_pct.toFixed(1)}% trades=${artifact.n_trades}`,
  }
}

/** Pluggable `JudgeConfig` over a `BacktestArtifact`. The Scenario shape
 *  is generic so the same judge serves both the developer multi-bot
 *  matrix and the per-bot single-bot loop. */
export function harnessJudge<TScenario extends Scenario>(): JudgeConfig<BacktestArtifact, TScenario> {
  return {
    name: 'harness-composite',
    dimensions: [
      { key: 'sharpe', description: 'main Sharpe ratio (trade-scale)' },
      { key: 'sharpe_ci_lo', description: 'bootstrap 95% CI lower bound on Sharpe' },
      { key: 'oos_sharpe', description: 'out-of-sample Sharpe on the 30% holdout window' },
      { key: 'max_drawdown_pct', description: 'maximum realised drawdown %' },
      { key: 'is_oos_gap', description: 'IS Sharpe minus OOS Sharpe — overfit signal' },
      { key: 'n_trades', description: 'number of trades closed' },
      { key: 'win_rate_pct', description: 'percentage of winning trades' },
      { key: 'total_return_pct', description: 'realised total return %' },
    ],
    async score({ artifact }: { artifact: BacktestArtifact }) {
      return harnessFitness(artifact)
    },
  }
}
