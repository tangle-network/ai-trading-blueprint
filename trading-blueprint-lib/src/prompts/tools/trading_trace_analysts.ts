// In-sandbox trading trace analysts.
//
// Product adapter for the agent-eval analyst pattern: each profile asks one
// hard, general trajectory question (mandate alignment, loss attribution,
// falsification, opportunity cost) against a compact digest of the bot's own
// artifacts, through the same OpenAI-compatible model the sidecar already
// configures (OPENCODE_MODEL_*). Findings land in the FindingsStore JSONL that
// self-improvement-loop.ts consumes AND in the observatory ideas ledger, so a
// genuine trajectory critique — not regex tick-skip noise — drives candidate
// generation and delegation.
//
// When @tangle-network/agent-eval is resolvable in the sandbox, findings are
// shaped to its AnalystFinding envelope so the package-backed analyst loop can
// consume them unchanged; when it is not (the live-fleet fallback mode), the
// same JSONL append path keeps the loop alive with zero package dependencies.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
function requireTool(primary, fallback) {
  try {
    return require(primary);
  } catch (error) {
    if (fallback && error && error.code === 'MODULE_NOT_FOUND' && String(error.message || '').includes(primary)) {
      return require(fallback);
    }
    throw error;
  }
}

const { apiCall, loadConfig } = requireTool('./api-client.js', './api_client.js');
const { recordUsageEvent } = requireTool('./usage-telemetry.js', './usage_telemetry.js');

const ROOT = process.env.AGENT_WORKSPACE || '/home/agent';
const FINDINGS_FILE = join(ROOT, '.evolve', 'findings', 'findings.jsonl');
const ROTATION_FILE = join(ROOT, '.evolve', 'findings', 'analyst-rotation.json');
const IDEAS_FILE = join(ROOT, 'observatory', 'ideas.jsonl');
const HARNESS_PATH = join(ROOT, 'config', 'harness.json');
const DECISION_LOG_FILE = join(ROOT, 'logs', 'decisions.jsonl');
const DECISION_CONTEXTS_FILE = join(ROOT, 'memory', 'decision-contexts.jsonl');
const REFLECTIONS_FILE = join(ROOT, 'memory', 'reflections.jsonl');
const INSIGHTS_FILE = join(ROOT, 'memory', 'insights.jsonl');
const METRICS_LATEST_FILE = join(ROOT, 'metrics', 'latest.json');

// Hard ceiling on the model-visible trajectory digest: a blown-out digest is a
// cost bug, not a quality feature. Sections are budgeted individually below.
const DIGEST_MAX_CHARS = Math.min(
  Number(process.env.TRACE_ANALYST_DIGEST_MAX_CHARS) > 0 ? Number(process.env.TRACE_ANALYST_DIGEST_MAX_CHARS) : 8000,
  16000,
);
const MODEL_TIMEOUT_MS = Number(process.env.TRACE_ANALYST_TIMEOUT_MS) > 0 ? Number(process.env.TRACE_ANALYST_TIMEOUT_MS) : 90_000;
const MAX_COMPLETION_TOKENS = 1200;
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(path, max = 50) {
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - max)).map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// --- analyst profiles ------------------------------------------------------
// General trajectory questions, deliberately strategy-agnostic: the bot is the
// intelligence; the analyst's job is to ask the question a sharp human reviewer
// would ask of the full trajectory.

const ANALYST_PROFILES = [
  {
    id: 'mandate-alignment',
    title: 'Mandate alignment',
    question:
      'Given the user mandate and the recent decisions and trades in this digest, is the agent actually pursuing the '
      + 'mandate? Identify the single largest divergence between what the mandate asks for and what the trajectory '
      + 'shows the agent doing (or not doing). Quote the specific decisions/trades that prove the divergence.',
  },
  {
    id: 'loss-attribution',
    title: 'Loss attribution',
    question:
      'Which decisions in this trajectory lost money or degraded NAV? For the worst one, reconstruct what the agent '
      + 'observed before acting and judge whether the loss was bad luck (sound process, adverse outcome) or bad '
      + 'process (the information available already argued against the action). Name the process defect if there is one.',
  },
  {
    id: 'falsification',
    title: 'Thesis falsification',
    question:
      'State the strategy\'s implicit thesis as one falsifiable claim (what market behavior must hold for this harness '
      + 'to make money). What evidence already in this trajectory contradicts that claim? Propose the single cheapest '
      + 'experiment (paper-only, measurable within days) that would kill the thesis fastest if it is wrong.',
  },
  {
    id: 'opportunity-cost',
    title: 'Opportunity cost',
    question:
      'What did the agent NOT do that the mandate allowed? Look for idle capital, venues or assets in the allowed '
      + 'universe that were never touched, repeated skips where the stated reason had stopped being true, and signals '
      + 'the agent observed but never acted on. Quantify the largest missed allowance where the digest permits.',
  },
];

