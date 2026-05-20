#!/usr/bin/env bun
// Real local eval for the sandbox self-improvement MCP.
//
// This is intentionally process-level rather than a Rust unit test: it launches
// the MCP over stdio, creates real git repos/worktrees, runs real shell/opencode
// coding commands, and validates status/patch artifacts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dir, '..');
const mcpPath = join(repoRoot, 'trading-blueprint-lib/src/prompts/tools/self_improvement_mcp_server.mjs');
const results = [];

function sh(command, cwd, env = {}) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration_ms: Date.now() - started,
  };
}

function record(name, passed, metrics = {}, evidence = {}) {
  results.push({
    name,
    passed,
    metrics,
    evidence,
    at: new Date().toISOString(),
  });
}

function assertOrThrow(condition, message) {
  if (!condition) throw new Error(message);
}

function initRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `aitb-${name}-`));
  sh('git init', dir);
  sh('git config user.email eval@example.com', dir);
  sh('git config user.name eval', dir);
  writeFileSync(join(dir, 'README.md'), 'initial\n', 'utf8');
  sh('git add README.md', dir);
  const commit = sh('git commit -m init', dir);
  assertOrThrow(commit.ok, `git init commit failed: ${commit.stderr || commit.stdout}`);
  return dir;
}

function callMcp(workspace, messages, timeoutMs = 240_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', ['--bun', mcpPath], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_WORKSPACE: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MCP timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`MCP exited ${code}\n${stderr}`));
        return;
      }
      const responses = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolvePromise(responses);
    });
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
  });
}

function textPayload(response) {
  const text = response?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : response?.result;
}

async function createTask(workspace, args, timeoutMs = 240_000) {
  const responses = await callMcp(workspace, [{
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'self_improvement.create_task', arguments: args },
  }], timeoutMs);
  return textPayload(responses[0]);
}

async function statusAndPatch(workspace, taskId) {
  const responses = await callMcp(workspace, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'self_improvement.status', arguments: { task_id: taskId } },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'self_improvement.patch', arguments: { task_id: taskId } },
    },
  ]);
  return { status: textPayload(responses[0]), patch: textPayload(responses[1]) };
}

async function waitForTerminal(workspace, taskId, timeoutMs = 240_000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    latest = (await statusAndPatch(workspace, taskId)).status;
    if (['completed', 'failed', 'cancelled'].includes(latest.status)) {
      return latest;
    }
    await Bun.sleep(500);
  }
  throw new Error(`task ${taskId} did not reach terminal state; latest=${JSON.stringify(latest)}`);
}

