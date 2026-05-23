// Sandbox-local auto-dev subset exposed as an MCP server.
//
// This intentionally duplicates the company auto-dev shape inside the trading
// bot sandbox without depending on company-private tooling. A task is a small
// code-change experiment: create isolated git worktrees, drive one or more
// coding-agent variants through multiple feedback rounds, run deterministic
// gates, optionally run a reviewer command, select a winner, and return a patch
// candidate for the trading bot to backtest/promote through /evolution/*.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

function defaultRoot() {
  try {
    if (statSync('/home/agent').isDirectory()) return '/home/agent';
  } catch {}
  return process.cwd();
}

const ROOT = process.env.AGENT_WORKSPACE || defaultRoot();
const STATE_DIR = join(ROOT, '.evolve', 'mcp-self-improvement');
const TASKS_DIR = join(STATE_DIR, 'tasks');
const WORKTREE_DIR = join(STATE_DIR, 'worktrees');
function defaultCodingCommand() {
  if (process.env.SELF_IMPROVEMENT_CODING_COMMAND) return process.env.SELF_IMPROVEMENT_CODING_COMMAND;
  if (process.env.SIDECAR_DEFAULT_HARNESS === 'gemini') {
    return 'sh -lc \'gemini --skip-trust --yolo -p "$(cat)"\'';
  }
  return 'sh -lc \'opencode run --dangerously-skip-permissions "$(cat)"\'';
}

const DEFAULT_CODING_COMMAND = defaultCodingCommand();
const DEFAULT_REVIEW_COMMAND = process.env.SELF_IMPROVEMENT_REVIEW_COMMAND || '';
const DEFAULT_TESTS = [
  'cargo fmt --check',
  'cargo check -p trading-blueprint-lib',
  'cargo test -p trading-blueprint-lib self_improvement_loop_uses_tangle_agent_packages_and_existing_api --lib',
];
const TERMINAL_VARIANT_STATES = new Set(['approved', 'errored', 'retired']);
const activeTasks = new Map();

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function sha(text, len = 16) {
  return createHash('sha256').update(text).digest('hex').slice(0, len);
}

function sanitizeSlug(value) {
  return String(value || 'variant')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'variant';
}

function taskIdFromSpec(spec) {
  return `sit-${Date.now()}-${sha(JSON.stringify(spec))}`;
}

function taskPath(taskId) {
  return join(TASKS_DIR, `${taskId}.json`);
}

function logPath(taskId) {
  return join(TASKS_DIR, `${taskId}.log`);
}

function patchPath(taskId) {
  return join(TASKS_DIR, `${taskId}.patch`);
}

function loadTask(taskId) {
  return JSON.parse(readFileSync(taskPath(taskId), 'utf8'));
}