// --- model plumbing --------------------------------------------------------

function modelEnv() {
  const baseUrl = stringOrNull(process.env.OPENCODE_MODEL_BASE_URL) || stringOrNull(process.env.TANGLE_ROUTER_BASE_URL);
  const apiKey = stringOrNull(process.env.OPENCODE_MODEL_API_KEY);
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: stringOrNull(process.env.OPENCODE_MODEL_NAME) || 'glm-4.7',
  };
}

async function chatCompletion(env, systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({
        model: env.model,
        temperature: 0.2,
        max_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`model endpoint ${response.status}: ${clip(raw, 300)}`);
    }
    const body = JSON.parse(raw);
    const content = body?.choices?.[0]?.message?.content;
    if (!stringOrNull(content)) throw new Error('model returned an empty completion');
    return { content, usage: body.usage && typeof body.usage === 'object' ? body.usage : {} };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelFinding(content) {
  const stripped = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    // Keep the critique even when the model ignored the JSON contract: a prose
    // finding is still evidence; only the structured extras degrade.
    return {
      finding: clip(stripped, 1200),
      severity: 'medium',
      evidence_refs: [],
      proposed_action: null,
      falsifiable_prediction: null,
      confidence: 0.5,
      structured: false,
    };
  }
  const severity = SEVERITIES.includes(String(parsed.severity || '').toLowerCase())
    ? String(parsed.severity).toLowerCase()
    : 'medium';
  const evidence = Array.isArray(parsed.evidence_refs)
    ? parsed.evidence_refs.slice(0, 8).map((ref) => {
      if (typeof ref === 'string') return { kind: 'artifact', uri: clip(ref, 200) };
      if (ref && typeof ref === 'object') {
        return {
          kind: stringOrNull(ref.kind) || 'artifact',
          uri: clip(ref.uri || ref.ref || '', 200),
          excerpt: ref.excerpt ? clip(ref.excerpt, 240) : undefined,
        };
      }
      return null;
    }).filter((ref) => ref && ref.uri)
    : [];
  const confidence = numberOrNull(parsed.confidence);
  return {
    finding: clip(stringOrNull(parsed.finding) || stripped, 1200),
    severity,
    evidence_refs: evidence,
    proposed_action: stringOrNull(parsed.proposed_action) ? clip(parsed.proposed_action, 500) : null,
    falsifiable_prediction: stringOrNull(parsed.falsifiable_prediction) ? clip(parsed.falsifiable_prediction, 400) : null,
    confidence: confidence != null ? Math.min(1, Math.max(0, confidence)) : 0.6,
    structured: true,
  };
}

// --- trajectory digest -----------------------------------------------------

function mandateFor(config) {
  const contexts = readJsonl(DECISION_CONTEXTS_FILE, 3);
  const mandate = contexts.at(-1)?.mandate;
  const prompt = stringOrNull(mandate?.user_prompt)
    || stringOrNull(config?.strategy_config?.user_prompt)
    || stringOrNull(config?.user_prompt)
    || stringOrNull(config?.prompt)
    || null;
  return {
    prompt: prompt ? clip(prompt, 600) : null,
    strategy_type: stringOrNull(mandate?.strategy_type) || stringOrNull(config?.strategy_type),
  };
}

function compactDecision(decision) {
  return {
    t: decision.timestamp || decision.created_at || null,
    action: clip(decision.action || decision.decision || 'unknown', 40),
    reason: clip(decision.reason || decision.rationale || '', 140),
    ...(decision.pnl_usd != null ? { pnl_usd: decision.pnl_usd } : {}),
    ...(decision.token ? { token: clip(decision.token, 16) } : {}),
  };
}

