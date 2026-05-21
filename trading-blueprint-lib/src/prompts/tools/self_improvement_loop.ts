// In-sandbox self-improvement orchestrator for trading agents.
//
// Product adapter only: it runs inside /home/agent, uses the local Trading HTTP
// API, writes local knowledge/findings artifacts, and records sandbox lineage.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { apiCall, loadConfig } = require('./api-client.js');

const ROOT = process.env.AGENT_WORKSPACE || '/home/agent';
const EVOLVE_DIR = join(ROOT, '.evolve');
const FINDINGS_DIR = join(EVOLVE_DIR, 'findings');
const RUNS_DIR = join(EVOLVE_DIR, 'self-improvement');
const TRACE_DIR = join(EVOLVE_DIR, 'traces');
const KNOWLEDGE_ROOT = join(ROOT, '.agent-knowledge');
const HARNESS_PATH = join(ROOT, 'config', 'harness.json');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.sidecar', '.opencode', '.opencode-home', '.evolve']);

function ensureDirs() {
  for (const dir of [FINDINGS_DIR, RUNS_DIR, TRACE_DIR, KNOWLEDGE_ROOT]) mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function workspaceDigest(root = ROOT) {
  const hash = createHash('sha256');
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(path);
    }
  }
  walk(root);
  files.sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function currentPatch() {
  const patch = git(['diff', '--binary', '--', '.']);
  if (patch) return patch;
  const status = git(['status', '--short']);
  if (status) return `Workspace has changes, but no git diff was available.\n\n${status}`;
  return 'No workspace patch was present when this self-improvement run was recorded.';
}

