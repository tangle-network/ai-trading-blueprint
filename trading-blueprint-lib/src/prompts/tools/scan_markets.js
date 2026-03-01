#!/usr/bin/env node
// Polymarket market scanner — fetches events from Gamma API
// Usage: node scan-markets.js [--limit 50] [--tag politics]
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
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function parseArg(flag, defaultVal) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultVal;
}

async function main() {
  const limit = parseArg('--limit', '50');
  const tag = parseArg('--tag', '');

  let url = 'https://gamma-api.polymarket.com/events?closed=false&limit=' + limit + '&order=volume&ascending=false';
  if (tag) url += '&tag=' + encodeURIComponent(tag);

  const events = await httpsGet(url);
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = { markets: [], trades: [], signals: [], performance: [], memory: [] };
  }
  if (!db.markets) db.markets = [];

  let updated = 0;
  const now = new Date().toISOString();

  for (const event of (Array.isArray(events) ? events : [])) {
    if (!event.markets) continue;
    for (const market of event.markets) {
      const existing = db.markets.findIndex((m) => m.condition_id === market.id);
      let prices = [];
      try { prices = JSON.parse(market.outcomePrices || '[]'); } catch {}

      let clobTokenIds = [];
      try { clobTokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch {}

      const entry = {
        condition_id: market.id,
        question: market.question || '',
        outcomes: market.outcomes || [],
        prices,
        clob_token_ids: clobTokenIds,
        volume: parseFloat(market.volume || 0),
        liquidity: parseFloat(market.liquidity || 0),
        end_date: market.endDate || null,
        slug: market.marketSlug || '',
        resolution_source: market.resolutionSource || '',
        event_title: event.title || '',
        closed: !!market.closed,
        updated_at: now,
      };

      if (existing >= 0) {
        db.markets[existing] = { ...db.markets[existing], ...entry };
      } else {
        db.markets.push(entry);
      }
      updated++;
    }
  }

  // Sort by volume descending
  db.markets.sort((a, b) => (b.volume || 0) - (a.volume || 0));

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

  // Output summary of top markets
  const top = db.markets.slice(0, 10).map((m) => ({
    question: m.question.slice(0, 80),
    condition_id: m.condition_id,
    prices: m.prices,
    volume: m.volume,
    liquidity: m.liquidity,
    end_date: m.end_date,
    clob_token_ids: m.clob_token_ids,
  }));

  console.log(JSON.stringify({
    source: 'gamma-api',
    markets_updated: updated,
    total_markets: db.markets.length,
    top_markets: top,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