function compactTrade(trade) {
  return {
    t: trade.timestamp || null,
    action: clip(trade.action || '', 30),
    pair: `${clip(trade.token_in || '', 20)}>${clip(trade.token_out || '', 20)}`,
    notional_usd: trade.notional_usd ?? null,
    filled_price_usd: trade.filled_price_usd ?? null,
    slippage_bps: trade.slippage_bps ?? null,
    status: trade.execution_status ?? null,
    paper: trade.paper_trade === true,
  };
}

function navSummary(snapshots) {
  const values = snapshots
    .map((snap) => numberOrNull(snap.account_value_usd ?? snap.nav_usd ?? snap.account_value))
    .filter((value) => value != null);
  if (values.length === 0) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return {
    points: values.length,
    first_usd: first,
    last_usd: last,
    min_usd: Math.min(...values),
    max_usd: Math.max(...values),
    return_pct: first > 0 ? Number((((last - first) / first) * 100).toFixed(3)) : null,
    max_drawdown_pct: Math.max(
      0,
      ...snapshots.map((snap) => numberOrNull(snap.drawdown_pct) || 0),
    ),
  };
}

async function bestEffortApi(method, path) {
  try {
    const response = await apiCall(method, path);
    return response.status >= 200 && response.status < 300 ? response.data : null;
  } catch {
    return null;
  }
}

async function buildTrajectoryDigest(config) {
  const decisions = readJsonl(DECISION_LOG_FILE, 30).map(compactDecision);
  const reflections = readJsonl(REFLECTIONS_FILE, 5).map((reflection) => ({
    t: reflection.created_at || null,
    findings: (Array.isArray(reflection.findings) ? reflection.findings : [])
      .slice(0, 4)
      .map((finding) => ({ code: clip(finding.code || '', 60), severity: finding.severity || null, detail: clip(finding.detail || '', 120) })),
  }));
  const insights = readJsonl(INSIGHTS_FILE, 5).map((insight) => clip(insight.insight || insight.summary || insight.text || insight, 160));

  const tradesResponse = await bestEffortApi('GET', '/trades?limit=20');
  const trades = (Array.isArray(tradesResponse?.trades) ? tradesResponse.trades : []).map(compactTrade);
  const metricsResponse = await bestEffortApi('GET', '/metrics/history?limit=200');
  const snapshots = Array.isArray(metricsResponse?.snapshots) ? metricsResponse.snapshots : [];
  const selfImproveResponse = await bestEffortApi('GET', '/evolution/self-improve/runs');
  const selfImproveRuns = (Array.isArray(selfImproveResponse?.runs) ? selfImproveResponse.runs : [])
    .slice(-3)
    .map((run) => ({ status: run.status || null, intent: clip(run.user_intent || '', 140) }));

  const digest = {
    generated_at: nowIso(),
    bot_id: config.bot_id || null,
    mandate: mandateFor(config),
    harness: readJson(HARNESS_PATH, null),
    nav: navSummary(snapshots) || readJson(METRICS_LATEST_FILE, null),
    decisions_last_30: decisions,
    trades_last_20: trades,
    reflections_last_5: reflections,
    insights_last_5: insights,
    self_improve_runs_last_3: selfImproveRuns,
  };

  let text = JSON.stringify(digest);
  if (text.length > DIGEST_MAX_CHARS) {
    // Trim the bulkiest sections first; the mandate and NAV summary stay.
    digest.decisions_last_30 = decisions.slice(-15);
    digest.trades_last_20 = trades.slice(-10);
    digest.reflections_last_5 = reflections.slice(-2);
    digest.insights_last_5 = insights.slice(-2);
    text = JSON.stringify(digest);
  }
  if (text.length > DIGEST_MAX_CHARS) text = text.slice(0, DIGEST_MAX_CHARS);
  return { digest, text };
}

// --- rotation + persistence ------------------------------------------------

function nextProfile(explicitId) {
  if (explicitId) {
    const profile = ANALYST_PROFILES.find((candidate) => candidate.id === explicitId);
    if (!profile) throw new Error(`unknown analyst profile: ${explicitId}`);
    return { profile, rotationIndex: null };
  }
  const state = readJson(ROTATION_FILE, { next_index: 0 });
  const index = Number.isInteger(state.next_index) && state.next_index >= 0 ? state.next_index : 0;
  const profile = ANALYST_PROFILES[index % ANALYST_PROFILES.length];
  return { profile, rotationIndex: index % ANALYST_PROFILES.length };
}

