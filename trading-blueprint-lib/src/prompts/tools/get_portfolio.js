#!/usr/bin/env node
// Portfolio viewer — shows current positions, P&L, and state in compact format.
// Calls Trading HTTP API and merges with local decision log.
// Usage: node get-portfolio.js

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

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
  const output = {
    portfolio: portfolio || { positions: [], note: 'No portfolio data from API (paper trade mode)' },
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
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
