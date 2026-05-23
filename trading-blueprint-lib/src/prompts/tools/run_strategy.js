#!/usr/bin/env node
// Run one generated strategy tick.
//
// Usage:
//   node /home/agent/tools/run-strategy.js /home/agent/tools/strategies/my-strategy.js

const path = require('path');
const { runStrategy } = require('./strategy-sdk');

function parseArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const rawPath = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : parseArg('--strategy');
  if (!rawPath) {
    throw new Error('missing strategy path');
  }

  const strategyPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(process.cwd(), rawPath);
  const strategy = require(strategyPath);
  const result = await runStrategy(strategy, {
    mode: parseArg('--mode') || undefined,
    strategyId: parseArg('--id') || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error && error.message ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
