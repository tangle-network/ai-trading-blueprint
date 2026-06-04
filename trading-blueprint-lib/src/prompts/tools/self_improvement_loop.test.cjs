const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function hasBun() {
  return spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
}

function evalRiskBudget(prompt) {
  const source = `
    import { riskBudgetRequest } from './trading-blueprint-lib/src/prompts/tools/self_improvement_loop.ts';
    console.log(JSON.stringify(riskBudgetRequest(${JSON.stringify(prompt)})));
  `;
  const result = spawnSync('bun', ['--bun', '-e', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('self-improvement risk budget treats Hyperliquid perps as perps despite prior-outcome wording', { skip: !hasBun() }, () => {
  const budget = evalRiskBudget(
    'Repair prior-outcome evidence for an ETH perps strategy on Hyperliquid with leverage and liquidation limits.',
  );

  assert.equal(budget.market_type, 'perp');
  assert.equal(budget.instrument_type, 'perpetual');
  assert.equal(budget.venue, 'hyperliquid');
  assert.equal(budget.target_protocol, 'hyperliquid');
});

test('self-improvement risk budget still treats explicit Hyperliquid outcome markets as binary predictions', { skip: !hasBun() }, () => {
  const budget = evalRiskBudget('Trade a Hyperliquid outcome market hyperp as a binary prediction contract.');

  assert.equal(budget.market_type, 'prediction_market');
  assert.equal(budget.instrument_type, 'binary_prediction');
  assert.equal(budget.venue, 'hyperliquid');
  assert.equal(budget.target_protocol, 'hyperliquid');
});
