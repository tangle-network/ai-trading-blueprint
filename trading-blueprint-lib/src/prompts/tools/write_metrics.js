#!/usr/bin/env node
// Metrics writer — updates /home/agent/metrics/latest.json and, when possible,
// records a real /metrics/snapshot entry via the Trading API.
// Usage: node write-metrics.js '{"portfolio_value_usd":10000,"pnl_pct":0.5}'
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const METRICS_FILE = '/home/agent/metrics/latest.json';
const PHASE_FILE = '/home/agent/state/phase.json';
const DB_FILE = '/home/agent/data/trading.json';
const CONFIG_FILE = '/home/agent/config/api.json';

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function postJson(baseUrl, token, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data || '{}') });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const phase = readJson(PHASE_FILE, { current: 'research', iteration: 0 });
  const db = readJson(DB_FILE, { trades: [], signals: [] });
  const config = readJson(CONFIG_FILE, null);

  let extra = {};
  if (process.argv[2]) {
    try {
      extra = JSON.parse(process.argv[2]);
    } catch {}
  }

  let portfolioValueUsd = parseNumber(extra.portfolio_value_usd);
  let positionsCount = parseNumber(extra.positions_count);
  let tradeCount = parseNumber(extra.trade_count);
  let unrealizedPnl = parseNumber(extra.unrealized_pnl);
  let realizedPnl = parseNumber(extra.realized_pnl);

  if (config && config.api_url && config.token) {
    try {
      const portfolioResult = await postJson(config.api_url, config.token, '/portfolio/state', {});
      if (portfolioResult.status < 400 && portfolioResult.body) {
        const body = portfolioResult.body;
        const fetchedValue = parseNumber(body.total_value_usd);
        if ((portfolioValueUsd == null || portfolioValueUsd <= 0) && fetchedValue != null && body.has_unpriced_positions !== true) {
          portfolioValueUsd = fetchedValue;
        }
        if (positionsCount == null) {
          positionsCount = Array.isArray(body.positions) ? body.positions.length : 0;
        }
        const fetchedUnrealizedPnl = parseNumber(body.unrealized_pnl);
        if (unrealizedPnl == null && fetchedUnrealizedPnl != null) {
          unrealizedPnl = fetchedUnrealizedPnl;
        }
        const fetchedRealizedPnl = parseNumber(body.realized_pnl);
        if (realizedPnl == null && fetchedRealizedPnl != null) {
          realizedPnl = fetchedRealizedPnl;
        }
      }
    } catch {}

    try {
      const tradesResult = await new Promise((resolve, reject) => {
        const url = new URL('/trades?limit=500', config.api_url);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            headers: { Authorization: `Bearer ${config.token}` },
            timeout: 30_000,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode || 0, body: JSON.parse(data || '{}') });
              } catch {
                resolve({ status: res.statusCode || 0, body: data });
              }
            });
          },
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('request timeout'));
        });
        req.end();
      });

      if (tradesResult.status < 400 && tradesResult.body) {
        const trades = Array.isArray(tradesResult.body)
          ? tradesResult.body
          : Array.isArray(tradesResult.body.trades)
            ? tradesResult.body.trades
            : [];
        if (tradeCount == null) {
          tradeCount = trades.length;
        }
      }
    } catch {}
  }

  const metrics = {
    timestamp: new Date().toISOString(),
    iteration: phase.iteration,
    phase: phase.current,
    trades_executed: db.trades ? db.trades.length : 0,
    signals_generated: db.signals ? db.signals.length : 0,
    ...extra,
    ...(portfolioValueUsd != null ? { portfolio_value_usd: portfolioValueUsd } : {}),
    ...(positionsCount != null ? { positions_count: positionsCount } : {}),
    ...(tradeCount != null ? { trade_count: tradeCount } : {}),
    ...(unrealizedPnl != null ? { unrealized_pnl: unrealizedPnl } : {}),
    ...(realizedPnl != null ? { realized_pnl: realizedPnl } : {}),
  };

  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));

  if (config && config.api_url && config.token && portfolioValueUsd != null && portfolioValueUsd > 0) {
    try {
      await postJson(config.api_url, config.token, '/metrics/snapshot', {
        account_value_usd: String(portfolioValueUsd),
        unrealized_pnl: String(unrealizedPnl ?? 0),
        realized_pnl: String(realizedPnl ?? 0),
        high_water_mark: String(parseNumber(extra.high_water_mark) ?? portfolioValueUsd),
        drawdown_pct: String(parseNumber(extra.drawdown_pct) ?? 0),
        positions_count: positionsCount ?? 0,
        trade_count: tradeCount ?? 0,
      });
    } catch {}
  }

  console.log(JSON.stringify(metrics));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message || String(error) }));
  process.exit(1);
});
