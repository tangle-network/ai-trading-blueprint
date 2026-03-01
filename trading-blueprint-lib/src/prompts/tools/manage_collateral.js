#!/usr/bin/env node
// Manage CLOB collateral — release vault funds for off-chain trading, return funds, check status.
//
// Usage:
//   node manage-collateral.js --action status
//   node manage-collateral.js --action release --amount 1000
//   node manage-collateral.js --action return --amount 500
//   node manage-collateral.js --action return-all

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_FILE = '/home/agent/config/api.json';
const LOG_FILE = '/home/agent/logs/decisions.jsonl';

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
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
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
  const action = (parseArg('--action') || '').toLowerCase();
  const amount = parseArg('--amount') || '0';
  const config = loadConfig();

  if (!action) {
    console.log(JSON.stringify({ error: 'Missing --action. Use: status, release, return, return-all' }));
    process.exit(1);
  }

  // ── STATUS ──────────────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const res = await apiCall(config, 'GET', '/collateral/status');
      if (res.status >= 400) {
        console.log(JSON.stringify({ error: 'Status check failed', details: res.body }));
        return;
      }
      const s = res.body;
      const outstanding = parseFloat(s.total_outstanding || '0');
      const available = parseFloat(s.available || '0');
      const maxBps = parseInt(s.max_collateral_bps || '0', 10);
      const enabled = maxBps > 0;

      console.log(JSON.stringify({
        collateral: {
          enabled,
          max_collateral_pct: (maxBps / 100).toFixed(1) + '%',
          outstanding: outstanding.toString(),
          available: available.toString(),
          operator_outstanding: s.operator_outstanding || '0',
        },
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: 'Status request failed: ' + e.message }));
    }
    return;
  }

  // ── RETURN-ALL ──────────────────────────────────────────────────────
  if (action === 'return-all') {
    try {
      // First get status to find outstanding amount
      const statusRes = await apiCall(config, 'GET', '/collateral/status');
      if (statusRes.status >= 400) {
        console.log(JSON.stringify({ error: 'Could not get collateral status', details: statusRes.body }));
        return;
      }
      const outstanding = statusRes.body.operator_outstanding || '0';
      if (outstanding === '0') {
        console.log(JSON.stringify({ status: 'nothing_to_return', outstanding: '0' }));
        return;
      }
      // Return full outstanding amount
      const retRes = await apiCall(config, 'POST', '/collateral/return', { amount: outstanding });
      if (retRes.status >= 400) {
        console.log(JSON.stringify({ error: 'Return failed', details: retRes.body }));
        return;
      }
      log({ action: 'collateral_return_all', amount: outstanding, tx_hash: retRes.body.tx_hash });
      console.log(JSON.stringify({
        status: 'returned',
        amount: outstanding,
        tx_hash: retRes.body.tx_hash,
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: 'Return-all failed: ' + e.message }));
    }
    return;
  }

  // ── RETURN ──────────────────────────────────────────────────────────
  if (action === 'return') {
    if (amount === '0') {
      console.log(JSON.stringify({ error: 'Missing --amount for return' }));
      process.exit(1);
    }
    try {
      const res = await apiCall(config, 'POST', '/collateral/return', { amount });
      if (res.status >= 400) {
        console.log(JSON.stringify({ error: 'Return failed', details: res.body }));
        return;
      }
      log({ action: 'collateral_return', amount, tx_hash: res.body.tx_hash });
      console.log(JSON.stringify({
        status: 'returned',
        amount,
        tx_hash: res.body.tx_hash,
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: 'Return failed: ' + e.message }));
    }
    return;
  }

  // ── RELEASE ─────────────────────────────────────────────────────────
  if (action === 'release') {
    if (amount === '0') {
      console.log(JSON.stringify({ error: 'Missing --amount for release' }));
      process.exit(1);
    }

    // Step 1: Validate the collateral release intent to get validator signatures
    const intent = {
      strategy_id: 'collateral-release',
      action: 'collateral_release',
      token_in: '0x0000000000000000000000000000000000000000',
      token_out: '0x0000000000000000000000000000000000000000',
      amount_in: amount,
      min_amount_out: '0',
      target_protocol: 'collateral',
    };

    let validation;
    try {
      const valRes = await apiCall(config, 'POST', '/validate', intent);
      if (valRes.status >= 400 || (valRes.body && valRes.body.error)) {
        console.log(JSON.stringify({ error: 'Validation failed for collateral release', details: valRes.body }));
        return;
      }
      validation = valRes.body;
    } catch (e) {
      console.log(JSON.stringify({ error: 'Validation request failed: ' + e.message }));
      return;
    }

    if (!validation.approved) {
      log({ action: 'collateral_release_rejected', amount, score: validation.aggregate_score });
      console.log(JSON.stringify({
        status: 'rejected',
        reason: 'Validators did not approve collateral release',
        score: validation.aggregate_score,
      }, null, 2));
      return;
    }

    // Step 2: Release collateral with validator signatures
    const releaseReq = {
      amount,
      recipient: config.operator_address || '',
      intent_hash: validation.intent_hash,
      deadline: validation.deadline,
      validation: {
        responses: (validation.validator_responses || []).map(r => ({
          signature: r.signature,
          score: r.score,
        })),
      },
    };

    try {
      const relRes = await apiCall(config, 'POST', '/collateral/release', releaseReq);
      if (relRes.status >= 400) {
        console.log(JSON.stringify({ error: 'Release failed', details: relRes.body }));
        return;
      }
      log({ action: 'collateral_release', amount, tx_hash: relRes.body.tx_hash });
      console.log(JSON.stringify({
        status: 'released',
        amount,
        recipient: relRes.body.recipient,
        tx_hash: relRes.body.tx_hash,
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: 'Release failed: ' + e.message }));
    }
    return;
  }

  console.log(JSON.stringify({ error: 'Unknown action: ' + action + '. Use: status, release, return, return-all' }));
  process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
