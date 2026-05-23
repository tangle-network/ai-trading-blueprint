const TEMPLATE_ID = 'template-mean-reversion';

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function decideMeanReversion(input = {}) {
  const prices = Array.isArray(input.prices) ? input.prices.map(Number) : [];
  const zEntry = Number(input.zEntry || 1.25);
  const amountIn = String(input.amountIn || '300000000');
  if (prices.length < 8 || prices.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { action: 'skip', reason: 'insufficient clean price window' };
  }

  const latest = prices[prices.length - 1];
  const window = prices.slice(0, -1);
  const m = mean(window);
  const sd = stddev(window);
  if (sd === 0) return { action: 'skip', reason: 'flat market' };
  const z = (latest - m) / sd;
  if (Math.abs(z) < zEntry) return { action: 'skip', reason: 'z-score below entry', z };

  const direction = z < 0 ? 'buy_dip' : 'sell_rip';
  return {
    action: 'trade',
    thesis: `mean reversion ${direction}`,
    direction,
    z_score: z,
    mean: m,
    latest,
    token_in: z < 0 ? (input.cashToken || 'USDC') : (input.assetToken || 'WETH'),
    token_out: z < 0 ? (input.assetToken || 'WETH') : (input.cashToken || 'USDC'),
    amount_in: amountIn,
  };
}

async function tick(ctx) {
  const config = ctx.config.strategy_config || {};
  const decision = decideMeanReversion(config.template_fixture || {
    prices: [100, 101, 100.5, 99.8, 100.2, 101.1, 100.4, 97.8],
    assetToken: 'WETH',
    cashToken: 'USDC',
  });
  ctx.writeArtifact('mean-reversion', decision);
  if (decision.action !== 'trade') return ctx.skip(decision.reason, decision);
  return ctx.submitTrade({
    action: 'swap',
    token_in: decision.token_in,
    token_out: decision.token_out,
    amount_in: decision.amount_in,
    min_amount_out: '0',
    reason: decision.thesis,
  }, { dryRun: config.template_dry_run !== false });
}

module.exports = {
  id: TEMPLATE_ID,
  kind: 'mean_reversion',
  decideMeanReversion,
  tick,
};
