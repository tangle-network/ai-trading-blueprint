const TEMPLATE_ID = 'template-market-maker';

function midPrice(bid, ask) {
  return (Number(bid) + Number(ask)) / 2;
}

function decideMarketMaker(input = {}) {
  const bid = Number(input.bid);
  const ask = Number(input.ask);
  const inventory = Number(input.inventory || 0);
  const maxInventory = Number(input.maxInventory || 10);
  const minSpreadBps = Number(input.minSpreadBps || 30);
  const orderUsd = Number(input.orderUsd || 100);

  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) {
    return { action: 'skip', reason: 'invalid market quote' };
  }

  const mid = midPrice(bid, ask);
  const spreadBps = ((ask - bid) / mid) * 10_000;
  if (spreadBps < minSpreadBps) {
    return { action: 'skip', reason: 'spread too tight', spread_bps: spreadBps };
  }

  const side = inventory > maxInventory * 0.5 ? 'sell' : 'buy';
  const quotePrice = side === 'buy' ? bid * 1.001 : ask * 0.999;
  return {
    action: 'quote',
    side,
    quote_price: quotePrice,
    mid_price: mid,
    spread_bps: spreadBps,
    order_usd: orderUsd,
    inventory_skew: inventory / maxInventory,
  };
}

async function tick(ctx) {
  const config = ctx.config.strategy_config || {};
  const fixture = config.template_fixture || {
    bid: 0.48,
    ask: 0.52,
    inventory: 0,
    maxInventory: 10,
    minSpreadBps: 50,
    orderUsd: 100,
  };
  const decision = decideMarketMaker(fixture);
  ctx.writeArtifact('market-maker', decision);
  if (decision.action !== 'quote') return ctx.skip(decision.reason, decision);
  return ctx.skip('paper quote generated; venue adapter required before submitting live order', decision);
}

module.exports = {
  id: TEMPLATE_ID,
  kind: 'market_maker',
  decideMarketMaker,
  tick,
};
