#!/usr/bin/env node
// Smart market analyzer — scans Gamma API, fetches CLOB prices, filters to
// actionable opportunities. Outputs a compact summary for the agent.
// Usage: node analyze-opportunities.js [--limit 30] [--min-volume 50000]
const https = require('https');
const fs = require('fs');
const DB_FILE = '/home/agent/data/trading.json';
const STATE_FILE = '/home/agent/state/trading-state.json';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TradingAgent/1.0' }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const limit = parseInt(parseArg('--limit', '30'));
  const minVolume = parseFloat(parseArg('--min-volume', '50000'));

  // Load persistent state
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { state = { watchlist: [], positions: [], insights: [], iteration: 0 }; }

  // 1. Fetch top events by volume from Gamma API
  let events;
  try {
    events = await httpsGet(
      'https://gamma-api.polymarket.com/events?closed=false&limit=' + limit + '&order=volume&ascending=false'
    );
  } catch (e) {
    console.log(JSON.stringify({ error: 'Gamma API failed: ' + e.message, opportunities: [] }));
    process.exit(0);
  }

  // 2. Extract markets and filter
  const allMarkets = [];
  for (const event of (Array.isArray(events) ? events : [])) {
    if (!event.markets) continue;
    for (const m of event.markets) {
      const vol = parseFloat(m.volume || 0);
      if (vol < minVolume) continue;

      let prices = [];
      try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}
      let clobTokenIds = [];
      try { clobTokenIds = JSON.parse(m.clobTokenIds || '[]'); } catch {}

      const yesPrice = parseFloat(prices[0] || 0);
      // Skip markets that are nearly resolved (>92% or <8%) — no edge left
      if (yesPrice > 0.92 || yesPrice < 0.08) continue;
      // Skip markets ending in <6 hours (resolution risk)
      const endDate = m.endDate ? new Date(m.endDate) : null;
      if (endDate && endDate - Date.now() < 6 * 3600 * 1000) continue;

      allMarkets.push({
        condition_id: m.id,
        question: m.question || '',
        event_title: event.title || '',
        yes_price: yesPrice,
        no_price: parseFloat(prices[1] || 0),
        volume: vol,
        liquidity: parseFloat(m.liquidity || 0),
        clob_token_ids: clobTokenIds,
        end_date: m.endDate || null,
        slug: m.marketSlug || '',
        resolution_source: m.resolutionSource || '',
      });
    }
  }

  // 3. Fetch CLOB midpoints for top candidates (more accurate than Gamma prices)
  const candidates = allMarkets.sort((a, b) => b.volume - a.volume).slice(0, 20);
  let priceErrors = 0;
  for (const m of candidates) {
    if (!m.clob_token_ids[0]) continue;
    try {
      const data = await httpsGet(
        'https://clob.polymarket.com/midpoint?token_id=' + m.clob_token_ids[0]
      );
      if (data && data.mid !== undefined) {
        m.clob_midpoint = parseFloat(data.mid);
      }
    } catch { priceErrors++; }
    await sleep(80);
  }

  // 4. Save full data to DB for reference
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }
  db.markets = allMarkets;
  db.last_scan = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

  // 5. Update state
  state.iteration = (state.iteration || 0) + 1;
  state.last_scan = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // 6. Output compact actionable summary
  const opportunities = candidates
    .filter(m => {
      const price = m.clob_midpoint || m.yes_price;
      return price >= 0.10 && price <= 0.90 && m.volume >= minVolume;
    })
    .slice(0, 10)
    .map(m => ({
      id: m.condition_id,
      q: m.question.slice(0, 100),
      yes: (m.clob_midpoint || m.yes_price).toFixed(3),
      vol: '$' + (m.volume / 1e6).toFixed(1) + 'M',
      liq: '$' + (m.liquidity / 1e3).toFixed(0) + 'k',
      ends: m.end_date ? m.end_date.slice(0, 10) : '?',
      src: m.resolution_source ? m.resolution_source.slice(0, 60) : '',
      token_yes: m.clob_token_ids[0] || '',
      token_no: m.clob_token_ids[1] || '',
    }));

  console.log(JSON.stringify({
    scan_summary: {
      total_events: events.length,
      markets_above_min_volume: allMarkets.length,
      tradeable_opportunities: opportunities.length,
      clob_price_errors: priceErrors,
      iteration: state.iteration,
    },
    opportunities,
    action_required: opportunities.length > 0
      ? 'Review opportunities above. For each, estimate your probability and calculate edge (your_prob - market_price). Trade if |edge| > 5%.'
      : 'No tradeable opportunities found. Update metrics and finish.',
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