function advanceRotation(rotationIndex, profileId, runId) {
  if (rotationIndex == null) return;
  mkdirSync(dirname(ROTATION_FILE), { recursive: true });
  writeFileSync(ROTATION_FILE, `${JSON.stringify({
    next_index: (rotationIndex + 1) % ANALYST_PROFILES.length,
    last_profile: profileId,
    last_run_id: runId,
    updated_at: nowIso(),
  }, null, 2)}\n`, 'utf8');
}

function toFindingEnvelope({ runId, profile, parsed, model, digestChars, config }) {
  const claim = parsed.finding;
  return {
    schema_version: '1.0.0',
    finding_id: sha256(`trading-trace-analyst|${profile.id}|${claim}`),
    analyst_id: `trading-analyst:${profile.id}`,
    produced_at: nowIso(),
    severity: parsed.severity,
    area: 'trajectory-critique',
    claim,
    question: profile.question,
    confidence: parsed.confidence,
    evidence_refs: parsed.evidence_refs.length
      ? parsed.evidence_refs
      : [{ kind: 'artifact', uri: 'artifact://logs/decisions.jsonl', excerpt: 'trajectory digest' }],
    rationale: `Trajectory critique by ${profile.title} analyst over the last ~30 decisions, trades, NAV series, and mandate.`,
    recommended_action: parsed.proposed_action || 'Review the finding and translate it into the next paper-only harness mutation intent.',
    proposed_action: parsed.proposed_action,
    falsifiable_prediction: parsed.falsifiable_prediction,
    validation_plan: parsed.falsifiable_prediction
      || 'Re-run this analyst profile after the next generation cycle and check whether the cited divergence persists.',
    subject: `trading-trajectory:${config.bot_id || 'unknown'}`,
    metadata: {
      run_id: runId,
      profile: profile.id,
      model,
      digest_chars: digestChars,
      structured_output: parsed.structured,
    },
  };
}

function toObservatoryIdea({ finding, profile, config, runId }) {
  const botId = config.bot_id || 'unknown';
  return {
    idea_id: `idea_${sha256(`${botId}|${profile.id}|${finding.claim}`).slice(7, 25)}`,
    bot_id: botId,
    created_at: nowIso(),
    dedupe_key: `trace-analyst:${botId}:${profile.id}`,
    category: 'trace-analyst',
    finding_code: `trace-${profile.id}`,
    finding_severity: finding.severity,
    title: `${profile.title} critique for ${config.bot_name || botId}`,
    thesis: clip(finding.claim, 500),
    evidence_refs: finding.evidence_refs,
    expected_value: finding.falsifiable_prediction
      || 'Convert a trajectory-level critique into the next measurable harness or behavior change.',
    risk: 'paper_only_until_existing_promotion_gates_pass',
    proposed_action: ['high', 'critical'].includes(finding.severity) ? 'delegate_build' : 'delegate_research',
    status: 'open',
    source_run_id: runId,
  };
}

// --- entry point ------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are a rigorous trading-trajectory analyst reviewing an autonomous trading agent\'s own artifacts. '
  + 'Be specific and adversarial: cite concrete entries from the digest, never invent data not present in it, '
  + 'and prefer one sharp finding over many vague ones. Respond with STRICT JSON only, no markdown fences: '
  + '{"finding": string, "severity": "info"|"low"|"medium"|"high"|"critical", '
  + '"evidence_refs": [{"kind":"artifact","uri":string,"excerpt":string}], '
  + '"proposed_action": string, "falsifiable_prediction": string, "confidence": number}. '
  + 'evidence_refs uris should point at digest sections, e.g. artifact://logs/decisions.jsonl#<timestamp>. '
  + 'falsifiable_prediction must be checkable from future decisions/trades/NAV within days.';

