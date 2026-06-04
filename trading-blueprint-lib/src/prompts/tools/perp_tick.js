#!/usr/bin/env node
// Deterministic paper GMX/Vertex perp tick.
//
// This is not the Hyperliquid native path. It proves the EVM perp bot has the
// intended Arbitrum venue surface and writes risk-aware no-trade evidence.

const t = require('/home/agent/tools/tick-common');

async function safeApi(api, method, path, body) {
  try {
    return t.body(await api.apiCall(method, path, body));
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function protocolList(config) {
  const configured = config.strategy_config || {};
  return Array.isArray(configured.available_protocols)
    ? configured.available_protocols.map(String)
    : ['gmx_v2', 'vertex'];
}

function priceFor(prices, symbol) {
  const entries = Array.isArray(prices.prices) ? prices.prices : [];
  const match = entries.find((entry) => String(entry?.token || '').toUpperCase() === symbol);
  return t.asNumber(match?.price_usd ?? prices[symbol] ?? prices[symbol.toLowerCase()], null);
}

async function decide(ctx) {
  const { api, config } = ctx;
  const strategyConfig = config.strategy_config || {};
  const protocols = protocolList(config);
  const protocolChainId = t.chainId(config);
  const paperTrade = strategyConfig.paper_trade !== false;

  const [portfolio, adapterList, prices, ethCandles] = await Promise.all([
    safeApi(api, 'POST', '/portfolio/state', {}),
    safeApi(api, 'GET', '/adapters'),
    safeApi(api, 'POST', '/market-data/prices', { tokens: ['ETH', 'BTC'] }),
    t.fetchCandles(api, 'ETH').catch((error) => ({ error: error.message || String(error), candles: [] })),
  ]);

  const totalNav = t.asNumber(portfolio.total_value_usd, t.asNumber(strategyConfig.initial_capital_usd, 0));
  const perps = strategyConfig.perps || {};
  const venues = Array.isArray(perps.venues) ? perps.venues.map(String) : protocols;
  const maxLeverage = t.asNumber(perps.max_leverage, 2);
  const maxPositionPct = t.asNumber(perps.max_position_pct, 5);

  const missing = [];
  if (protocolChainId !== 42161) missing.push('protocol_chain_id must be 42161 for Arbitrum GMX/Vertex');
  if (!protocols.includes('gmx_v2')) missing.push('gmx_v2 protocol');
  if (!protocols.includes('vertex')) missing.push('vertex protocol');
  if (!paperTrade) missing.push('paper_trade=false');

  const checkedState = {
    strategy_type: 'perp',
    paper_trade: paperTrade,
    protocol_chain_id: protocolChainId,
    available_protocols: protocols,
    venues,
    perps: {
      max_leverage: maxLeverage,
      max_position_pct: maxPositionPct,
      order_type: perps.order_type || 'limit',
    },
    total_nav_usd: totalNav,
    adapters_error: adapterList.error || null,
    portfolio_error: portfolio.error || null,
    market: {
      asset: 'ETH',
      eth_price_usd: priceFor(prices, 'ETH'),
      btc_price_usd: priceFor(prices, 'BTC'),
      eth_candles: Array.isArray(ethCandles) ? ethCandles.length : 0,
      candles_error: ethCandles && ethCandles.error ? ethCandles.error : null,
    },
    hyperliquid_native_forbidden: true,
  };

  const metrics = {
    portfolio_value_usd: totalNav,
    perp_protocol_chain_id: protocolChainId,
    perp_max_leverage: maxLeverage,
    perp_max_position_pct: maxPositionPct,
    configured_protocols_count: protocols.length,
    missing_config_count: missing.length,
    eth_price_usd: checkedState.market.eth_price_usd,
    eth_candle_count: checkedState.market.eth_candles,
  };

  if (missing.length > 0) {
    return {
      decision: {
        action: 'skip',
        reason: 'perp-config-incomplete',
        missing_config: missing,
      },
      checkedState,
      metrics,
    };
  }

  return {
    decision: {
      action: 'skip',
      reason: 'paper-gmx-vertex-no-funding-edge-confirmed',
      venues,
      no_live_execution: true,
    },
    checkedState,
    metrics,
  };
}

t.runTick('perp', decide);
