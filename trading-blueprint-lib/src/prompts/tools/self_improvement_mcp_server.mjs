// Local MCP server for sandbox-scoped software improvement tasks.
//
// The trading agent uses this as a controlled executor: each task gets an
// isolated git worktree, a bounded multi-shot coding loop, deterministic gates,
// and durable status/log/patch artifacts. Promotion still goes through the
// trading API's backtest/paper/evolution gates.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const ROOT = process.env.AGENT_WORKSPACE || '/home/agent';
const STATE_DIR = join(ROOT, '.evolve', 'mcp-self-improvement');
const TASKS_DIR = join(STATE_DIR, 'tasks');
const WORKTREE_DIR = join(STATE_DIR, 'worktrees');
const DEFAULT_TESTS = [
  'cargo fmt --check',
  'cargo check -p trading-blueprint-lib',
  'cargo test -p trading-blueprint-lib self_improvement_loop_uses_tangle_agent_packages_and_existing_api --lib',
];

const activeTasks = new Map();

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function taskPath(taskId) {
  return join(TASKS_DIR, `${taskId}.json`);
}

function logPath(taskId) {
  return join(TASKS_DIR, `${taskId}.log`);
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function taskIdFromSpec(spec) {
  return `sit-${Date.now()}-${sha(JSON.stringify(spec))}`;
}

function loadTask(taskId) {
  return JSON.parse(readFileSync(taskPath(taskId), 'utf8'));
}

function saveTask(task) {
  ensureDir(TASKS_DIR);
  writeFileSync(taskPath(task.task_id), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}

function appendLog(taskId, message) {
  ensureDir(TASKS_DIR);
  writeFileSync(logPath(taskId), `[${nowIso()}] ${message}\n`, { flag: 'a' });
}

function sh(command, cwd, options = {}) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makePrompt(task, shot, feedback) {
  return [
    'You are editing a sandboxed copy of ai-trading-blueprint for a trading bot.',
    'Make the smallest correct code change that satisfies the spec.',
    'Do not touch secrets, keys, validator credentials, or live trading funds.',
    'Keep changes tactical and testable. Do not rewrite unrelated surfaces.',
    '',
    `Task id: ${task.task_id}`,
    `Shot: ${shot}/${task.max_shots}`,
    '',
    'Spec:',
    task.spec,
    '',
    task.constraints ? `Constraints:\n${task.constraints}\n` : '',
    feedback ? `Previous shot feedback:\n${feedback}\n` : '',
    'When done, leave the worktree with the intended patch applied.',
  ].join('\n');
}

function createWorktree(task) {
  ensureDir(WORKTREE_DIR);
  const branch = `self-improvement/${task.task_id}`;
  const path = join(WORKTREE_DIR, task.task_id);
  const existing = sh(`git worktree list --porcelain | grep -F "worktree ${path}"`, ROOT);
  if (existing.ok) return path;

  const result = sh(`git worktree add -b ${branch} ${path} HEAD`, ROOT);
  if (!result.ok) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
  }
  return path;
}

function runCodingAgent(task, shot, feedback) {
  const prompt = makePrompt(task, shot, feedback);
  writeFileSync(join(task.worktree_path, '.self-improvement-prompt.md'), prompt, 'utf8');
  const command = task.coding_command || process.env.SELF_IMPROVEMENT_CODING_COMMAND || 'opencode run --print';
  appendLog(task.task_id, `shot ${shot}: starting coding command: ${command}`);
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: task.worktree_path,
      shell: true,
      env: { ...process.env, SELF_IMPROVEMENT_TASK_ID: task.task_id },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      appendLog(task.task_id, `shot ${shot}: coding command exited ${code}`);
      if (stdout.trim()) appendLog(task.task_id, `shot ${shot}: stdout\n${stdout.slice(-8000)}`);
      if (stderr.trim()) appendLog(task.task_id, `shot ${shot}: stderr\n${stderr.slice(-8000)}`);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.stdin.write(prompt);
    child.stdin.end();
    task.child = child;
  });
}