async function runTradingTraceAnalyst({ runId, intent, config, profileId } = {}) {
  const resolvedRunId = runId || `trace-analyst-${Date.now()}`;
  const resolvedConfig = config || loadConfig();
  const env = modelEnv();
  const { profile, rotationIndex } = nextProfile(profileId);

  if (!env) {
    recordUsageEvent({
      surface: 'trading-trace-analyst',
      operation: profile.id,
      run_id: resolvedRunId,
      status: 'skipped_no_model_env',
      success: true,
      metadata: { reason: 'OPENCODE_MODEL_BASE_URL / OPENCODE_MODEL_API_KEY not configured' },
    });
    return { skipped: true, reason: 'no-model-env', profile_id: profile.id, run_id: resolvedRunId };
  }

  const startedAt = Date.now();
  const { text: digestText, digest } = await buildTrajectoryDigest(resolvedConfig);
  const userPrompt = [
    `ANALYST PROFILE: ${profile.title}`,
    `QUESTION: ${profile.question}`,
    intent ? `CURRENT IMPROVEMENT INTENT: ${clip(intent, 300)}` : null,
    'TRAJECTORY DIGEST (JSON):',
    digestText,
  ].filter(Boolean).join('\n\n');

  let completion;
  try {
    completion = await chatCompletion(env, SYSTEM_PROMPT, userPrompt);
  } catch (error) {
    recordUsageEvent({
      surface: 'trading-trace-analyst',
      operation: profile.id,
      run_id: resolvedRunId,
      status: 'failed',
      success: false,
      duration_ms: Date.now() - startedAt,
      input_chars: userPrompt.length,
      metadata: { model: env.model, error: clip(String(error.message || error), 300) },
    });
    return {
      skipped: false,
      error: String(error.message || error),
      profile_id: profile.id,
      run_id: resolvedRunId,
      digest_chars: digestText.length,
    };
  }

  const parsed = parseModelFinding(completion.content);
  const finding = toFindingEnvelope({
    runId: resolvedRunId,
    profile,
    parsed,
    model: env.model,
    digestChars: digestText.length,
    config: resolvedConfig,
  });
  appendJsonl(FINDINGS_FILE, { ...finding, run_id: resolvedRunId });
  const idea = toObservatoryIdea({ finding, profile, config: resolvedConfig, runId: resolvedRunId });
  appendJsonl(IDEAS_FILE, idea);
  advanceRotation(rotationIndex, profile.id, resolvedRunId);

  const usage_event = recordUsageEvent({
    surface: 'trading-trace-analyst',
    operation: profile.id,
    run_id: resolvedRunId,
    status: 'completed',
    success: true,
    duration_ms: Date.now() - startedAt,
    input_chars: userPrompt.length,
    output_chars: completion.content.length,
    usage: completion.usage,
    metadata: {
      model: env.model,
      profile: profile.id,
      severity: finding.severity,
      structured_output: parsed.structured,
      digest_chars: digestText.length,
      digest_counts: {
        decisions: digest.decisions_last_30.length,
        trades: digest.trades_last_20.length,
        reflections: digest.reflections_last_5.length,
      },
    },
  });

  return {
    skipped: false,
    profile_id: profile.id,
    run_id: resolvedRunId,
    finding,
    idea_dedupe_key: idea.dedupe_key,
    digest_chars: digestText.length,
    usage_event,
  };
}

async function status() {
  const env = modelEnv();
  const rotation = readJson(ROTATION_FILE, { next_index: 0 });
  return {
    profiles: ANALYST_PROFILES.map((profile) => profile.id),
    next_profile: ANALYST_PROFILES[(Number(rotation.next_index) || 0) % ANALYST_PROFILES.length].id,
    model_configured: Boolean(env),
    model: env ? env.model : null,
    digest_max_chars: DIGEST_MAX_CHARS,
    findings_path: FINDINGS_FILE,
    ideas_path: IDEAS_FILE,
  };
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  let result;
  if (command === 'run') {
    result = await runTradingTraceAnalyst({ profileId: rest[0] || undefined, intent: rest.slice(1).join(' ').trim() || undefined });
  } else if (command === 'digest') {
    result = (await buildTrajectoryDigest(loadConfig())).digest;
  } else {
    result = await status();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export {
  ANALYST_PROFILES,
  buildTrajectoryDigest,
  modelEnv,
  parseModelFinding,
  runTradingTraceAnalyst,
};

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exit(1);
  });
}
