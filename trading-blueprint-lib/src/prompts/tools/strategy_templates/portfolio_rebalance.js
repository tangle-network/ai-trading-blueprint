const TEMPLATE_ID = 'template-portfolio-rebalance';

function decideRebalance(input = {}) {
  const totalUsd = Number(input.totalUsd || 0);
  const weights = input.weights || {};
  const targetWeights = input.targetWeights || {};
  const thresholdPct = Number(input.thresholdPct || 0.05);
  const cashToken = input.cashToken || 'USDC';
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return { action: 'skip', reason: 'invalid portfolio value' };

  let largest = null;
  for (const [symbol, target] of Object.entries(targetWeights)) {
    const current = Number(weights[symbol] || 0);
    const drift = current - Number(target);
    if (!largest || Math.abs(drift) > Math.abs(largest.drift)) {
      largest = { symbol, current, target: Number(target), drift };
    }
  }
  if (!largest || Math.abs(largest.drift) < thresholdPct) {
    return { action: 'skip', reason: 'portfolio within rebalance threshold', largest };
  }

  const notionalUsd = Math.min(totalUsd * Math.abs(largest.drift), totalUsd * 0.1);
  return largest.drift < 0
    ? {
        action: 'trade',
        thesis: 'rebalance underweight asset',
        token_in: cashToken,
        token_out: largest.symbol,
        amount_usd: notionalUsd,
        drift: largest,
      }
    : {
        action: 'trade',
        thesis: 'rebalance overweight asset',
        token_in: largest.symbol,
        token_out: cashToken,
        amount_usd: notionalUsd,
        drift: largest,
      };
}

async function tick(ctx) {
  const config = ctx.config.strategy_config || {};
  const decision = decideRebalance(config.template_fixture || {
    totalUsd: 10_000,
    weights: { WETH: 0.35, USDC: 0.65 },
    targetWeights: { WETH: 0.5, USDC: 0.5 },
    cashToken: 'USDC',
  });
  ctx.writeArtifact('rebalance', decision);
  if (decision.action !== 'trade') return ctx.skip(decision.reason, decision);
  return ctx.skip('rebalance signal generated; convert USD size to base units before execution', decision);
}

module.exports = {
  id: TEMPLATE_ID,
  kind: 'portfolio_rebalance',
  decideRebalance,
  tick,
};
