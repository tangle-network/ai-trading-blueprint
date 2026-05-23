#!/usr/bin/env node
// Create a deterministic multi-round self-improvement MCP task that builds an
// executable paper strategy. Intended for evals and for agents learning the
// correct MCP dispatch shape.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.AGENT_WORKSPACE || '/home/agent';
const MCP_SERVER = '/home/agent/tools/self-improvement-mcp-server.ts';
const STRATEGY_FILE = 'tools/strategies/eval-mcp-multishot-breakout.js';
const OUT_DIR = path.join(ROOT, 'eval-artifacts', 'mcp');
const OUT_FILE = path.join(OUT_DIR, 'multishot-strategy-task.json');

const codingCommand = String.raw`sh -lc 'if grep -q "Round: 1/3" .self-improvement-prompt.md; then mkdir -p tools/strategies; printf "module.exports = { id: '\''eval-mcp-multishot-breakout'\'' }\n" > tools/strategies/eval-mcp-multishot-breakout.js; else mkdir -p tools/strategies; cat > tools/strategies/eval-mcp-multishot-breakout.js <<"JS"
module.exports = {
  id: "eval-mcp-multishot-breakout",
  async tick(ctx) {
    const signal = {
      mechanism: "mcp_multishot_breakout",
      mode: ctx.mode,
      breakoutLevel: 3125,
      observedPrice: 3132,
      risk: { maxDrawdownPct: 3, maxSlippageBps: 75, paperOnly: true },
      reason: "round-two strategy validates that MCP recovered from the intentional first-round failure"
    };
    ctx.writeArtifact("mcp-multishot-breakout-signal", signal);
    return ctx.skip("paper/shadow breakout signal recorded; live trading blocked until backtest and validator approval", signal);
  }
};
JS
fi'`;

function callMcp(name, args, timeoutMs = 1_800_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['--bun', MCP_SERVER], {
      cwd: ROOT,
      env: { ...process.env, AGENT_WORKSPACE: ROOT },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MCP ${name} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`MCP ${name} exited ${code}\n${stderr}`));
        return;
      }
      try {
        const lines = stdout.split('\n').filter(Boolean);
        const response = JSON.parse(lines[lines.length - 1] || '{}');
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(JSON.parse(response.result?.content?.[0]?.text ?? 'null'));
      } catch (error) {
        reject(new Error(`MCP ${name} returned invalid JSON: ${error.message}\n${stdout}`));
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
    child.stdin.end();
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const created = await callMcp('self_improvement.create_task', {
    spec: 'Build an executable paper strategy for the breakout mechanism. Round 1 intentionally fails and round 2 fixes it so this proves multi-shot MCP recovery.',
    max_rounds: 3,
    wait_for_completion: true,
    coding_timeout_ms: 900_000,
    test_timeout_ms: 1_200_000,
    reviewer_command: '',
    coding_command: codingCommand,
    tests: [`node /home/agent/tools/run-strategy.js ${STRATEGY_FILE} --mode paper --id eval-mcp-multishot-breakout`],
  });
  const taskId = created.task_id;
  if (!taskId) throw new Error(`create_task did not return task_id: ${JSON.stringify(created)}`);
  const status = await callMcp('self_improvement.status', { task_id: taskId });
  const patch = await callMcp('self_improvement.patch', { task_id: taskId });
  const candidate = status.status === 'completed'
    ? await callMcp('self_improvement.promote_candidate', { task_id: taskId })
    : null;
  const summary = {
    task_id: taskId,
    status: status.status,
    winner_variant_id: status.winner_variant_id,
    max_rounds: status.max_rounds,
    patch_sha256: status.patch_sha256,
    files_changed: status.files_changed,
    variants: status.variants,
    patch_contains_strategy: typeof patch === 'string' && patch.includes(STRATEGY_FILE),
    candidate,
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (status.status !== 'completed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exit(1);
});