function changedFiles() {
  const out = git(['diff', '--name-only', '--', '.']);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

function defaultBacktestConfig() {
  return {
    initial_capital: '10000',
    harness: readJson(HARNESS_PATH, {
      version: 1,
      entry_rules: [{ signal: { type: 'rsi', period: 5 }, condition: { type: 'below', threshold: 40.0 }, weight: 1.0, tokens: [] }],
      exit_rules: [{ type: 'take_profit', pct: 10.0 }, { type: 'stop_loss', pct: 8.0 }],
      filters: [],
      position_sizing: { method: 'fixed_fraction', fraction: 0.3 },
      entry_threshold: 0.3,
      max_positions: 3,
    }),
    slippage: { model: 'fixed_bps', bps: 5 },
    gas_cost_usd: '1',
    taker_fee_bps: 5,
  };
}

async function loadTanglePackages() {
  const result = { available: false, missing: [], modules: {} };
  for (const [key, specifier] of [
    ['agentEval', '@tangle-network/agent-eval'],
    ['agentRuntime', '@tangle-network/agent-runtime/analyst-loop'],
    ['agentKnowledge', '@tangle-network/agent-knowledge'],
  ]) {
    try {
      result.modules[key] = await import(specifier);
    } catch (error) {
      result.missing.push({ package: specifier, error: String(error.message || error) });
    }
  }
  result.available = result.missing.length === 0;
  return result;
}

function deterministicFinding(runId, intent, config, packageStatus) {
  const claim = packageStatus.available
    ? 'Trading self-improvement loop has Tangle eval/runtime/knowledge packages available in sandbox.'
    : 'Trading self-improvement loop is missing one or more Tangle packages in sandbox.';
  const subject = packageStatus.available
    ? 'agent-knowledge:wiki:trading-self-improvement-loop'
    : 'tool-doc:self-improvement-bootstrap';
  return {
    schema_version: '1.0.0',
    finding_id: sha256(`trading-self-improvement|${subject}|${claim}`),
    analyst_id: 'trading-self-improvement',
    produced_at: nowIso(),
    severity: packageStatus.available ? 'info' : 'high',
    area: packageStatus.available ? 'readiness' : 'dependency-readiness',
    claim,
    confidence: packageStatus.available ? 0.9 : 0.95,
    evidence_refs: [{ kind: 'artifact', uri: 'artifact://config/api.json', excerpt: `bot_id=${config.bot_id || 'unknown'} chain_id=${config.chain_id || 'unknown'}` }],
    rationale: `User intent: ${intent}`,
    recommended_action: packageStatus.available
      ? 'Continue through deterministic backtest, paper-trading, and sandbox revision gates.'
      : 'Install package dependencies from /home/agent/package.json before attempting package-backed analyst loops.',
    validation_plan: 'Run npm install or pnpm install, then bun --bun /home/agent/tools/self-improvement-loop.ts status.',
    subject,
    metadata: { run_id: runId, tangle_packages_available: packageStatus.available, missing: packageStatus.missing },
  };
}

function knowledgeProtocolText(proposals) {
  const blocks = [];
  for (const proposal of proposals || []) {
    for (const block of proposal.writeBlocks || []) {
      blocks.push(`--- FILE: ${block.path} ---\n${block.content}\n--- END FILE ---`);
    }
  }
  return blocks.join('\n\n');
}

async function runPackageAnalystLoop(runId, intent, config, packageStatus) {
  const finding = deterministicFinding(runId, intent, config, packageStatus);
  if (!packageStatus.available) {
    writeFileSync(join(FINDINGS_DIR, 'findings.jsonl'), `${JSON.stringify({ ...finding, run_id: runId })}\n`, { flag: 'a' });
    return { mode: 'fallback-jsonl', findings: [finding], applied_knowledge: [], missing: packageStatus.missing };
  }

  const { FindingsStore } = packageStatus.modules.agentEval;
  const { runAnalystLoop } = packageStatus.modules.agentRuntime;
  const { proposeFromFindings, applyKnowledgeWriteBlocks } = packageStatus.modules.agentKnowledge;
  const registry = {
    list: () => [{ id: 'trading-self-improvement' }],
    run: async () => ({
      findings: [finding],
      per_analyst: [{ analyst_id: 'trading-self-improvement', status: 'completed', findings_count: 1 }],
      total_cost_usd: 0,
    }),
  };

  const result = await runAnalystLoop({
    runId,
    registry,
    inputs: { custom: { 'trading-self-improvement': { intent, config } } },
    findingsStore: new FindingsStore(join(FINDINGS_DIR, 'findings.jsonl')),
    knowledgeAdapter: {
      proposeFromFindings,
      apply: async (proposals) => {
        const protocol = knowledgeProtocolText(proposals);
        return protocol.trim() ? applyKnowledgeWriteBlocks(KNOWLEDGE_ROOT, protocol) : { written: [], warnings: [] };
      },
    },
    autoApply: { knowledge: true, knowledgeConfidenceThreshold: 0.85, improvement: false, improvementConfidenceThreshold: 0.9 },
  });

  return {
    mode: 'tangle-agent-packages',
    findings: result.analystResult.findings,
    applied_knowledge: result.knowledge?.applied || [],
    diff: result.diff,
  };
}

async function createSnapshot(intent) {
  const body = {
    base_repo: process.env.SANDBOX_BASE_REPO || 'tangle-network/ai-trading-blueprint',
    base_ref: git(['rev-parse', '--abbrev-ref', 'HEAD']) || process.env.SANDBOX_BASE_REF || 'sandbox',
    base_commit: git(['rev-parse', 'HEAD']) || process.env.SANDBOX_BASE_COMMIT || 'unknown',
    base_image_digest: process.env.SIDECAR_IMAGE_DIGEST || process.env.SIDECAR_IMAGE || 'unknown',
    workspace_digest: workspaceDigest(ROOT),
    workspace_path: ROOT,
    notes: `self-improvement snapshot for intent: ${intent.slice(0, 180)}`,
  };
  const response = await apiCall('POST', '/evolution/sandbox/snapshot', body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`snapshot failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function recordSelfImprove(intent, snapshot, analyst) {
  const patch = currentPatch();
  const response = await apiCall('POST', '/evolution/self-improve', {
    user_intent: intent,
    current: defaultBacktestConfig(),
    token: process.env.SELF_IMPROVEMENT_TOKEN || 'ETH',
    train_pct: Number(process.env.SELF_IMPROVEMENT_TRAIN_PCT || 0.7),
    sandbox_mutation: {
      base_snapshot_id: snapshot.snapshot_id,
      patch,
      patch_sha256: sha256(patch),
      files_changed: changedFiles(),
      tests: ['bun --bun /home/agent/tools/self-improvement-loop.ts status'],
      status: analyst.mode === 'tangle-agent-packages' ? 'candidate' : 'blocked_dependency_readiness',
    },
  });
  return { status: response.status, data: response.data };
}

async function status() {
  ensureDirs();
  const config = loadConfig();
  const packageStatus = await loadTanglePackages();
  const apiStatus = await apiCall('GET', '/evolution/status').catch((error) => ({ status: 0, data: String(error.message || error) }));
  return {
    ok: packageStatus.available && apiStatus.status >= 200 && apiStatus.status < 300,
    workspace: ROOT,
    bot_id: config.bot_id || null,
    chain_id: config.chain_id || null,
    tangle_packages_available: packageStatus.available,
    missing_packages: packageStatus.missing,
    api_status: apiStatus.status,
    paths: { findings: join(FINDINGS_DIR, 'findings.jsonl'), knowledge_root: KNOWLEDGE_ROOT, runs: RUNS_DIR, traces: TRACE_DIR },
  };
}

async function run(intent) {
  ensureDirs();
  if (!intent || intent.trim().length < 12) throw new Error('intent must be at least 12 non-whitespace characters');
  const runId = `sandbox-self-improve-${Date.now()}`;
  const config = loadConfig();
  const packageStatus = await loadTanglePackages();
  const analyst = await runPackageAnalystLoop(runId, intent, config, packageStatus);
  const snapshot = await createSnapshot(intent);
  const selfImprove = await recordSelfImprove(intent, snapshot, analyst);
  const report = { run_id: runId, created_at: nowIso(), intent, package_status: { available: packageStatus.available, missing: packageStatus.missing }, analyst, snapshot, self_improve: selfImprove };
  writeJson(join(RUNS_DIR, `${runId}.json`), report);
  return report;
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const result = command === 'run' ? await run(rest.join(' ').trim()) : await status();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
