#!/usr/bin/env node
// Order management — checks fills on open CLOB orders, reports status.
// Calls Trading HTTP API CLOB endpoints.
// Usage: node check-orders.js [--order-id <id>] [--cancel-stale <hours>]

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_FILE = '/home/agent/config/api.json';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { api_url: process.env.TRADING_API_URL || 'http://localhost:9100', token: '' }; }
}

function apiCall(config, method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.api_url);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
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
    req.end();
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--order-id' && args[i + 1]) result.orderId = args[++i];
    if (args[i] === '--cancel-stale' && args[i + 1]) result.cancelStaleHours = parseFloat(args[++i]);
  }
  return result;
}

async function main() {
  const config = loadConfig();
  const args = parseArgs();

  // If a specific order ID is requested, fetch just that one.
  if (args.orderId) {
    try {
      const r = await apiCall(config, 'GET', `/clob/order?order_id=${encodeURIComponent(args.orderId)}`);
      if (r.status >= 400) {
        console.log(JSON.stringify({ error: `Order lookup failed (${r.status})`, details: r.body }));
        return;
      }
      console.log(JSON.stringify({ order: r.body }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Fetch all open orders.
  let orders = [];
  try {
    const r = await apiCall(config, 'GET', '/clob/orders');
    if (r.status < 400 && Array.isArray(r.body)) {
      orders = r.body;
    } else if (r.status === 503) {
      console.log(JSON.stringify({ note: 'CLOB not configured — no orders to check' }));
      return;
    }
  } catch (e) {
    console.log(JSON.stringify({ error: `Failed to fetch orders: ${e.message}` }));
    return;
  }

  if (orders.length === 0) {
    console.log(JSON.stringify({ open_orders: 0, note: 'No open orders' }));
    return;
  }

  // Summarize orders by status and identify stale ones.
  const now = Date.now();
  const summary = {
    open_orders: orders.length,
    orders: orders.map(o => ({
      order_id: o.id || o.order_id,
      asset_id: o.asset_id,
      side: o.side,
      size: o.original_size || o.size,
      size_matched: o.size_matched,
      price: o.price,
      status: o.status,
      created_at: o.created_at,
    })),
  };

  // Flag stale orders if --cancel-stale is set.
  if (args.cancelStaleHours) {
    const cutoff = now - args.cancelStaleHours * 3600 * 1000;
    summary.stale_orders = summary.orders.filter(o => {
      const created = new Date(o.created_at).getTime();
      return !isNaN(created) && created < cutoff;
    }).map(o => o.order_id);

    if (summary.stale_orders.length > 0) {
      summary.note = `${summary.stale_orders.length} orders older than ${args.cancelStaleHours}h — consider cancelling`;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
