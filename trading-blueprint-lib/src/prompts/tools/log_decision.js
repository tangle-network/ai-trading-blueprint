#!/usr/bin/env node
// Decision logger — appends to /home/agent/logs/decisions.jsonl
// Usage: node log-decision.js '{"action":"buy","market":"...","rationale":"..."}'
//
// Also exports the canonical decision-provenance hashing used by the tick
// harness (F2+F3): `stableStringify` produces an order-independent JSON
// serialization (recursively sorted object keys) so identical content always
// serializes byte-identically, and `provenanceHash` returns its sha256. This is
// the single source of truth for `recipe_hash` / `input_hash`; tick_common.js
// and write_metrics.js require this module rather than re-implementing it so the
// three writers can never diverge.
const fs = require('fs');
const crypto = require('crypto');
const LOG_FILE = '/home/agent/logs/decisions.jsonl';

// Deterministic JSON: object keys sorted recursively, arrays preserve order,
// undefined dropped. Identical logical content => identical string => identical
// hash, regardless of key insertion order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item === undefined ? null : item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// sha256 of the stable serialization, hex-encoded. null/undefined input hashes
// the canonical empty object so every decision still carries a defined hash.
function provenanceHash(value) {
  const canonical = value === null || value === undefined ? {} : value;
  return crypto.createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function logDecision(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const entry = {
    timestamp: new Date().toISOString(),
    ...data,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error(JSON.stringify({ error: 'Usage: node log-decision.js \'{"action":"..."}\''}));
    process.exit(1);
  }
  let entry;
  try {
    entry = logDecision(input);
  } catch (e) {
    console.error(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
    process.exit(1);
  }
  console.log(JSON.stringify({ logged: true, timestamp: entry.timestamp }));
}

module.exports = { stableStringify, provenanceHash, logDecision };