function saveTask(task) {
  ensureDir(TASKS_DIR);
  task.updated_at = nowIso();
  const clean = JSON.parse(JSON.stringify(task));
  writeFileSync(taskPath(task.task_id), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return clean;
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
    maxBuffer: options.maxBuffer || 30 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs || undefined,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function git(command, cwd = ROOT) {
  return sh(`git ${command}`, cwd);
}

function renderTemplate(command, values) {
  let out = String(command || '');
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(String(value ?? ''));
  }
  return out;
}

function parseHarnesses(args) {
  const raw = Array.isArray(args.harnesses) && args.harnesses.length > 0
    ? args.harnesses
    : [{ id: 'default', coding_command: args.coding_command || DEFAULT_CODING_COMMAND }];
  return raw.map((item, index) => {
    if (typeof item === 'string') {
      return { id: sanitizeSlug(item || `variant-${index + 1}`), coding_command: item };
    }
    const id = sanitizeSlug(item.id || item.name || `variant-${index + 1}`);
    return {
      id,
      coding_command: String(item.coding_command || item.command || args.coding_command || DEFAULT_CODING_COMMAND),
    };
  });
}

function createVariant(task, harness) {
  const variantId = `${task.task_id}-${harness.id}`;
  return {
    variant_id: variantId,
    harness_id: harness.id,
    coding_command: harness.coding_command,
    branch_name: `self-improvement/${variantId}`,
    worktree_path: join(WORKTREE_DIR, task.task_id, harness.id),
    state: 'queued',
    rounds_used: 0,
    current_feedback: '',
    base_sha: task.base_sha,
    head_sha: null,
    diff_additions: 0,
    diff_deletions: 0,
    files_changed: [],
    patch_sha256: null,
    review_state: null,
    review_readiness: null,
    test_passed: null,
    errored_reason: null,
    shots: [],
  };
}

function ensureWorktree(task, variant) {
  ensureDir(join(WORKTREE_DIR, task.task_id));
  const existing = git(`worktree list --porcelain | grep -F "worktree ${variant.worktree_path}"`, ROOT);
  if (existing.ok) return;
  const result = git(
    `worktree add -b ${variant.branch_name} ${variant.worktree_path} ${task.base_sha}`,
    ROOT,
  );
  if (!result.ok) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout || result.error}`);
  }
}

function diffPatch(variant) {
  return git(`diff --binary ${variant.base_sha} -- .`, variant.worktree_path).stdout || '';
}

function diffNameOnly(variant) {
  const out = git(`diff --name-only ${variant.base_sha} -- .`, variant.worktree_path).stdout || '';
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function diffStats(variant) {
  const out = git(`diff --shortstat ${variant.base_sha} -- .`, variant.worktree_path).stdout || '';
  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(out);
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(out);
  return {
    additions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

function headSha(variant) {
  const result = git('rev-parse HEAD', variant.worktree_path);
  return result.ok ? result.stdout.trim() : null;
}

function makeCodingPrompt(task, variant, round) {
  return [
    'You are a principal/L8-level, lead-driven software engineer and security-minded coding agent working inside a sandboxed copy of ai-trading-blueprint.',
    'Operate like a 10x IC: own the outcome, choose the shortest correct path, remove ambiguity with code/tests, and deliver one small production-quality patch that is correct, reviewable, and proven by real checks.',
    '',
    '# Execution context',
    `Worktree: ${variant.worktree_path}`,
    `Branch: ${variant.branch_name}`,
    `Task: ${task.task_id}`,
    `Variant: ${variant.variant_id}`,
    `Round: ${round}/${task.max_rounds}`,
    '',
    '# Requested change',
    task.spec,
    '',
    task.constraints ? `# Constraints\n${task.constraints}\n` : '',
    '# Required working process',
    '1. Inspect the relevant code before editing. Prefer existing local patterns, helpers, naming, tests, and module boundaries.',
    '2. Identify the core design decision before editing. Make it explicit in the patch shape: what boundary owns the behavior, what invariants must hold, and what proof demonstrates it.',
    '3. Define the smallest coherent patch that satisfies the requested change. Do not broaden scope, rewrite unrelated code, or introduce speculative abstractions.',
    '4. Treat trading, vault, signature, key-management, sandbox, and deployment code as security-sensitive. Preserve fund isolation, chain/domain separation, validator trust boundaries, replay resistance, and least privilege.',
    '5. If the request is underspecified or unsafe, make the safest narrow improvement that can be proven locally and leave explicit notes in the final response. Do not invent live-trading capability.',
    '6. Add or update focused tests when behavior changes. Tests must exercise the real code path available in this worktree; do not add hollow assertions, sleeps, snapshots, stubs, or mocks that avoid the behavior being claimed.',
    '7. Run the requested checks and any nearby focused checks that are necessary to prove correctness. Fix failures caused by your patch.',
    '8. Review your own diff before finishing. Remove debug code, generated artifacts, unrelated formatting churn, secrets, credentials, temporary files, and broad refactors.',
    '',
    '# Anti-patterns that fail this task',
    '- Fake software: code that only satisfies string checks, dead code, unused APIs, no-op wrappers, placeholder TODOs, or behavior that is not wired into the real path.',
    '- Fake proof: tests that mock away the important behavior, assert implementation trivia only, skip silently, depend on timing luck, or would pass if the feature were broken.',
    '- Scope drift: broad rewrites, new frameworks, new services, or architecture pivots not required for the requested change.',
    '- Security regression: weaker validation, unchecked external input, replayable signatures, chain-agnostic signing where chain specificity is required, key leakage, or broader fund movement authority.',
    '- Sloppy implementation: duplicated logic without reason, unbounded state growth, hidden global side effects, swallowed errors, noisy logs, or unclear ownership boundaries.',
    '- Verbose performance: large slow scans or network calls on hot paths when a bounded/local approach would prove the same outcome.',
    '',
    '# Hard boundaries',
    '- Work only inside this worktree.',
    '- Do not touch live keys, secrets, validator credentials, vault funds, private env files, or deployment credentials.',
    '- Do not weaken validation, signature verification, replay protection, slippage/risk checks, auth, sandbox isolation, or promotion gates.',
    '- Do not mark work complete by documentation-only changes unless the request is explicitly documentation-only.',
    '- Do not push branches and do not open PRs.',
    '- Do not edit MCP-generated files such as .self-improvement-prompt.md or .self-improvement-spec.md except as incidental local artifacts.',
    '',
    '# Completion contract',
    '- Leave the intended patch applied in the worktree.',
    '- The patch must be understandable from git diff alone.',
    '- The implementation should be as succinct as possible while preserving clarity and correctness.',
    '- In your final message, summarize files changed, real tests/checks run, residual risks, and anything intentionally not done.',
    '',
    variant.current_feedback ? `# Feedback from previous round\n${variant.current_feedback}\n` : '',
  ].join('\n');
}

