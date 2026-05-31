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
const SECRET_PATH_RE = /(^|\/)(\.env(\.|$)|.*\.(pem|key|p12|pfx|keystore|wallet)|id_rsa|id_ed25519|secrets?\.json|credentials?\.json)$/i;
const SECRET_TEXT_RE = /(api[_-]?key|private[_-]?key|secret|seed phrase|mnemonic|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{24,}/i;

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

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rng, range) {
  return (rng() * 2 - 1) * range;
}

function seedFor(runId, intent, index) {
  const hex = createHash('sha256').update(`${runId}|${intent}|${index}`).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function repairHarness(harness) {
  const baseline = defaultBacktestConfig().harness;
  if (!Array.isArray(harness.entry_rules) || harness.entry_rules.length === 0) {
    harness.entry_rules = cloneJson(baseline.entry_rules);
  }
  if (!Array.isArray(harness.exit_rules) || harness.exit_rules.length === 0) {
    harness.exit_rules = cloneJson(baseline.exit_rules);
  }
  if (!harness.position_sizing || typeof harness.position_sizing !== 'object') {
    harness.position_sizing = cloneJson(baseline.position_sizing);
  }
  harness.entry_threshold = clamp(Number(harness.entry_threshold ?? baseline.entry_threshold), 0.05, 0.95);
  harness.max_positions = Math.round(clamp(Number(harness.max_positions ?? baseline.max_positions), 1, 10));
  return harness;
}

function mutateHarness(parent, seed, intent) {
  const child = repairHarness(cloneJson(parent));
  child.version = Number(parent.version || 1) + 1;
  const rng = makeRng(seed);
  const lower = String(intent || '').toLowerCase();
  const conservative = lower.includes('conservative') || lower.includes('safer') || lower.includes('drawdown') || lower.includes('risk');
  const aggressive = lower.includes('aggressive') || lower.includes('higher return') || lower.includes('more trades');
  const kinds = [
    'entry_threshold',
    'rsi_threshold',
    'rsi_period',
    'ema_periods',
    'stop_loss',
    'take_profit',
    'position_size',
    'rule_weight',
    'max_positions',
  ];
  const kind = conservative
    ? kinds[Math.floor(rng() * Math.min(kinds.length, 7))]
    : aggressive
      ? kinds[Math.floor(rng() * kinds.length)]
      : kinds[Math.floor(rng() * kinds.length)];

  if (kind === 'entry_threshold') {
    const direction = conservative ? 1 : aggressive ? -1 : 0;
    child.entry_threshold = clamp(child.entry_threshold + direction * 0.03 + jitter(rng, 0.12), 0.05, 0.95);
  } else if (kind === 'rsi_threshold') {
    for (const rule of child.entry_rules) {
      if (rule.signal?.type !== 'rsi') continue;
      if (rule.condition?.type === 'below') {
        rule.condition.threshold = clamp(Number(rule.condition.threshold) + jitter(rng, 8), 5, 45);
      } else if (rule.condition?.type === 'above') {
        rule.condition.threshold = clamp(Number(rule.condition.threshold) + jitter(rng, 8), 55, 95);
      }
      break;
    }
  } else if (kind === 'rsi_period') {
    for (const rule of child.entry_rules) {
      if (rule.signal?.type !== 'rsi') continue;
      rule.signal.period = Math.round(clamp(Number(rule.signal.period) + jitter(rng, 4), 5, 50));
      break;
    }
  } else if (kind === 'ema_periods') {
    for (const rule of child.entry_rules) {
      if (rule.signal?.type !== 'ema_cross') continue;
      const shortPeriod = Math.round(clamp(Number(rule.signal.short_period) + jitter(rng, 3), 3, 50));
      const longPeriod = Math.round(clamp(Number(rule.signal.long_period) + jitter(rng, 5), 10, 200));
      if (shortPeriod < longPeriod) {
        rule.signal.short_period = shortPeriod;
        rule.signal.long_period = longPeriod;
      }
      break;
    }
  } else if (kind === 'stop_loss') {
    for (const exit of child.exit_rules) {
      if (exit.type !== 'stop_loss') continue;
      const bias = conservative ? -0.4 : aggressive ? 0.4 : 0;
      exit.pct = clamp(Number(exit.pct) + bias + jitter(rng, 2), 1, 15);
      break;
    }
  } else if (kind === 'take_profit') {
    for (const exit of child.exit_rules) {
      if (exit.type !== 'take_profit') continue;
      const bias = conservative ? -0.8 : aggressive ? 1.2 : 0;
      exit.pct = clamp(Number(exit.pct) + bias + jitter(rng, 4), 2, 30);
      break;
    }
  } else if (kind === 'position_size' && child.position_sizing.method === 'fixed_fraction') {
    const bias = conservative ? -0.02 : aggressive ? 0.02 : 0;
    child.position_sizing.fraction = clamp(Number(child.position_sizing.fraction) + bias + jitter(rng, 0.04), 0.02, 0.4);
  } else if (kind === 'rule_weight' && child.entry_rules.length > 0) {
    const rule = child.entry_rules[Math.floor(rng() * child.entry_rules.length)];
    if (rule) rule.weight = clamp(Number(rule.weight || 0.1) + jitter(rng, 0.3), 0.05, 1.0);
  } else if (kind === 'max_positions') {
    const bias = conservative ? -1 : aggressive ? 1 : 0;
    child.max_positions = Math.round(clamp(Number(child.max_positions) + bias + Math.round(jitter(rng, 2)), 1, 10));
  }

  return repairHarness(child);
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
      else if (SECRET_PATH_RE.test(relative(root, path))) continue;
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

function validatePatchForExport(patch, files) {
  const sensitiveFiles = files.filter((file) => SECRET_PATH_RE.test(file));
  if (sensitiveFiles.length > 0) {
    throw new Error(`refusing to export self-improvement patch containing secret-like paths: ${sensitiveFiles.join(', ')}`);
  }
  if (SECRET_TEXT_RE.test(patch)) {
    throw new Error('refusing to export self-improvement patch containing secret-like material');
  }
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

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envNumber(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function riskBudgetRequest(intent) {
  const lower = String(intent || '').toLowerCase();
  const prediction = lower.includes('prediction') || lower.includes('polymarket') || lower.includes('kalshi');
  const urgent = lower.includes('urgent') || lower.includes('breaking') || lower.includes('now') || lower.includes('fast');
  return {
    strategy_class: process.env.SELF_IMPROVEMENT_STRATEGY_CLASS || 'self_improvement_candidate',
    market_type: process.env.SELF_IMPROVEMENT_MARKET_TYPE || (prediction ? 'prediction_market' : 'directional'),
    instrument_type: process.env.SELF_IMPROVEMENT_INSTRUMENT_TYPE || (prediction ? 'binary_prediction' : undefined),
    venue: process.env.SELF_IMPROVEMENT_VENUE || (prediction ? 'polymarket' : undefined),
    target_protocol: process.env.SELF_IMPROVEMENT_TARGET_PROTOCOL || (prediction ? 'polymarket_clob' : undefined),
    opportunity_half_life_secs: envNumber('SELF_IMPROVEMENT_OPPORTUNITY_HALF_LIFE_SECS') || (urgent || prediction ? 900 : undefined),
    user_posture: process.env.SELF_IMPROVEMENT_USER_POSTURE || (urgent ? 'aggressive' : 'balanced'),
    certified_strategy: envBool('SELF_IMPROVEMENT_CERTIFIED_STRATEGY', false),
    allow_live_probe: envBool('SELF_IMPROVEMENT_ALLOW_LIVE_PROBE', true),
    prefer_shadow: envBool('SELF_IMPROVEMENT_PREFER_SHADOW', false),
    max_live_probe_notional_usd: process.env.SELF_IMPROVEMENT_MAX_LIVE_PROBE_NOTIONAL_USD || undefined,
    max_live_probe_loss_usd: process.env.SELF_IMPROVEMENT_MAX_LIVE_PROBE_LOSS_USD || undefined,
    max_live_probe_trades: envNumber('SELF_IMPROVEMENT_MAX_LIVE_PROBE_TRADES'),
    ttl_seconds: envNumber('SELF_IMPROVEMENT_RISK_BUDGET_TTL_SECS'),
  };
}

function promotionScore(promotion) {
  const result = promotion?.result || {};
  const train = result.train || {};
  const test = result.test || {};
  const trainCandidate = train.candidate?.stats || {};
  const testCandidate = test.candidate?.stats || {};
  const sharpeDelta = Number(train.sharpe_delta || 0) + Number(test.sharpe_delta || 0);
  const drawdownPenalty = Math.max(0, Number(train.drawdown_delta || 0)) + Math.max(0, Number(test.drawdown_delta || 0));
  const returnBonus = Number(trainCandidate.total_return_pct || 0) + Number(testCandidate.total_return_pct || 0);
  const tradeBonus = Number(trainCandidate.n_trades || 0) + Number(testCandidate.n_trades || 0);
  const passBonus = result.should_promote && !result.likely_overfit ? 1_000 : 0;
  return passBonus + sharpeDelta * 100 + returnBonus * 0.1 + tradeBonus * 0.01 - drawdownPenalty * 10;
}

async function probeCandidate(current, candidate, token, trainPct, minPaperTrades, maxPaperDrawdownPct, riskBudget) {
  const response = await apiCall('POST', '/evolution/promotion-gate', {
    current,
    candidate,
    token,
    train_pct: trainPct,
    min_paper_trades: minPaperTrades,
    max_paper_drawdown_pct: maxPaperDrawdownPct,
    risk_budget: riskBudget,
  });
  return response.status >= 200 && response.status < 300
    ? { ok: true, status: response.status, data: response.data, score: promotionScore(response.data) }
    : { ok: false, status: response.status, data: response.data, score: Number.NEGATIVE_INFINITY };
}

async function selectCandidate(runId, intent, current) {
  const populationSize = Math.max(1, Math.min(Number(process.env.SELF_IMPROVEMENT_POPULATION_SIZE || 16), 64));
  const token = process.env.SELF_IMPROVEMENT_TOKEN || 'ETH';
  const trainPct = Number(process.env.SELF_IMPROVEMENT_TRAIN_PCT || 0.7);
  const minPaperTrades = Number(process.env.SELF_IMPROVEMENT_MIN_PAPER_TRADES || 20);
  const maxPaperDrawdownPct = Number(process.env.SELF_IMPROVEMENT_MAX_PAPER_DRAWDOWN_PCT || 10);
  const riskBudget = riskBudgetRequest(intent);
  const probes = [];

  for (let i = 0; i < populationSize; i += 1) {
    const candidate = {
      ...cloneJson(current),
      harness: mutateHarness(current.harness, seedFor(runId, intent, i), intent),
    };
    let probe;
    try {
      probe = await probeCandidate(current, candidate, token, trainPct, minPaperTrades, maxPaperDrawdownPct, riskBudget);
    } catch (error) {
      probe = { ok: false, status: 0, data: String(error.message || error), score: Number.NEGATIVE_INFINITY };
    }
    probes.push({
      index: i,
      candidate,
      status: probe.status,
      ok: probe.ok,
      score: probe.score,
      should_promote: Boolean(probe.data?.result?.should_promote),
      likely_overfit: Boolean(probe.data?.result?.likely_overfit),
      blockers: Array.isArray(probe.data?.blockers) ? probe.data.blockers : [],
    });
  }

  const successful = probes.filter((probe) => probe.ok);
  const backtestPassers = successful.filter((probe) => probe.should_promote && !probe.likely_overfit);
  const pool = backtestPassers.length > 0 ? backtestPassers : successful;
  const winner = (pool.length > 0 ? pool : probes).sort((a, b) => b.score - a.score)[0];
  return {
    population_size: populationSize,
    token,
    train_pct: trainPct,
    min_paper_trades: minPaperTrades,
    max_paper_drawdown_pct: maxPaperDrawdownPct,
    risk_budget: riskBudget,
    selected_index: winner?.index ?? null,
    backtest_passers: backtestPassers.length,
    probes: probes.map(({ candidate, ...probe }) => ({
      ...probe,
      harness_version: candidate.harness.version,
      entry_threshold: candidate.harness.entry_threshold,
      max_positions: candidate.harness.max_positions,
    })),
    current,
    candidate: winner?.candidate || {
      ...cloneJson(current),
      harness: mutateHarness(current.harness, seedFor(runId, intent, 0), intent),
    },
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

async function recordSelfImprove(intent, snapshot, analyst, candidateSearch) {
  const patch = currentPatch();
  const files = changedFiles();
  validatePatchForExport(patch, files);
  const response = await apiCall('POST', '/evolution/self-improve', {
    user_intent: intent,
    current: candidateSearch.current,
    candidate: candidateSearch.candidate,
    token: candidateSearch.token,
    train_pct: candidateSearch.train_pct,
    min_paper_trades: candidateSearch.min_paper_trades,
    max_paper_drawdown_pct: candidateSearch.max_paper_drawdown_pct,
    risk_budget: candidateSearch.risk_budget,
    sandbox_mutation: {
      base_snapshot_id: snapshot.snapshot_id,
      patch,
      patch_sha256: sha256(patch),
      files_changed: files,
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
  const candidateSearch = await selectCandidate(runId, intent, defaultBacktestConfig());
  const snapshot = await createSnapshot(intent);
  const selfImprove = await recordSelfImprove(intent, snapshot, analyst, candidateSearch);
  const report = {
    run_id: runId,
    created_at: nowIso(),
    intent,
    package_status: { available: packageStatus.available, missing: packageStatus.missing },
    analyst,
    candidate_search: {
      population_size: candidateSearch.population_size,
      selected_index: candidateSearch.selected_index,
      backtest_passers: candidateSearch.backtest_passers,
      risk_budget: candidateSearch.risk_budget,
      probes: candidateSearch.probes,
    },
    snapshot,
    self_improve: selfImprove,
  };
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
