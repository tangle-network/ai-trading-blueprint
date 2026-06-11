// Default no-API-key external signal provider. Fetches public market-sentiment
// sources (alternative.me Fear & Greed, CoinGecko global + trending) and writes
// a normalized snapshot to /home/agent/state/external-signals.json so the
// deterministic tick's external_signal_evidence stops reporting
// `unavailable_no_provider` on fleets with no paid news/sentiment endpoint.
//
// Contract:
//   - NEVER throws. Total upstream failure still yields a snapshot with
//     source_status 'unavailable' and an `errors` note.
//   - Caches: a snapshot younger than SIGNALS_CACHE_TTL_MS (default 10 min)
//     is returned as-is without refetching, so the 5-min tick cron stays well
//     under the public APIs' rate limits (~1 fetch burst / 10 min / sandbox).
//   - Usable both as a library (require(...).collectExternalSignals()) and as
//     a CLI (`node signals-provider.js [--force]` prints the snapshot JSON).
//
// Env overrides (testability + ops):
//   SIGNALS_FNG_URL          full Fear & Greed endpoint URL
//   SIGNALS_COINGECKO_BASE   CoinGecko API base (default https://api.coingecko.com/api/v3)
//   SIGNALS_STATE_FILE       snapshot path (default /home/agent/state/external-signals.json)
//   SIGNALS_CACHE_TTL_MS     cache freshness window (default 600000)
//   SIGNALS_FETCH_TIMEOUT_MS per-request timeout (default 4000)

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function stateFile() {
  return process.env.SIGNALS_STATE_FILE || '/home/agent/state/external-signals.json';
}

function fngUrl() {
  return process.env.SIGNALS_FNG_URL || 'https://api.alternative.me/fng/?limit=2';
}

function coingeckoBase() {
  return (process.env.SIGNALS_COINGECKO_BASE || 'https://api.coingecko.com/api/v3').replace(/\/+$/, '');
}

function cacheTtlMs() {
  const n = Number(process.env.SIGNALS_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
}

function fetchTimeoutMs() {
  const n = Number(process.env.SIGNALS_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoFromUnixSeconds(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n * 1000).toISOString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(fetchTimeoutMs()),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// alternative.me /fng/?limit=2 → current + previous index reading.
async function fetchFearGreed(fetchedAt) {
  const payload = await fetchJson(fngUrl());
  const entries = Array.isArray(payload && payload.data) ? payload.data : [];
  const signals = [];
  entries.slice(0, 2).forEach((entry, index) => {
    const value = finiteOrNull(entry && entry.value);
    if (value === null) return;
    signals.push({
      source: 'alternative.me',
      kind: index === 0 ? 'fear_greed_index' : 'fear_greed_index_previous',
      value,
      label: String((entry && entry.value_classification) || 'Fear & Greed'),
      observed_at: isoFromUnixSeconds(entry && entry.timestamp, fetchedAt),
    });
  });
  return signals;
}

// CoinGecko /global → market-cap delta + BTC dominance.
async function fetchCoingeckoGlobal(fetchedAt) {
  const payload = await fetchJson(`${coingeckoBase()}/global`);
  const data = (payload && payload.data) || {};
  const observedAt = isoFromUnixSeconds(data.updated_at, fetchedAt);
  const signals = [];
  const capChange = finiteOrNull(data.market_cap_change_percentage_24h_usd);
  if (capChange !== null) {
    signals.push({
      source: 'coingecko',
      kind: 'market_cap_change_24h_pct',
      value: capChange,
      label: 'global crypto market cap 24h change %',
      observed_at: observedAt,
    });
  }
  const btcDominance = finiteOrNull(data.market_cap_percentage && data.market_cap_percentage.btc);
  if (btcDominance !== null) {
    signals.push({
      source: 'coingecko',
      kind: 'btc_dominance_pct',
      value: btcDominance,
      label: 'BTC market cap dominance %',
      observed_at: observedAt,
    });
  }
  return signals;
}

// CoinGecko /search/trending → top trending coins (attention proxy).
async function fetchCoingeckoTrending(fetchedAt) {
  const payload = await fetchJson(`${coingeckoBase()}/search/trending`);
  const coins = Array.isArray(payload && payload.coins) ? payload.coins : [];
  return coins.slice(0, 5).map((entry, index) => {
    const item = (entry && entry.item) || {};
    const rank = finiteOrNull(item.market_cap_rank);
    return {
      source: 'coingecko',
      kind: 'trending_coin',
      // market-cap rank when known; otherwise the trending position itself.
      value: rank !== null ? rank : index + 1,
      label: `${String(item.symbol || item.name || 'unknown').toUpperCase()} trending #${index + 1}`,
      observed_at: fetchedAt,
    };
  });
}

function readCachedSnapshot() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function snapshotIsFresh(snapshot) {
  if (!snapshot || typeof snapshot.fetched_at !== 'string') return false;
  // Never cache a total miss: a transient network blip should not blind the
  // bot for the whole TTL window. ok/degraded snapshots cache normally.
  if (snapshot.source_status === 'unavailable') return false;
  const fetchedMs = Date.parse(snapshot.fetched_at);
  return Number.isFinite(fetchedMs) && Date.now() - fetchedMs < cacheTtlMs();
}

function writeSnapshot(snapshot) {
  try {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // Cache write failure is non-fatal: the snapshot is still returned and the
    // next tick simply refetches.
  }
}

async function collectExternalSignals(options = {}) {
  const force = Boolean(options.force);
  if (!force) {
    const cached = readCachedSnapshot();
    if (snapshotIsFresh(cached)) return cached;
  }

  const fetchedAt = new Date().toISOString();
  const sources = [
    ['alternative.me/fng', fetchFearGreed],
    ['coingecko/global', fetchCoingeckoGlobal],
    ['coingecko/trending', fetchCoingeckoTrending],
  ];
  const settled = await Promise.allSettled(sources.map(([, fetcher]) => fetcher(fetchedAt)));

  const signals = [];
  const errors = [];
  let okSources = 0;
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      okSources += 1;
      signals.push(...outcome.value);
    } else {
      errors.push({
        source: sources[index][0],
        error: String((outcome.reason && outcome.reason.message) || outcome.reason || 'fetch failed'),
      });
    }
  });

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    fetched_at: fetchedAt,
    source_status: okSources === sources.length ? 'ok' : okSources > 0 ? 'degraded' : 'unavailable',
    signals,
  };
  if (errors.length > 0) snapshot.errors = errors;
  writeSnapshot(snapshot);
  return snapshot;
}

module.exports = {
  SCHEMA_VERSION,
  collectExternalSignals,
  readCachedSnapshot,
  stateFile,
};

if (require.main === module) {
  const force = process.argv.includes('--force');
  collectExternalSignals({ force })
    .then((snapshot) => {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    })
    .catch((err) => {
      // collectExternalSignals never rejects by construction; this is belt and
      // suspenders so the CLI contract (always print a snapshot) holds anyway.
      process.stdout.write(`${JSON.stringify({
        schema_version: SCHEMA_VERSION,
        fetched_at: new Date().toISOString(),
        source_status: 'unavailable',
        signals: [],
        errors: [{ source: 'signals-provider', error: String((err && err.message) || err) }],
      })}\n`);
    });
}
