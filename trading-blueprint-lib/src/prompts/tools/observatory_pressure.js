// Lightweight Observatory pressure probe for bot-local control loops.
//
// This is intentionally smaller than observatory-loop.js. It gives trading and
// self-improvement processes a cheap, deterministic answer to "may I open more
// delegated work?" without writing new reflection records.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.AGENT_WORKSPACE || '/home/agent';
const MEMORY_DIR = process.env.AGENT_MEMORY_DIR || path.join(ROOT, 'memory');
const OBSERVATORY_DIR = process.env.AGENT_OBSERVATORY_DIR || path.join(MEMORY_DIR, 'observatory');
const DELEGATED_WORK_FILE = process.env.AGENT_OBSERVATORY_DELEGATED_WORK_FILE || path.join(OBSERVATORY_DIR, 'delegated-work-sessions.jsonl');

function readJsonl(file, max = 500) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - max)).map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
      } catch {
        return { parse_error: line.slice(0, 200) };
      }
    });
  } catch {
    return [];
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeBySessionId(sessions, limit = 500) {
  const byId = new Map();
  for (const session of sessions) {
    const sessionId = session && typeof session === 'object' ? session.session_id : null;
    if (!sessionId) continue;
    const existing = byId.get(sessionId);
    if (!existing || timestampMs(session.created_at) >= timestampMs(existing.created_at)) {
      byId.set(sessionId, session);
    }
  }
  return [...byId.values()]
    .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
    .slice(0, limit);
}

function activeDelegationStatus(status) {
  return /dispatch|queued|running|pending|await|open/i.test(String(status || ''));
}

function terminalDelegationStatus(status) {
  return /complete|pass|done|blocked|failed|error|reject|cancel/i.test(String(status || ''));
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function summarizeBy(items, keyFn) {
  const result = {};
  for (const item of items) {
    const key = String(keyFn(item) || 'unknown');
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function readObservatoryPressure(options = {}) {
  const maxActiveDelegations = Number.isFinite(Number(options.maxActiveDelegations))
    ? Number(options.maxActiveDelegations)
    : numberFromEnv('OBSERVATORY_MAX_ACTIVE_DELEGATIONS', 3);
  const maxCpuPressure = Number.isFinite(Number(options.maxCpuPressure))
    ? Number(options.maxCpuPressure)
    : numberFromEnv('OBSERVATORY_MAX_CPU_PRESSURE', 0.85);
  const minFreeMemoryMb = Number.isFinite(Number(options.minFreeMemoryMb))
    ? Number(options.minFreeMemoryMb)
    : numberFromEnv('OBSERVATORY_MIN_FREE_MEMORY_MB', 512);

  const rawSessions = readJsonl(DELEGATED_WORK_FILE, 1000);
  const unique = dedupeBySessionId(rawSessions, 500);
  const active = unique.filter((session) => activeDelegationStatus(session.status));
  const terminal = unique.filter((session) => terminalDelegationStatus(session.status));
  const load1 = os.loadavg()[0] || 0;
  const cpuCount = os.cpus().length || 1;
  const cpuPressure = Number((load1 / cpuCount).toFixed(3));
  const memoryFreeMb = Math.round(os.freemem() / 1024 / 1024);
  const memoryTotalMb = Math.round(os.totalmem() / 1024 / 1024);

  const denyReasons = [];
  if (active.length >= maxActiveDelegations) denyReasons.push('active_delegation_cap');
  if (cpuPressure >= maxCpuPressure) denyReasons.push('cpu_pressure_cap');
  if (memoryFreeMb < minFreeMemoryMb) denyReasons.push('memory_floor');

  const pressureLevel = active.length >= maxActiveDelegations || cpuPressure >= maxCpuPressure
    ? 'high'
    : active.length >= Math.max(1, Math.floor(maxActiveDelegations / 2)) || cpuPressure >= Math.max(0.5, maxCpuPressure * 0.7)
      ? 'medium'
      : 'low';

  return {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    unique_sessions: unique.length,
    active_sessions: active.length,
    terminal_sessions: terminal.length,
    duplicate_rows_removed: Math.max(0, rawSessions.length - unique.length),
    by_status: summarizeBy(unique, (session) => session.status),
    by_source: summarizeBy(unique, (session) => session.source),
    system: {
      load_1m: Number(load1.toFixed(3)),
      cpu_count: cpuCount,
      cpu_pressure: cpuPressure,
      memory_free_mb: memoryFreeMb,
      memory_total_mb: memoryTotalMb,
    },
    limits: {
      max_active_delegations: maxActiveDelegations,
      max_cpu_pressure: maxCpuPressure,
      min_free_memory_mb: minFreeMemoryMb,
    },
    pressure_level: pressureLevel,
    allows_new_delegation: denyReasons.length === 0,
    deny_reasons: denyReasons,
  };
}

module.exports = {
  activeDelegationStatus,
  dedupeBySessionId,
  readObservatoryPressure,
  terminalDelegationStatus,
};

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(readObservatoryPressure(), null, 2)}\n`);
}