function runCodingAgent(task, variant, round) {
  const prompt = makeCodingPrompt(task, variant, round);
  writeFileSync(join(variant.worktree_path, '.self-improvement-prompt.md'), prompt, 'utf8');
  appendLog(task.task_id, `${variant.variant_id}: round ${round} coding command: ${variant.coding_command}`);
  return new Promise((resolve) => {
    const child = spawn(variant.coding_command, {
      cwd: variant.worktree_path,
      shell: true,
      env: {
        ...process.env,
        SELF_IMPROVEMENT_TASK_ID: task.task_id,
        SELF_IMPROVEMENT_VARIANT_ID: variant.variant_id,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeTasks.get(task.task_id).children.set(variant.variant_id, child);
    const timeout = setTimeout(() => {
      appendLog(task.task_id, `${variant.variant_id}: coding timed out after ${task.coding_timeout_ms}ms`);
      child.kill('SIGTERM');
    }, task.coding_timeout_ms);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      activeTasks.get(task.task_id)?.children.delete(variant.variant_id);
      appendLog(task.task_id, `${variant.variant_id}: coding exited ${code ?? signal ?? 'unknown'}`);
      if (stdout.trim()) appendLog(task.task_id, `${variant.variant_id}: stdout\n${stdout.slice(-10000)}`);
      if (stderr.trim()) appendLog(task.task_id, `${variant.variant_id}: stderr\n${stderr.slice(-10000)}`);
      resolve({ ok: code === 0, code: code ?? signal, stdout, stderr });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function runTests(task, variant) {
  const results = [];
  for (const command of task.test_commands) {
    appendLog(task.task_id, `${variant.variant_id}: test ${command}`);
    const result = sh(command, variant.worktree_path, { timeoutMs: task.test_timeout_ms });
    results.push({
      command,
      ok: result.ok,
      status: result.status,
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000),
      error: result.error,
    });
    if (!result.ok) break;
  }
  return results;
}

function runReviewer(task, variant) {
  if (!task.reviewer_command) {
    return {
      ok: true,
      approved: true,
      recommendation: 'skipped',
      readiness: 100,
      feedback: '',
    };
  }
  const command = renderTemplate(task.reviewer_command, {
    root: ROOT,
    worktree: variant.worktree_path,
    base: variant.base_sha,
    head: variant.head_sha || 'HEAD',
    task_id: task.task_id,
    variant_id: variant.variant_id,
  });
  appendLog(task.task_id, `${variant.variant_id}: reviewer ${command}`);
  const result = sh(command, variant.worktree_path, { timeoutMs: task.review_timeout_ms });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const recommendation = parsed?.recommendation || parsed?.validation?.recommendation || (result.ok ? 'ship' : 'error');
  const readiness = Number(parsed?.readiness || parsed?.validation?.merge_readiness || (result.ok ? 100 : 0));
  const approved = result.ok && ['ship', 'approve-with-nits', 'approved'].includes(String(recommendation));
  return {
    ok: result.ok,
    approved,
    recommendation,
    readiness,
    feedback: text.slice(-12000),
  };
}

function buildFeedback(coding, tests, review, variant) {
  const parts = [];
  if (!coding.ok) parts.push(`Coding command failed with exit ${coding.code}.\n${coding.stderr || coding.stdout}`);
  if (variant.files_changed.length === 0) parts.push('No code changes were produced. Make a real patch or explain why no change is needed in code/tests.');
  const failed = tests.filter((result) => !result.ok);
  if (failed.length > 0) {
    parts.push(`Failing deterministic checks:\n${failed.map((result) => `${result.command}\n${result.stderr || result.stdout || result.error || ''}`).join('\n\n')}`);
  }
  if (review && !review.approved) {
    parts.push(`Reviewer feedback (${review.recommendation}, readiness ${review.readiness}):\n${review.feedback}`);
  }
  return parts.join('\n\n').slice(-16000);
}

function updateVariantFromDiff(variant) {
  git('add -N .', variant.worktree_path);
  git('reset -q -- .self-improvement-prompt.md .self-improvement-spec.md', variant.worktree_path);
  const stats = diffStats(variant);
  const patch = diffPatch(variant);
  variant.diff_additions = stats.additions;
  variant.diff_deletions = stats.deletions;
  variant.files_changed = diffNameOnly(variant);
  variant.patch_sha256 = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
  variant.head_sha = headSha(variant);
  return patch;
}

async function driveVariant(task, variant) {
  try {
    variant.state = 'spawning';
    saveTask(task);
    ensureWorktree(task, variant);
    writeFileSync(join(variant.worktree_path, '.self-improvement-spec.md'), task.spec, 'utf8');

    for (let round = variant.rounds_used + 1; round <= task.max_rounds; round += 1) {
      variant.rounds_used = round;
      variant.state = 'reviewing';
      saveTask(task);

      const coding = await runCodingAgent(task, variant, round);
      const patch = updateVariantFromDiff(variant);
      const noChanges = patch.trim().length === 0;

      variant.state = 'testing';
      saveTask(task);
      const tests = noChanges ? [] : runTests(task, variant);
      const testsPassed = !noChanges && tests.every((result) => result.ok);
      variant.test_passed = testsPassed ? 1 : 0;

      const review = testsPassed ? runReviewer(task, variant) : null;
      if (review) {
        variant.review_state = review.recommendation;
        variant.review_readiness = review.readiness;
      }

      const approved = coding.ok && testsPassed && (!review || review.approved);
      variant.shots.push({
        round,
        coding_ok: coding.ok,
        coding_exit: coding.code,
        tests,
        review,
        diff_additions: variant.diff_additions,
        diff_deletions: variant.diff_deletions,
        files_changed: variant.files_changed,
      });

      if (approved) {
        variant.state = 'approved';
        appendLog(task.task_id, `${variant.variant_id}: approved at round ${round}`);
        saveTask(task);
        return variant;
      }

      variant.current_feedback = buildFeedback(coding, tests, review, variant);
      variant.state = testsPassed ? 'changes_requested' : 'ci_failed';
      variant.errored_reason = round >= task.max_rounds ? 'out_of_rounds' : null;
      saveTask(task);
    }

    variant.state = 'errored';
    variant.errored_reason = variant.errored_reason || 'out_of_rounds';
    saveTask(task);
    return variant;
  } catch (error) {
    variant.state = 'errored';
    variant.errored_reason = String(error.message || error);
    appendLog(task.task_id, `${variant.variant_id}: failed ${variant.errored_reason}`);
    saveTask(task);
    return variant;
  }
}

function selectWinner(task) {
  const approved = task.variants.filter((variant) => variant.state === 'approved');
  if (approved.length === 0) return null;
  const byDiff = (variant) => (variant.diff_additions || 0) + (variant.diff_deletions || 0);
  const byReadiness = (variant) => Number(variant.review_readiness || 0);
  if (task.selection === 'highest_readiness') {
    return approved.sort((a, b) => byReadiness(b) - byReadiness(a) || byDiff(a) - byDiff(b))[0];
  }
  if (task.selection === 'first_approved') return approved[0];
  return approved.sort((a, b) => byDiff(a) - byDiff(b) || byReadiness(b) - byReadiness(a))[0];
}

async function executeTask(initialTask) {
  const runtime = { children: new Map() };
  activeTasks.set(initialTask.task_id, runtime);
  let task = saveTask({ ...initialTask, status: 'running', started_at: nowIso() });
  try {
    // Keep variant execution sequential for now. The state store is intentionally
    // dependency-free JSON, so concurrent writers would race and lose shot data.
    for (const variant of task.variants) {
      await driveVariant(task, variant);
    }
    task = loadTask(task.task_id);
    const winner = selectWinner(task);
    if (!winner) {
      task.status = 'failed';
      task.completed_at = nowIso();
      task.failure = 'no_approved_variant';
      appendLog(task.task_id, 'task failed: no approved variant');
      saveTask(task);
      return;
    }

    task.winner_variant_id = winner.variant_id;
    task.status = 'completed';
    task.completed_at = nowIso();
    const patch = diffPatch(winner);
    writeFileSync(patchPath(task.task_id), patch, 'utf8');
    task.patch_sha256 = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
    task.files_changed = winner.files_changed;
    task.worktree_path = winner.worktree_path;
    task.test_commands = winner.shots.at(-1)?.tests?.map((test) => test.command) || task.test_commands;
    saveTask(task);
    appendLog(task.task_id, `task completed with winner ${winner.variant_id}`);
  } catch (error) {
    task.status = 'failed';
    task.completed_at = nowIso();
    task.failure = String(error.message || error);
    appendLog(task.task_id, `task failed: ${task.failure}`);
    saveTask(task);
  } finally {
    activeTasks.delete(initialTask.task_id);
  }
}

async function createTask(args) {
  const spec = String(args.spec || args.change || '').trim();
  if (spec.length < 20) throw new Error('spec/change must be at least 20 characters');
  const base = git('rev-parse HEAD', ROOT);
  if (!base.ok) throw new Error(`cannot resolve git HEAD: ${base.stderr || base.stdout}`);
  const taskId = taskIdFromSpec(args);
  const harnesses = parseHarnesses(args);
  const task = {
    task_id: taskId,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'queued',
    spec,
    constraints: args.constraints ? String(args.constraints) : '',
    base_sha: base.stdout.trim(),
    baseline_branch: git('rev-parse --abbrev-ref HEAD', ROOT).stdout.trim() || 'HEAD',
    max_rounds: Math.max(1, Math.min(Number(args.max_rounds || args.max_shots || 3), 8)),
    selection: ['smallest_diff', 'highest_readiness', 'first_approved'].includes(args.selection)
      ? args.selection
      : 'smallest_diff',
    test_commands: Array.isArray(args.tests) && args.tests.length > 0
      ? args.tests.map(String)
      : Array.isArray(args.test_commands) && args.test_commands.length > 0
        ? args.test_commands.map(String)
        : DEFAULT_TESTS,
    coding_timeout_ms: Number(args.coding_timeout_ms || 15 * 60 * 1000),
    test_timeout_ms: Number(args.test_timeout_ms || 20 * 60 * 1000),
    reviewer_command: args.reviewer_command ? String(args.reviewer_command) : DEFAULT_REVIEW_COMMAND,
    review_timeout_ms: Number(args.review_timeout_ms || 15 * 60 * 1000),
    variants: [],
    winner_variant_id: null,
    worktree_path: '',
    files_changed: [],
    patch_sha256: null,
  };
  task.variants = harnesses.map((harness) => createVariant(task, harness));
  saveTask(task);
  if (args.wait_for_completion === true || args.wait_for_completion === 'true') {
    await executeTask(task);
    return summarizeTask(loadTask(task.task_id));
  }
  setTimeout(() => {
    executeTask(task).catch((error) => appendLog(task.task_id, `unhandled task error: ${error.stack || error}`));
  }, 0);
  return summarizeTask(task);
}

function summarizeTask(task) {
  return {
    task_id: task.task_id,
    status: task.status,
    winner_variant_id: task.winner_variant_id,
    max_rounds: task.max_rounds,
    selection: task.selection,
    variants: task.variants.map((variant) => ({
      variant_id: variant.variant_id,
      harness_id: variant.harness_id,
      state: variant.state,
      rounds_used: variant.rounds_used,
      worktree_path: variant.worktree_path,
      files_changed: variant.files_changed,
      diff_total: (variant.diff_additions || 0) + (variant.diff_deletions || 0),
      review_state: variant.review_state,
      review_readiness: variant.review_readiness,
      test_passed: variant.test_passed,
      errored_reason: variant.errored_reason,
    })),
  };
}

function statusTask(args) {
  return loadTask(String(args.task_id));
}

function listTasks(args = {}) {
  ensureDir(TASKS_DIR);
  const maxResults = Math.min(
    Math.max(1, Number(args.max_results || 50)),
    200,
  );
  const out = [];
  const names = readdirSync(TASKS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of names) {
    try {
      out.push(summarizeTask(loadTask(name.replace(/\.json$/, ''))));
    } catch {
      continue;
    }
    if (out.length >= maxResults) break;
  }
  return out;
}

function logsTask(args) {
  const path = logPath(String(args.task_id));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function winningVariant(task) {
  return task.variants.find((variant) => variant.variant_id === task.winner_variant_id)
    || task.variants.find((variant) => variant.state === 'approved')
    || task.variants[0];
}

function patchTask(args) {
  const taskId = String(args.task_id);
  const saved = patchPath(taskId);
  if (existsSync(saved)) return readFileSync(saved, 'utf8');
  const task = loadTask(taskId);
  const variant = args.variant_id
    ? task.variants.find((v) => v.variant_id === String(args.variant_id))
    : winningVariant(task);
  return variant?.worktree_path ? diffPatch(variant) : '';
}

function cancelTask(args) {
  const taskId = String(args.task_id);
  const runtime = activeTasks.get(taskId);
  if (runtime) {
    for (const child of runtime.children.values()) child.kill('SIGTERM');
  }
  const task = loadTask(taskId);
  task.status = 'cancelled';
  task.completed_at = nowIso();
  for (const variant of task.variants) {
    if (!TERMINAL_VARIANT_STATES.has(variant.state)) variant.state = 'retired';
  }
  activeTasks.delete(taskId);
  return saveTask(task);
}

function backtestTask(args) {
  const task = loadTask(String(args.task_id));
  if (task.status !== 'completed') throw new Error('task must be completed before backtest');
  const variant = winningVariant(task);
  const command = args.command ? String(args.command) : 'bun --bun /home/agent/tools/self-improvement-loop.ts status';
  const result = sh(command, variant.worktree_path || ROOT);
  appendLog(task.task_id, `backtest command: ${command} -> ${result.status}`);
  return result;
}

function promoteCandidate(args) {
  const task = loadTask(String(args.task_id));
  if (task.status !== 'completed') throw new Error('task must be completed before promotion');
  const variant = winningVariant(task);
  const patch = patchTask({ task_id: task.task_id, variant_id: variant.variant_id });
  const summary = {
    task_id: task.task_id,
    winner_variant_id: variant.variant_id,
    worktree_path: variant.worktree_path,
    patch_sha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
    files_changed: variant.files_changed,
    tests: task.test_commands,
    next_step: 'Run trading backtests/paper evidence, then call /evolution/sandbox/snapshot and /evolution/self-improve.',
  };
  writeFileSync(join(TASKS_DIR, `${task.task_id}.candidate.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const tools = {
  'self_improvement.create_task': {
    description: 'Create an auto-dev-style task: isolated worktrees, one or more coding variants, multi-round feedback, tests, optional reviewer, winner selection.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string' },
        change: { type: 'string' },
        constraints: { type: 'string' },
        max_rounds: { type: 'number' },
        max_shots: { type: 'number' },
        selection: { type: 'string' },
        tests: { type: 'array', items: { type: 'string' } },
        test_commands: { type: 'array', items: { type: 'string' } },
        coding_timeout_ms: { type: 'number' },
        reviewer_command: { type: 'string' },
        harnesses: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  coding_command: { type: 'string' },
                  command: { type: 'string' },
                },
              },
            ],
          },
        },
        coding_command: { type: 'string' },
        wait_for_completion: { type: 'boolean' },
      },
      required: [],
    },
    handler: createTask,
  },
  'self_improvement.status': { description: 'Get full task status.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: statusTask },
  'self_improvement.list_tasks': { description: 'List task summaries, newest first.', inputSchema: { type: 'object', properties: { max_results: { type: 'number' } } }, handler: listTasks },
  'self_improvement.logs': { description: 'Read task logs.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: logsTask },
  'self_improvement.patch': { description: 'Read winner or variant patch.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, variant_id: { type: 'string' } }, required: ['task_id'] }, handler: patchTask },
  'self_improvement.cancel': { description: 'Cancel an active task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: cancelTask },
  'self_improvement.backtest': { description: 'Run a caller-supplied backtest/check command in the winning worktree.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, command: { type: 'string' } }, required: ['task_id'] }, handler: backtestTask },
  'self_improvement.promote_candidate': { description: 'Produce promotion summary for a completed task.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }, handler: promoteCandidate },
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
      serverInfo: { name: 'trading-self-improvement', version: '0.2.0' },
    });
  }
  if (message.method === 'tools/list') {
    return rpcResult(message.id, {
      tools: Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const tool = tools[name];
    if (!tool) return rpcError(message.id, -32601, `unknown tool: ${name}`);
    const output = await tool.handler(message.params?.arguments || {});
    return rpcResult(message.id, {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    });
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