function runTests(task) {
  const results = [];
  for (const command of task.tests) {
    appendLog(task.task_id, `test: ${command}`);
    const result = sh(command, task.worktree_path);
    results.push({ command, ok: result.ok, status: result.status, stdout: result.stdout.slice(-12000), stderr: result.stderr.slice(-12000) });
    appendLog(task.task_id, `test result: ${command} -> ${result.status}`);
    if (!result.ok) break;
  }
  return results;
}

function patchForTask(task) {
  const result = sh('git diff --binary -- .', task.worktree_path);
  return result.stdout || '';
}

function updateTask(task, patch = {}) {
  const clean = { ...task, ...patch };
  delete clean.child;
  saveTask(clean);
  return clean;
}

async function executeTask(initialTask) {
  let task = updateTask(initialTask, { status: 'running', started_at: nowIso() });
  activeTasks.set(task.task_id, task);
  let feedback = '';
  try {
    task.worktree_path = createWorktree(task);
    updateTask(task);
    writeFileSync(join(task.worktree_path, '.self-improvement-spec.md'), task.spec, 'utf8');

    for (let shot = 1; shot <= task.max_shots; shot += 1) {
      task = updateTask(task, { current_shot: shot, status: 'coding' });
      const coding = await runCodingAgent(task, shot, feedback);
      task.shots.push({ shot, phase: 'coding', ok: coding.ok, code: coding.code });
      task = updateTask(task);

      task = updateTask(task, { status: 'testing' });
      const tests = runTests(task);
      const passed = tests.every((result) => result.ok);
      task.shots.push({ shot, phase: 'testing', ok: passed, tests });
      const patch = patchForTask(task);
      task = updateTask(task, {
        patch_sha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
        files_changed: sh('git diff --name-only -- .', task.worktree_path).stdout.split('\n').filter(Boolean),
      });
      if (coding.ok && passed) {
        writeFileSync(join(TASKS_DIR, `${task.task_id}.patch`), patch, 'utf8');
        task = updateTask(task, { status: 'completed', completed_at: nowIso() });
        appendLog(task.task_id, 'task completed');
        activeTasks.delete(task.task_id);
        return;
      }
      feedback = [
        coding.ok ? 'Coding command exited successfully.' : `Coding command failed with code ${coding.code}.`,
        'Failing checks:',
        ...tests.filter((result) => !result.ok).map((result) => `${result.command}\n${result.stderr || result.stdout}`),
      ].join('\n\n');
    }
    task = updateTask(task, { status: 'failed', completed_at: nowIso(), failure: 'max_shots_exhausted' });
  } catch (error) {
    task = updateTask(task, { status: 'failed', completed_at: nowIso(), failure: String(error.message || error) });
    appendLog(task.task_id, `task failed: ${task.failure}`);
  } finally {
    activeTasks.delete(task.task_id);
  }
}

function createTask(args) {
  const spec = String(args.spec || '').trim();
  if (spec.length < 20) throw new Error('spec must be at least 20 characters');
  const task = {
    task_id: taskIdFromSpec(args),
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'queued',
    spec,
    constraints: args.constraints ? String(args.constraints) : '',
    max_shots: Math.max(1, Math.min(Number(args.max_shots || 3), 8)),
    tests: Array.isArray(args.tests) && args.tests.length > 0 ? args.tests.map(String) : DEFAULT_TESTS,
    coding_command: args.coding_command ? String(args.coding_command) : null,
    current_shot: 0,
    shots: [],
    worktree_path: '',
    files_changed: [],
    patch_sha256: null,
  };
  saveTask(task);
  setTimeout(() => {
    executeTask(task).catch((error) => appendLog(task.task_id, `unhandled task error: ${error.stack || error}`));
  }, 0);
  return task;
}

function statusTask(args) {
  return loadTask(String(args.task_id));
}

