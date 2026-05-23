const TEMPLATE_ID = 'template-risk-off-guard';

function decideRiskOff(input = {}) {
  const drawdownPct = Number(input.drawdownPct || 0);
  const volatilityPct = Number(input.volatilityPct || 0);
  const lossStreak = Number(input.lossStreak || 0);
  const maxDrawdownPct = Number(input.maxDrawdownPct || 5);
  const maxVolatilityPct = Number(input.maxVolatilityPct || 8);
  const maxLossStreak = Number(input.maxLossStreak || 3);

  const reasons = [];
  if (drawdownPct >= maxDrawdownPct) reasons.push('drawdown limit breached');
  if (volatilityPct >= maxVolatilityPct) reasons.push('volatility too high');
  if (lossStreak >= maxLossStreak) reasons.push('loss streak cooldown');

  if (reasons.length === 0) {
    return { action: 'allow', reason: 'risk within limits', drawdownPct, volatilityPct, lossStreak };
  }
  return {
    action: 'risk_off',
    reason: reasons.join('; '),
    reduce_exposure_pct: Math.min(1, 0.25 + reasons.length * 0.25),
    cooldown_ticks: Math.max(2, lossStreak),
    drawdownPct,
    volatilityPct,
    lossStreak,
  };
}

async function tick(ctx) {
  const config = ctx.config.strategy_config || {};
  const decision = decideRiskOff(config.template_fixture || {
    drawdownPct: 6,
    volatilityPct: 4,
    lossStreak: 1,
  });
  ctx.writeArtifact('risk-off', decision);
  if (decision.action === 'allow') return ctx.skip('risk guard allows normal trading', decision);
  return ctx.skip(decision.reason, decision);
}

module.exports = {
  id: TEMPLATE_ID,
  kind: 'risk_off',
  decideRiskOff,
  tick,
};
