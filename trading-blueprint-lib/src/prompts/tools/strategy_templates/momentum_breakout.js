const TEMPLATE_ID = 'template-momentum-breakout';

function pctChange(from, to) {
  return (Number(to) - Number(from)) / Number(from);
}

function decideMomentum(input = {}) {
  const closes = Array.isArray(input.closes) ? input.closes.map(Number) : [];
  const thresholdPct = Number(input.thresholdPct || 0.015);
  const maxChasePct = Number(input.maxChasePct || 0.08);
  const amountIn = String(input.amountIn || '500000000');
  if (closes.length < 4 || closes.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { action: 'skip', reason: 'insufficient clean price history' };
  }

  const lookback = closes[closes.length - 4];
  const latest = closes[closes.length - 1];
  const move = pctChange(lookback, latest);
  const oneBar = pctChange(closes[closes.length - 2], latest);
  if (move < thresholdPct) return { action: 'skip', reason: 'momentum below threshold', move };
  if (oneBar > maxChasePct) return { action: 'skip', reason: 'move too extended to chase', move, one_bar: oneBar };

  return {
    action: 'trade',
    thesis: 'positive momentum breakout',
    token_in: input.tokenIn || 'USDC',
    token_out: input.tokenOut || 'WETH',
    amount_in: amountIn,
    confidence: Math.min(0.9, 0.5 + move * 8),
    move,
  };
}

async function tick(ctx) {
  const config = ctx.config.strategy_config || {};
  const decision = decideMomentum(config.template_fixture || {
    closes: [100, 101, 102, 104],
    tokenIn: 'USDC',
    tokenOut: 'WETH',
    amountIn: '500000000',
  });
  ctx.writeArtifact('momentum', decision);
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
  kind: 'momentum',
  decideMomentum,
  tick,
};