async function evalProtocolAndList() {
  const workspace = initRepo('mcp-protocol');
  const started = Date.now();
  try {
    const responses = await callMcp(workspace, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'self_improvement.list_tasks', arguments: { max_results: 2 } },
      },
    ]);
    const tools = responses[1].result.tools.map((tool) => tool.name);
    assertOrThrow(tools.includes('self_improvement.create_task'), 'create_task missing');
    assertOrThrow(tools.includes('self_improvement.list_tasks'), 'list_tasks missing');
    assertOrThrow(Array.isArray(textPayload(responses[2])), 'list_tasks did not return array');
    record('mcp_protocol_and_bounded_list', true, { duration_ms: Date.now() - started }, { tools });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function evalDeterministicPatchApproval() {
  const workspace = initRepo('mcp-deterministic');
  const started = Date.now();
  try {
    const created = await createTask(workspace, {
      spec: 'Append a deterministic MCP eval marker to README so approval proves patch, test, winner, and patch export.',
      coding_command: "sh -lc 'printf mcp-eval-ok >> README.md'",
      tests: ['grep -q mcp-eval-ok README.md'],
      max_rounds: 1,
    });
    const status = await waitForTerminal(workspace, created.task_id);
    const { patch } = await statusAndPatch(workspace, created.task_id);
    assertOrThrow(status.status === 'completed', `expected completed, got ${status.status}`);
    assertOrThrow(status.winner_variant_id, 'missing winner');
    assertOrThrow(status.variants[0].test_passed === 1, 'test gate did not pass');
    assertOrThrow(patch.includes('mcp-eval-ok'), 'patch missing marker');
    record('deterministic_patch_approval', true, {
      duration_ms: Date.now() - started,
      files_changed: status.files_changed.length,
      rounds: status.variants[0].rounds_used,
    }, { task_id: created.task_id, patch_sha256: status.patch_sha256 });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function evalFailureNoChanges() {
  const workspace = initRepo('mcp-failure');
  const started = Date.now();
  try {
    const created = await createTask(workspace, {
      spec: 'Do not change anything; this eval should prove the MCP rejects no-op coding outputs.',
      coding_command: "sh -lc 'true'",
      tests: ['test -f SHOULD_NOT_EXIST'],
      max_rounds: 1,
    });
    const status = await waitForTerminal(workspace, created.task_id);
    assertOrThrow(status.status === 'failed', `expected failed, got ${status.status}`);
    assertOrThrow(status.failure === 'no_approved_variant', `unexpected failure ${status.failure}`);
    assertOrThrow(status.variants[0].files_changed.length === 0, 'no-op produced changed files');
    record('no_change_failure_gate', true, {
      duration_ms: Date.now() - started,
      rounds: status.variants[0].rounds_used,
    }, { task_id: created.task_id, failure: status.failure });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function evalUntrackedNewFileApproval() {
  const workspace = initRepo('mcp-new-file');
  const started = Date.now();
  try {
    const created = await createTask(workspace, {
      spec: 'Create LATENCY_SMOKE.txt containing latency-ok so the eval proves untracked new files are exported.',
      coding_command: "sh -lc 'printf latency-ok > LATENCY_SMOKE.txt'",
      tests: ['grep -q latency-ok LATENCY_SMOKE.txt'],
      max_rounds: 1,
    });
    const status = await waitForTerminal(workspace, created.task_id);
    const { patch } = await statusAndPatch(workspace, created.task_id);
    assertOrThrow(status.status === 'completed', `expected completed, got ${status.status}`);
    assertOrThrow(status.files_changed.includes('LATENCY_SMOKE.txt'), 'new file missing from files_changed');
    assertOrThrow(!status.files_changed.some((name) => name.startsWith('.self-improvement-')), 'MCP artifacts leaked into files_changed');
    assertOrThrow(patch.includes('LATENCY_SMOKE.txt'), 'patch missing new file');
    assertOrThrow(!patch.includes('.self-improvement-prompt.md'), 'prompt artifact leaked into patch');
    record('untracked_new_file_approval', true, {
      duration_ms: Date.now() - started,
      files_changed: status.files_changed.length,
    }, { task_id: created.task_id, patch_sha256: status.patch_sha256 });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function evalOpencodeNewFileApproval() {
  const opencode = sh('command -v opencode', repoRoot);
  if (!opencode.ok || process.env.SKIP_OPENCODE_EVAL === '1') {
    record('opencode_new_file_approval', true, { skipped: 1 }, { reason: 'opencode unavailable or skipped' });
    return;
  }

  const workspace = initRepo('mcp-opencode');
  const started = Date.now();
  try {
    const created = await createTask(workspace, {
      spec: 'Create a file named LATENCY_SMOKE.txt containing exactly the text latency-ok. Do not change any other file.',
      tests: ['grep -q latency-ok LATENCY_SMOKE.txt'],
      max_rounds: 1,
      coding_timeout_ms: 120_000,
    }, 180_000);
    const status = await waitForTerminal(workspace, created.task_id, 180_000);
    const { patch } = await statusAndPatch(workspace, created.task_id);
    assertOrThrow(status.status === 'completed', `expected completed, got ${status.status}`);
    assertOrThrow(status.files_changed.length === 1 && status.files_changed[0] === 'LATENCY_SMOKE.txt', `unexpected files ${status.files_changed}`);
    assertOrThrow(patch.includes('latency-ok'), 'patch missing opencode content');
    record('opencode_new_file_approval', true, {
      duration_ms: Date.now() - started,
      files_changed: status.files_changed.length,
    }, { task_id: created.task_id, patch_sha256: status.patch_sha256 });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const outDir = join(repoRoot, '.evolve', 'evals');
  mkdirSync(outDir, { recursive: true });
  const evals = [
    evalProtocolAndList,
    evalDeterministicPatchApproval,
    evalFailureNoChanges,
    evalUntrackedNewFileApproval,
    evalOpencodeNewFileApproval,
  ];

  for (const evalFn of evals) {
    try {
      await evalFn();
    } catch (error) {
      record(evalFn.name, false, {}, { error: String(error.stack || error) });
    }
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const summary = {
    suite: 'self-improvement-mcp',
    passed,
    failed,
    total: results.length,
    success_rate: passed / results.length,
    results,
  };
  const outputPath = join(outDir, `self-improvement-mcp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  console.error(`wrote ${outputPath}`);
  if (failed > 0) process.exit(1);
}

main();
