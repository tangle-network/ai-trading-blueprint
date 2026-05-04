#!/usr/bin/env node
// Portfolio viewer — shows current positions, P&L, and state in compact format.
// Calls Trading HTTP API and merges with local decision log.
// Usage: node get-portfolio.js

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const api = require('./api-client');

const CONFIG_FILE = '/home/agent/config/api.json';
const LOG_FILE = '/home/agent/logs/decisions.jsonl';
const STATE_FILE = '/home/agent/state/trading-state.json';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { api_url: process.env.TRADING_API_URL || 'http://localhost:9100', token: '' }; }
}

function apiCall(config, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.api_url);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      method, hostname: url.hostname, port: url.port, path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.token,
      },
      timeout: 10000,
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function isVaultSpotPosition(position) {
  const protocol = String(position.protocol || '').trim().toLowerCase();
  const positionType = String(position.position_type || '').trim().toLowerCase();
  const amount = Number(position.amount || 0);
  return protocol === 'vault' && positionType === 'spot' && amount > 0;
}

function annotatePosition(position) {
  const tokenSymbol = api.knownTokenSymbol(position.token);
  const vaultSpot = isVaultSpotPosition(position);
  return {
    ...position,
    token_symbol: tokenSymbol,
    token_display: tokenSymbol ? `${tokenSymbol} (${position.token})` : position.token,
    ...(vaultSpot ? {
      available_for_vault_swap: true,
      execution_protocol: 'uniswap_v3',
      custody_note: 'protocol=vault means vault-held spot custody, not a locked protocol position',
    } : {}),
  };
}

async function main() {
  const config = loadConfig();

  // Get portfolio from API
  let portfolio = null;
  try {
    const r = await apiCall(config, 'POST', '/portfolio/state', {});
    if (r.status < 400) portfolio = r.body;
  } catch {}

  // Get recent decisions from log
  let recentDecisions = [];
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    recentDecisions = lines.slice(-5).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}

  // Get trading state
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  // Compact output
  const positions = ((portfolio && portfolio.positions) || []).map(annotatePosition);
  const vaultSpotBalances = positions
    .filter((position) => position.available_for_vault_swap)
    .map((position) => ({
      token: position.token,
      token_symbol: position.token_symbol,
      amount: position.amount,
      execution_protocol: position.execution_protocol,
    }));

  const output = {
    portfolio: portfolio
      ? { ...portfolio, positions }
      : { positions: [], note: 'No portfolio data from API (paper trade mode)' },
    vault_trading_note: vaultSpotBalances.length > 0
      ? 'Vault spot balances are available to the bot as token_in for vault-backed swaps; use target_protocol=uniswap_v3 and the Trading API validation/execution flow.'
      : undefined,
    vault_spot_balances: vaultSpotBalances,
    recent_trades: recentDecisions.map(d => ({
      action: d.action,
      condition_id: d.condition_id || d.trade?.condition_id,
      side: d.side || d.trade?.side,
      amount: d.amount_usd || d.trade?.amount,
      reason: d.reason,
      time: d.timestamp,
    })),
    state: {
      iteration: state.iteration || 0,
      last_scan: state.last_scan || 'never',
      watchlist_size: (state.watchlist || []).length,
      insights_count: (state.insights || []).length,
    },
    config: {
      chain_id: config.chain_id || null,
      asset_token: config.strategy_config?.asset_token || null,
      asset_token_symbol: api.knownTokenSymbol(config.strategy_config?.asset_token) || null,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
