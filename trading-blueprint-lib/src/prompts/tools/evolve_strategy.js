// Evolution strategy tool — diagnoses performance and runs backtest comparison
// Called by the agent during reflect phase when enough time has passed
//
// Usage:
//   node evolve-strategy.js diagnose
//   node evolve-strategy.js compare '{"current": {...}, "candidate": {...}}'
//   node evolve-strategy.js promote '{"harness": {...}, "reason": "..."}'
//   node evolve-strategy.js discard '{"harness": {...}, "reason": "...", "comparison": {...}}'
//   node evolve-strategy.js history

const fs = require('fs');
const path = require('path');
const { apiCall } = require('./api-client');

const HARNESS_PATH = '/home/agent/config/harness.json';
const HARNESS_BACKUP_PATH = '/home/agent/config/harness.backup.json';
const EVOLUTION_LOG = '/home/agent/memory/evolution.jsonl';
const CANDLE_DB = '/home/agent/data/candles.json';
const MIN_EVOLUTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

function loadHarness() {
  try {
    return JSON.parse(fs.readFileSync(HARNESS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function validateHarness(harness) {
  const errors = [];
  if (!harness || typeof harness !== 'object') {
    return ['harness is not an object'];
  }
  if (!Array.isArray(harness.entry_rules) || harness.entry_rules.length === 0) {
    errors.push('entry_rules is empty or missing');
  }
  if (!Array.isArray(harness.exit_rules) || harness.exit_rules.length === 0) {
    errors.push('exit_rules is empty or missing');
  }
  if (harness.entry_rules) {
    const totalWeight = harness.entry_rules.reduce((s, r) => s + (r.weight || 0), 0);
    if (totalWeight <= 0) errors.push('entry rule weights sum to zero');
    for (const [i, rule] of harness.entry_rules.entries()) {
      if (!rule.signal || !rule.signal.type) errors.push(`entry_rules[${i}]: missing signal type`);
      if (!rule.condition || !rule.condition.type) errors.push(`entry_rules[${i}]: missing condition type`);
      if (typeof rule.weight !== 'number' || rule.weight < 0) errors.push(`entry_rules[${i}]: invalid weight`);
    }
  }
  if (typeof harness.entry_threshold === 'number' && (harness.entry_threshold < 0 || harness.entry_threshold > 1)) {
    errors.push('entry_threshold out of [0, 1] range');
  }
  if (typeof harness.max_positions === 'number' && harness.max_positions <= 0) {
    errors.push('max_positions must be > 0');
  }
  return errors;
}

function saveHarness(harness) {
  fs.mkdirSync(path.dirname(HARNESS_PATH), { recursive: true });
  // Backup current before overwriting
  try {
    const current = fs.readFileSync(HARNESS_PATH, 'utf8');
    fs.writeFileSync(HARNESS_BACKUP_PATH, current);
  } catch { /* no existing harness to backup */ }
  fs.writeFileSync(HARNESS_PATH, JSON.stringify(harness, null, 2));
}

function rollbackHarness() {
  try {
    const backup = fs.readFileSync(HARNESS_BACKUP_PATH, 'utf8');
    JSON.parse(backup); // validate it's valid JSON
    fs.writeFileSync(HARNESS_PATH, backup);
    return true;
  } catch {
    return false;
  }
}

function loadCandles() {
  try {
    return JSON.parse(fs.readFileSync(CANDLE_DB, 'utf8'));
  } catch {
    return [];
  }
}

function lastEvolutionTimestamp() {
  try {
    const lines = fs.readFileSync(EVOLUTION_LOG, 'utf8').trim().split('\n');
    if (lines.length === 0 || lines[0] === '') return 0;
    const last = JSON.parse(lines[lines.length - 1]);
    return new Date(last.timestamp).getTime();
  } catch {
    return 0;
  }
}

function appendEvolutionEntry(entry) {
  fs.mkdirSync(path.dirname(EVOLUTION_LOG), { recursive: true });
  fs.appendFileSync(
    EVOLUTION_LOG,
    JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'
  );
}

async function diagnose() {
  const harness = loadHarness();
  const lastEvo = lastEvolutionTimestamp();
  const elapsed = Date.now() - lastEvo;
  const canEvolve = elapsed >= MIN_EVOLUTION_INTERVAL_MS;

  const metricsRes = await apiCall('GET', '/metrics/history?limit=500');
  const tradesRes = await apiCall('GET', '/trades?limit=200');

  const metrics = metricsRes.status === 200 ? metricsRes.data : { snapshots: [] };
  const trades = tradesRes.status === 200 ? tradesRes.data : { trades: [] };

  const tradeList = trades.trades || [];
  const winners = tradeList.filter(t => parseFloat(t.pnl || 0) > 0);
  const losers = tradeList.filter(t => parseFloat(t.pnl || 0) < 0);
  const totalPnl = tradeList.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
  const avgWin = winners.length > 0
    ? winners.reduce((s, t) => s + parseFloat(t.pnl), 0) / winners.length
    : 0;
  const avgLoss = losers.length > 0
    ? losers.reduce((s, t) => s + Math.abs(parseFloat(t.pnl)), 0) / losers.length
    : 0;

  // Group trades by token for per-asset diagnosis
  const byToken = {};
  for (const t of tradeList) {
    const token = t.token || 'unknown';
    if (!byToken[token]) byToken[token] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = parseFloat(t.pnl || 0);
    byToken[token].pnl += pnl;
    if (pnl > 0) byToken[token].wins++;
    else if (pnl < 0) byToken[token].losses++;
  }

  return {
    can_evolve: canEvolve,
    hours_since_last_evolution: Math.round(elapsed / 3600000),
    current_harness: harness,
    total_trades: tradeList.length,
    winning_trades: winners.length,
    losing_trades: losers.length,
    win_rate: tradeList.length > 0 ? (winners.length / tradeList.length * 100).toFixed(1) + '%' : 'N/A',
    total_pnl: totalPnl.toFixed(2),
    avg_win: avgWin.toFixed(2),
    avg_loss: avgLoss.toFixed(2),
    win_loss_ratio: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A',
    per_token: byToken,
    metrics_snapshots: (metrics.snapshots || []).length,
    candles_available: loadCandles().length,
  };
}

async function compare(args) {
  const params = JSON.parse(args);
  const candles = params.candles || loadCandles();

  if (candles.length < 20) {
    return { error: 'Not enough candle data (need >= 20, have ' + candles.length + ')' };
  }

  // Validate candidate before wasting compute
  const candidateErrors = validateHarness(params.candidate);
  if (candidateErrors.length > 0) {
    return { error: 'Invalid candidate harness', validation_errors: candidateErrors };
  }

  const res = await apiCall('POST', '/backtest/compare', {
    current: params.current,
    candidate: params.candidate,
    candles,
    funding: params.funding || [],
  });

  if (res.status !== 200) {
    return { error: 'Backtest compare failed: ' + JSON.stringify(res.data) };
  }

  return res.data;
}

async function promote(args) {
  const params = JSON.parse(args);

  // Validate before promoting
  const errors = validateHarness(params.harness);
  if (errors.length > 0) {
    return { error: 'Cannot promote invalid harness', validation_errors: errors };
  }

  const oldHarness = loadHarness();
  saveHarness(params.harness);

  // Verify the write succeeded by re-reading
  try {
    const reread = JSON.parse(fs.readFileSync(HARNESS_PATH, 'utf8'));
    if (reread.version !== params.harness.version) {
      rollbackHarness();
      return { error: 'Write verification failed, rolled back' };
    }
  } catch (e) {
    rollbackHarness();
    return { error: 'Write produced invalid JSON, rolled back: ' + e.message };
  }

  appendEvolutionEntry({
    action: 'promote',
    reason: params.reason || 'Backtest showed improvement',
    old_version: oldHarness ? oldHarness.version : 0,
    new_version: params.harness.version,
    sharpe_delta: params.sharpe_delta || null,
    drawdown_delta: params.drawdown_delta || null,
  });

  return { success: true, message: 'Harness promoted to version ' + params.harness.version };
}

function discard(args) {
  const params = JSON.parse(args);

  appendEvolutionEntry({
    action: 'discard',
    reason: params.reason || 'Failed promotion criteria',
    candidate_version: params.harness ? params.harness.version : null,
    candidate_harness: params.harness || null,
    comparison_summary: params.comparison ? {
      sharpe_delta: params.comparison.sharpe_delta,
      drawdown_delta: params.comparison.drawdown_delta,
      win_rate_delta: params.comparison.win_rate_delta,
      should_promote: params.comparison.should_promote,
    } : null,
  });

  return { success: true, message: 'Variant discarded and logged for future reference' };
}

function history() {
  try {
    const lines = fs.readFileSync(EVOLUTION_LOG, 'utf8').trim().split('\n');
    if (lines.length === 0 || lines[0] === '') return [];
    return lines.slice(-10).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  const command = process.argv[2];
  const args = process.argv[3] || '{}';

  let result;
  switch (command) {
    case 'diagnose':
      result = await diagnose();
      break;
    case 'compare':
      result = await compare(args);
      break;
    case 'promote':
      result = await promote(args);
      break;
    case 'discard':
      result = discard(args);
      break;
    case 'history':
      result = history();
      break;
    default:
      result = { error: 'Unknown command: ' + command + '. Use: diagnose, compare, promote, discard, history' };
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
