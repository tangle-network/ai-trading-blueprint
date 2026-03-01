#!/usr/bin/env node
// CLOB price checker — fetches midpoint prices from Polymarket CLOB
// Usage: node check-prices.js [--limit 20]
const https = require('https');
const fs = require('fs');
const DB_FILE = '/home/agent/data/trading.json';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TradingAgent/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]) || 20 : 20;

  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    console.error(JSON.stringify({ error: 'No trading.json found. Run scan-markets.js first.' }));
    process.exit(1);
  }

  const markets = (db.markets || []).filter((m) => !m.closed);
  const toCheck = markets.slice(0, limit);
  const now = new Date().toISOString();
  let checked = 0;
  const errors = [];

  for (const market of toCheck) {
    // CLOB API needs the actual token ID, not the Gamma condition_id
    const tokenId = (market.clob_token_ids && market.clob_token_ids[0]) || null;
    if (!tokenId) {
      errors.push({ condition_id: market.condition_id, error: 'No clob_token_ids' });
      continue;
    }
    try {
      const data = await httpsGet(
        'https://clob.polymarket.com/midpoint?token_id=' + tokenId
      );
      if (data && data.mid !== undefined) {
        market.midpoint = parseFloat(data.mid);
        market.price_updated_at = now;
        checked++;
      }
    } catch (e) {
      errors.push({ condition_id: market.condition_id, error: e.message });
    }
    // Rate limit: small delay between requests
    await sleep(100);
  }

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

  // Summary with actionable data
  const priced = markets
    .filter((m) => m.midpoint !== undefined)
    .map((m) => ({
      question: m.question.slice(0, 80),
      midpoint: m.midpoint,
      volume: m.volume,
      end_date: m.end_date,
    }));

  console.log(JSON.stringify({
    prices_checked: checked,
    total_active_markets: markets.length,
    errors: errors.length,
    markets_with_prices: priced.slice(0, 15),
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
