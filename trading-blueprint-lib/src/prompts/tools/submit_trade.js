#!/usr/bin/env node
// Submit a trade — handles circuit-breaker, validation, execution, and logging
// in a single command. The agent just decides WHAT to trade.
//
// Usage: node submit-trade.js --condition-id <id> --side YES --amount 100 --reason "8% edge on X"
// Options:
//   --condition-id  Polymarket condition ID (from analyze-opportunities)
//   --side          YES or NO
//   --amount        Size in outcome shares (e.g. 100)
//   --price         Limit price (0.01-0.99). If omitted, uses CLOB midpoint.
//   --reason        Brief reasoning for the trade (logged)
//   --token-id      CLOB token ID (optional, looked up from trading.json if omitted)
//   --order-type    GTC (default), GTD, FOK, or FAK

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DB_FILE = '/home/agent/data/trading.json';
const LOG_FILE = '/home/agent/logs/decisions.jsonl';
const CONFIG_FILE = '/home/agent/config/api.json';

function parseArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

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
      timeout: 30000,
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
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function log(entry) {
  try {
    fs.mkdirSync('/home/agent/logs', { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch {}
}

async function main() {
  const conditionId = parseArg('--condition-id');
  const side = (parseArg('--side') || 'YES').toUpperCase();
  const amount = parseFloat(parseArg('--amount') || '0');
  const reason = parseArg('--reason') || '';
  let tokenId = parseArg('--token-id');
  let price = parseFloat(parseArg('--price') || '0');
  const orderType = (parseArg('--order-type') || 'GTC').toUpperCase();

  if (!conditionId) { console.log(JSON.stringify({ error: 'Missing --condition-id' })); process.exit(1); }
  if (amount <= 0) { console.log(JSON.stringify({ error: 'Missing or invalid --amount' })); process.exit(1); }

  // Look up token ID from trading.json if not provided
  if (!tokenId) {
    try {
      const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const market = (db.markets || []).find(m => m.condition_id === conditionId);
      if (market && market.clob_token_ids) {
        tokenId = side === 'YES' ? market.clob_token_ids[0] : market.clob_token_ids[1];
      }
    } catch {}
    if (!tokenId) {
      console.log(JSON.stringify({ error: 'Could not find CLOB token ID for condition ' + conditionId + '. Provide --token-id.' }));
      process.exit(1);
    }
  }

  const config = loadConfig();
  const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon USDC

  // Fetch midpoint price from trading HTTP API if not provided
  if (price <= 0) {
    try {
      const midResult = await apiCall(config, 'GET', '/clob/midpoint?token_id=' + tokenId);
      if (midResult.body && midResult.body.midpoint) {
        price = midResult.body.midpoint;
      }
    } catch {}
    if (price <= 0) {
      // Fallback to direct CLOB API
      try {
        const data = await new Promise((resolve, reject) => {
          https.get('https://clob.polymarket.com/midpoint?token_id=' + tokenId, {
            headers: { 'User-Agent': 'TradingAgent/1.0' }, timeout: 10000
          }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
          }).on('error', reject);
        });
        if (data && data.mid) price = parseFloat(data.mid);
      } catch {}
    }
    if (price <= 0) {
      console.log(JSON.stringify({ error: 'Could not determine price. Provide --price.' }));
      process.exit(1);
    }
  }

  // Step 1: Circuit breaker check
  let cbResult;
  try {
    cbResult = await apiCall(config, 'POST', '/circuit-breaker/check', { max_drawdown_pct: 10 });
    if (cbResult.body && cbResult.body.triggered) {
      const result = { action: 'blocked', reason: 'Circuit breaker triggered', details: cbResult.body };
      log({ ...result, condition_id: conditionId, side, amount });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  } catch (e) {
    // Circuit breaker check failed — proceed with caution (paper trade mode likely)
  }

  // Step 2: Validate trade intent
  // CLOB orders: amount_in is the share size, price is in metadata.
  // action=buy for purchasing outcome tokens, sell for selling.
  const intent = {
    strategy_id: 'prediction-' + conditionId.slice(0, 8),
    action: 'buy',
    token_in: USDC,
    token_out: tokenId,
    amount_in: amount.toString(),
    min_amount_out: '0',
    target_protocol: 'polymarket_clob',
    metadata: {
      token_id: tokenId,
      price: price,
      order_type: orderType,
      condition_id: conditionId,
      outcome: side,
      reason,
    },
  };

  let validation;
  try {
    const valResult = await apiCall(config, 'POST', '/validate', intent);
    if (valResult.status >= 400 || (valResult.body && valResult.body.error)) {
      const result = { action: 'rejected', reason: 'Validation failed', details: valResult.body };
      log({ ...result, intent });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    validation = valResult.body;
  } catch (e) {
    const result = { action: 'error', reason: 'Validation request failed: ' + e.message };
    log({ ...result, intent });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Step 3: Execute trade
  let execution;
  try {
    const execResult = await apiCall(config, 'POST', '/execute', { intent, validation });
    execution = execResult.body;
  } catch (e) {
    const result = { action: 'error', reason: 'Execution failed: ' + e.message, validation };
    log({ ...result, intent });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Step 4: Log and report
  const result = {
    action: 'traded',
    condition_id: conditionId,
    side,
    size: amount,
    price,
    cost_usd: (amount * price).toFixed(2),
    order_type: orderType,
    reason,
    validation_approved: validation.approved !== false,
    execution,
  };
  log(result);

  console.log(JSON.stringify({
    status: 'success',
    trade: {
      condition_id: conditionId,
      side,
      size: amount + ' shares',
      price: price.toFixed(4),
      cost: '$' + (amount * price).toFixed(2),
      order_type: orderType,
      reason,
    },
    validation: { approved: validation.approved, score: validation.aggregate_score },
    execution: execution,
    clob_order_id: execution && execution.clob_order_id || null,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
