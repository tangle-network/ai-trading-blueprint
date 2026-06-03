#!/usr/bin/env node
// Deterministic paper volatility tick.
//
// Produces the same schema-v1 artifact contract as the DEX/Yield/Multi ticks,
// but stays read-only: volatility bots are research/paper-only until a promoted
// strategy has explicit execution authorization.

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
    : ['polymarket_clob', 'uniswap_v3', 'gmx_v2', 'hyperliquid', 'vertex', 'coingecko'];
}

async function decide(ctx) {
  const { api, config } = ctx;
  const strategyConfig = config.strategy_config || {};
  const params = strategyConfig.volatility_params || {};
  const protocols = protocolList(config);
  const paperTrade = strategyConfig.paper_trade !== false;

  const [portfolio, prices, hyperliquidAccount] = await Promise.all([
    safeApi(api, 'POST', '/portfolio/state', {}),
    safeApi(api, 'POST', '/market-data/prices', { tokens: ['ETH', 'BTC'] }),
    protocols.includes('hyperliquid')
      ? safeApi(api, 'GET', '/hyperliquid/account')
      : Promise.resolve({ skipped: 'hyperliquid-not-configured' }),
  ]);

  const totalNav = t.asNumber(portfolio.total_value_usd, t.asNumber(strategyConfig.initial_capital_usd, 0));
  const realizedWindowHours = t.asNumber(params.realized_window_hours, 24);
  const deltaHedgeThresholdPct = t.asNumber(params.delta_hedge_threshold_pct, 5);
  const maxLossPct = t.asNumber(params.max_loss_pct, 3);

  const checkedState = {
    strategy_type: 'volatility',
    paper_trade: paperTrade,
    available_protocols: protocols,
    volatility_params: {
      realized_window_hours: realizedWindowHours,
      delta_hedge_threshold_pct: deltaHedgeThresholdPct,
      max_loss_pct: maxLossPct,
      implied_proxy_sources: params.implied_proxy_sources || [],
    },
    evidence_paths: strategyConfig.decision_evidence || null,
    total_nav_usd: totalNav,
    portfolio_error: portfolio.error || null,
    prices_error: prices.error || null,
    hyperliquid_account_error: hyperliquidAccount.error || null,
  };

  const missing = [];
  if (!paperTrade) missing.push('paper_trade=false');
  if (!strategyConfig.volatility_params) missing.push('volatility_params');
  if (!strategyConfig.decision_evidence) missing.push('decision_evidence');
  if (!protocols.includes('vertex')) missing.push('vertex protocol');
  if (!protocols.includes('gmx_v2')) missing.push('gmx_v2 protocol');
  if (!protocols.includes('polymarket_clob')) missing.push('polymarket_clob protocol');

  const metrics = {
    portfolio_value_usd: totalNav,
    volatility_realized_window_hours: realizedWindowHours,
    volatility_delta_hedge_threshold_pct: deltaHedgeThresholdPct,
    volatility_max_loss_pct: maxLossPct,
    configured_protocols_count: protocols.length,
    missing_config_count: missing.length,
  };

  if (missing.length > 0) {
    return {
      decision: {
        action: 'skip',
        reason: 'volatility-config-incomplete',
        missing_config: missing,
      },
      checkedState,
      metrics,
    };
  }

  return {
    decision: {
      action: 'skip',
      reason: 'paper-volatility-research-only',
      no_live_execution: true,
      next_research: 'compare realized volatility, funding proxies, CLOB spreads, and delta exposure',
    },
    checkedState,
    metrics,
  };
}

t.runTick('volatility', decide);
