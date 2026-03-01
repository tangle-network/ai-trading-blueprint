#!/usr/bin/env node
// Decision logger — appends to /home/agent/logs/decisions.jsonl
// Usage: node log-decision.js '{"action":"buy","market":"...","rationale":"..."}'
const fs = require('fs');
const LOG_FILE = '/home/agent/logs/decisions.jsonl';

const input = process.argv[2];
if (!input) {
  console.error(JSON.stringify({ error: 'Usage: node log-decision.js \'{"action":"..."}\''}));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(input);
} catch (e) {
  console.error(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
  process.exit(1);
}

const entry = {
  timestamp: new Date().toISOString(),
  ...data,
};

fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
console.log(JSON.stringify({ logged: true, timestamp: entry.timestamp }));
