#!/usr/bin/env node
// Phase state manager — updates /home/agent/state/phase.json
// Usage: node update-phase.js <phase> [--tools-built tool1,tool2]
const fs = require('fs');
const PHASE_FILE = '/home/agent/state/phase.json';

const phase = process.argv[2];
if (!phase) {
  console.error(JSON.stringify({ error: 'Usage: node update-phase.js <phase>' }));
  process.exit(1);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(PHASE_FILE, 'utf8'));
} catch {
  state = { current: 'research', iteration: 0, tools_built: [] };
}

state.current = phase;
state.iteration = (state.iteration || 0) + 1;
state.updated_at = new Date().toISOString();

// Optional: update tools_built list
const toolsIdx = process.argv.indexOf('--tools-built');
if (toolsIdx >= 0 && process.argv[toolsIdx + 1]) {
  state.tools_built = process.argv[toolsIdx + 1].split(',');
}

fs.writeFileSync(PHASE_FILE, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ phase, iteration: state.iteration }));
