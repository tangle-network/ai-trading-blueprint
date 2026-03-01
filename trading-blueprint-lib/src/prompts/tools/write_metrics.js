#!/usr/bin/env node
// Metrics writer — updates /home/agent/metrics/latest.json
// Usage: node write-metrics.js '{"portfolio_value_usd":10000,"pnl_pct":0.5}'
const fs = require('fs');
const METRICS_FILE = '/home/agent/metrics/latest.json';
const PHASE_FILE = '/home/agent/state/phase.json';
const DB_FILE = '/home/agent/data/trading.json';

let phase;
try {
  phase = JSON.parse(fs.readFileSync(PHASE_FILE, 'utf8'));
} catch {
  phase = { current: 'research', iteration: 0 };
}

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  db = { trades: [], signals: [] };
}

let extra = {};
if (process.argv[2]) {
  try {
    extra = JSON.parse(process.argv[2]);
  } catch {}
}

const metrics = {
  timestamp: new Date().toISOString(),
  iteration: phase.iteration,
  phase: phase.current,
  trades_executed: db.trades ? db.trades.length : 0,
  signals_generated: db.signals ? db.signals.length : 0,
  ...extra,
};

fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics));