function listTasks() {
  ensureDir(TASKS_DIR);
  return Array.from(new Set([...activeTasks.keys(), ...spawnSync('sh', ['-lc', `ls ${TASKS_DIR}/*.json 2>/dev/null || true`], { encoding: 'utf8' }).stdout
    .split('\n')
    .filter(Boolean)
    .map((path) => path.split('/').pop().replace(/\.json$/, ''))]))
    .map((taskId) => {
      try {
        const task = loadTask(taskId);
        return { task_id: task.task_id, status: task.status, current_shot: task.current_shot, max_shots: task.max_shots, created_at: task.created_at, worktree_path: task.worktree_path };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function logsTask(args) {
  const path = logPath(String(args.task_id));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function patchTask(args) {
  const taskId = String(args.task_id);
  const saved = join(TASKS_DIR, `${taskId}.patch`);
  if (existsSync(saved)) return readFileSync(saved, 'utf8');
  const task = loadTask(taskId);
  return task.worktree_path ? patchForTask(task) : '';
}

function cancelTask(args) {
  const taskId = String(args.task_id);
  const active = activeTasks.get(taskId);
  if (active?.child) active.child.kill('SIGTERM');
  const task = updateTask(loadTask(taskId), { status: 'cancelled', completed_at: nowIso() });
  activeTasks.delete(taskId);
  return task;
}

function backtestTask(args) {
  const task = loadTask(String(args.task_id));
  if (task.status !== 'completed') throw new Error('task must be completed before backtest');
  const command = args.command ? String(args.command) : 'node /home/agent/tools/self-improvement-loop.mjs status';
  const result = sh(command, task.worktree_path || ROOT);
  appendLog(task.task_id, `backtest command: ${command} -> ${result.status}`);
  return result;
}

function promoteCandidate(args) {
  const task = loadTask(String(args.task_id));
  if (task.status !== 'completed') throw new Error('task must be completed before promotion');
  const patch = patchTask(args);
  const summary = {
    task_id: task.task_id,
    worktree_path: task.worktree_path,
    patch_sha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
    files_changed: task.files_changed,
    tests: task.tests,
    next_step: 'Call /evolution/sandbox/snapshot and /evolution/self-improve from the trading API or self-improvement-loop.mjs run.',
  };
  writeFileSync(join(TASKS_DIR, `${task.task_id}.candidate.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const tools = {
  'self_improvement.create_task': {
    description: 'Create an isolated multi-shot coding task in a git worktree and run compile/test gates before completion.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string' },
        constraints: { type: 'string' },
        max_shots: { type: 'number' },
        tests: { type: 'array', items: { type: 'string' } },
        coding_command: { type: 'string' },
      },
      required: ['spec'],
    },
    handler: createTask,
  },
  'self_improvement.status': { description: 'Get task status.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: statusTask },
  'self_improvement.list_tasks': { description: 'List self-improvement tasks.', inputSchema: { type: 'object', properties: {} }, handler: listTasks },
  'self_improvement.logs': { description: 'Read task logs.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: logsTask },
  'self_improvement.patch': { description: 'Read current or final task patch.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: patchTask },
  'self_improvement.cancel': { description: 'Cancel an active task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: cancelTask },
  'self_improvement.backtest': { description: 'Run a caller-supplied backtest/check command in the completed task worktree.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, command: { type: 'string' } }, required: ['task_id'] }, handler: backtestTask },
  'self_improvement.promote_candidate': { description: 'Produce a promotion summary for a completed task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: promoteCandidate },
};

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message) {
  if (message.method === 'initialize') {
    return rpcResult(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'trading-self-improvement', version: '0.1.0' },
    });
  }
  if (message.method === 'tools/list') {
    return rpcResult(message.id, { tools: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) });
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const tool = tools[name];
    if (!tool) return rpcError(message.id, -32601, `unknown tool: ${name}`);
    const output = await tool.handler(message.params?.arguments || {});
    return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] });
  }
  if (message.id === undefined || message.id === null) return null;
  return rpcError(message.id, -32601, `unknown method: ${message.method}`);
}

ensureDir(TASKS_DIR);
ensureDir(WORKTREE_DIR);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const response = await handle(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    let id = null;
    try {
      id = JSON.parse(line).id ?? null;
    } catch {}
    process.stdout.write(`${JSON.stringify(rpcError(id, -32000, String(error.message || error)))}\n`);
  }
});
