#!/usr/bin/env node
// Agent Observatory artifact writer.
//
// Runs inside a trading bot sandbox. It does not fabricate an LLM run. It
// distills existing runtime evidence into durable Observatory records so the
// operator UI can show what the bot observed, what remains uncertain, what
// ideas are worth acting on, and what cost telemetry exists.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = process.env.AGENT_ROOT || '/home/agent';
const MEMORY_DIR = process.env.AGENT_MEMORY_DIR || path.join(ROOT, 'memory');
const OBSERVATORY_DIR = process.env.AGENT_OBSERVATORY_DIR || path.join(MEMORY_DIR, 'observatory');

const DECISION_CONTEXTS_FILE = process.env.AGENT_DECISION_CONTEXTS_FILE || path.join(MEMORY_DIR, 'decision-contexts.jsonl');
const REFLECTIONS_FILE = process.env.AGENT_REFLECTIONS_FILE || path.join(MEMORY_DIR, 'reflections.jsonl');
const IMPROVEMENT_INTENTS_FILE = process.env.AGENT_IMPROVEMENT_INTENTS_FILE || path.join(MEMORY_DIR, 'improvement-intents.jsonl');
const IMPROVEMENT_DISPATCHES_FILE = process.env.AGENT_IMPROVEMENT_DISPATCHES_FILE || path.join(MEMORY_DIR, 'improvement-dispatches.jsonl');
const DECISION_LOG_FILE = process.env.AGENT_DECISION_LOG || path.join(ROOT, 'logs', 'decisions.jsonl');
const USAGE_TELEMETRY_FILE = process.env.LLM_USAGE_TELEMETRY_PATH || path.join(ROOT, 'telemetry', 'llm-usage.jsonl');

const WORLD_SIGNAL_DIGESTS_FILE = path.join(OBSERVATORY_DIR, 'world-signal-digests.jsonl');
const REFLECTION_RUNS_FILE = path.join(OBSERVATORY_DIR, 'reflection-runs.jsonl');
const IDEAS_FILE = path.join(OBSERVATORY_DIR, 'ideas.jsonl');
const DELEGATED_WORK_FILE = path.join(OBSERVATORY_DIR, 'delegated-work-sessions.jsonl');
const OWNER_FEEDBACK_FILE = path.join(OBSERVATORY_DIR, 'owner-feedback.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function appendJsonl(file, value) {
  ensureParent(file);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  return value;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file, max = 100) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - max)).map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
      } catch {
        return { parse_error: line.slice(0, 300) };
      }
    });
  } catch {
    return [];
  }
}

function readJsonFiles(dir, max = 50) {
  try {
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .slice(-max)
      .map((file) => ({ file, value: readJson(path.join(dir, file), null) }))
      .filter((entry) => entry.value && typeof entry.value === 'object');
  } catch {
    return [];
  }
}

function dedupeBySessionId(sessions, limit = 100) {
  const byId = new Map();
  for (const session of sessions) {
    const sessionId = session && typeof session === 'object' ? session.session_id : null;
    if (!sessionId) continue;
    const existing = byId.get(sessionId);
    if (!existing || timestampMs(session.created_at) >= timestampMs(existing.created_at)) {
      byId.set(sessionId, session);
    }
  }
  return [...byId.values()]
    .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
    .slice(0, limit);
}

function activeDelegationStatus(status) {
  return /dispatch|queued|running|pending|await|open/i.test(String(status || ''));
}

function terminalDelegationStatus(status) {
  return /complete|pass|done|blocked|failed|error|reject|cancel/i.test(String(status || ''));
}

function delegationPressure(sessions, usage) {
  const unique = dedupeBySessionId(sessions, 500);
  const active = unique.filter((session) => activeDelegationStatus(session.status));
  const terminal = unique.filter((session) => terminalDelegationStatus(session.status));
  const byStatus = {};
  const bySource = {};
  for (const session of unique) {
    const status = String(session.status || 'unknown');
    const source = String(session.source || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  const cpus = os.cpus();
  const load1 = os.loadavg()[0] || 0;
  const cpuCount = cpus.length || 1;
  const memoryTotalMb = Math.round(os.totalmem() / 1024 / 1024);
  const memoryFreeMb = Math.round(os.freemem() / 1024 / 1024);
  const cpuPressure = Number((load1 / cpuCount).toFixed(3));
  const pressureLevel = active.length >= 5 || cpuPressure >= 1
    ? 'high'
    : active.length >= 2 || cpuPressure >= 0.7
      ? 'medium'
      : 'low';
  return {
    unique_sessions: unique.length,
    active_sessions: active.length,
    terminal_sessions: terminal.length,
    duplicate_rows_removed: Math.max(0, sessions.length - unique.length),
    by_status: byStatus,
    by_source: bySource,
    usage_reporting_status: usage.reporting_status,
    usage_event_count: usage.event_count,
    total_tokens: usage.total_tokens,
    cost_usd: usage.cost_usd,
    system: {
      load_1m: Number(load1.toFixed(3)),
      cpu_count: cpuCount,
      cpu_pressure: cpuPressure,
      memory_free_mb: memoryFreeMb,
      memory_total_mb: memoryTotalMb,
    },
    pressure_level: pressureLevel,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function last(values) {
  return values.length ? values[values.length - 1] : null;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compact(value, maxString = 900) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}...` : value;
  if (['number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compact(item, maxString));
  if (typeof value !== 'object') return String(value);
  const out = {};
  for (const key of Object.keys(value).slice(0, 36)) {
    if (/token|secret|authorization|api_key|apikey|password|private/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = compact(value[key], maxString);
    }
  }
  return out;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageSummary(events) {
  const sum = (key) => events.reduce((acc, event) => acc + asNumber(event[key], 0), 0);
  const inputTokens = sum('input_tokens');
  const outputTokens = sum('output_tokens');
  const totalTokens = sum('total_tokens') || inputTokens + outputTokens;
  const costUsd = Number(sum('cost_usd').toFixed(8));
  return {
    event_count: events.length,
    reporting_status: events.length === 0
      ? 'not_applicable'
      : events.every((event) => event.token_count_status === 'reported' || event.total_tokens != null || event.input_tokens != null || event.output_tokens != null)
        ? 'reported'
        : 'unreported',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    providers: [...new Set(events.map((event) => event.provider).filter(Boolean))].sort(),
    models: [...new Set(events.map((event) => event.model).filter(Boolean))].sort(),
  };
}

function latestSignalEvidence(context) {
  const evidence = context && typeof context === 'object' ? context.evidence || {} : {};
  const state = context && typeof context === 'object' ? context.checked_state || {} : {};
  const metrics = context && typeof context === 'object' ? context.metrics || {} : {};
  const stateEvidence = state && typeof state === 'object' ? state.external_signal_evidence || {} : {};
  const candidate = evidence.signal_evidence || evidence.external_signal_evidence || stateEvidence || {};
  return {
    checked: Boolean(candidate.checked ?? asNumber(metrics.external_signal_checked, 0) > 0),
    required: Boolean(candidate.required ?? asNumber(metrics.external_signal_required, 0) > 0),
    unavailable: Boolean(candidate.unavailable ?? asNumber(metrics.external_signal_unavailable, 0) > 0),
    source_status: candidate.source_status || null,
    market_signal_count: asNumber(candidate.market_signal_count ?? metrics.market_signal_count, 0),
    external_observation_count: asNumber(candidate.external_observation_count ?? metrics.external_observation_count, 0),
    generated_signal_count: asNumber(candidate.generated_signal_count ?? metrics.signals_generated, 0),
  };
}

function decisionAction(decision) {
  if (!decision || typeof decision !== 'object') return null;
  if (typeof decision.action === 'string') return decision.action;
  if (decision.decision && typeof decision.decision.action === 'string') return decision.decision.action;
  return null;
}

function buildFindings({ contexts, reflections, decisions, usage, signalEvidence, selfImprovementRuns }) {
  const findings = [];
  const latestReflection = last(reflections);
  const reflectionFindings = Array.isArray(latestReflection && latestReflection.findings)
    ? latestReflection.findings
    : [];

  if (contexts.length === 0) {
    findings.push({
      code: 'missing-decision-context',
      severity: 'high',
      summary: 'No DecisionContext records were found in sandbox memory.',
    });
  }
  if (reflections.length === 0) {
    findings.push({
      code: 'missing-runtime-reflection',
      severity: 'high',
      summary: 'No runtime ReflectionRecord records were found in sandbox memory.',
    });
  }
  if (decisions.length === 0) {
    findings.push({
      code: 'missing-decision-log',
      severity: 'medium',
      summary: 'No recent trading decision log was found.',
    });
  }

  const recentSkips = decisions.slice(-5).filter((entry) => decisionAction(entry) === 'skip').length;
  if (recentSkips >= 3) {
    findings.push({
      code: 'repeated-skip',
      severity: 'medium',
      summary: `The last five decision records contain ${recentSkips} skips.`,
    });
  }

  if (signalEvidence.required && signalEvidence.unavailable) {
    findings.push({
      code: 'external-signal-source-unavailable',
      severity: 'high',
      summary: 'The mandate needs external/news/event signal evidence, but the latest tick marked the source unavailable.',
    });
  } else if (signalEvidence.required && !signalEvidence.checked) {
    findings.push({
      code: 'external-signal-not-checked',
      severity: 'high',
      summary: 'The mandate needs external/news/event signal evidence, but the latest tick did not check it.',
    });
  }

  if (usage.reporting_status === 'unreported') {
    findings.push({
      code: 'usage-telemetry-unreported',
      severity: 'medium',
      summary: 'At least one LLM/delegation event exists without complete token reporting.',
    });
  }

  const failedSelfImprovement = selfImprovementRuns.filter((run) => {
    const status = String(run.value?.self_improve?.status || run.value?.status || '').toLowerCase();
    return status.includes('fail') || status.includes('error');
  }).length;
  if (failedSelfImprovement > 0) {
    findings.push({
      code: 'self-improvement-failures-present',
      severity: 'medium',
      summary: `${failedSelfImprovement} recent self-improvement artifact(s) look failed or errored.`,
    });
  }

  for (const finding of reflectionFindings.slice(0, 5)) {
    const code = finding && typeof finding === 'object' ? finding.code : null;
    if (!code || findings.some((existing) => existing.code === code)) continue;
    findings.push({
      code,
      severity: finding.severity || 'medium',
      summary: finding.detail || finding.summary || code,
      source: 'runtime-reflection',
    });
  }

  return findings.slice(0, 10);
}

function ideaFromFinding({ botId, botName, runId, finding, evidenceRefs, timestamp }) {
  if (!finding) return null;
  const isResearch = /signal|news|source|market|world|coverage|research/i.test(finding.code || finding.summary || '');
  const title = isResearch
    ? `Research ${botName || botId} signal gap`
    : `Improve ${botName || botId} operating loop`;
  const idea = {
    idea_id: `idea_${hash({ botId, runId, code: finding.code }).slice(0, 18)}`,
    bot_id: botId,
    created_at: timestamp,
    title,
    thesis: finding.summary,
    evidence_refs: evidenceRefs,
    expected_value: isResearch
      ? 'Give the bot a fresher market/world-model input before it changes trading behavior.'
      : 'Reduce repeated bad operating patterns before proposing a strategy mutation.',
    risk: 'paper_only_until_existing_promotion_gates_pass',
    proposed_action: isResearch ? 'delegate_research' : 'delegate_build',
    status: 'open',
    source_run_id: runId,
  };
  return idea;
}

function buildDelegatedWorkSessions({ botId, ideas, dispatches, mcpTasks, runtimeRuns }) {
  const sessions = [];
  for (const dispatch of dispatches.slice(-10)) {
    sessions.push({
      session_id: `delegated_${hash({ botId, dispatch }).slice(0, 18)}`,
      bot_id: botId,
      source: 'improvement-dispatch',
      status: 'dispatched',
      created_at: dispatch.timestamp || null,
      idea_id: null,
      task_id: dispatch.intent_id || null,
      summary: dispatch.prompt || dispatch.intent_id || 'Improvement intent dispatched.',
      artifact_ref: dispatch.decision_context_id ? `artifact://memory/decision-contexts.jsonl#${dispatch.decision_context_id}` : null,
    });
  }
  for (const { file, value } of mcpTasks.slice(-10)) {
    sessions.push({
      session_id: value.task_id || `mcp_${file.replace(/\.json$/, '')}`,
      bot_id: botId,
      source: 'self-improvement-mcp',
      status: value.status || 'unknown',
      created_at: value.created_at || value.started_at || null,
      idea_id: null,
      task_id: value.task_id || null,
      summary: value.spec || value.prompt || 'Self-improvement MCP task.',
      artifact_ref: `artifact://mcp-self-improvement/tasks/${file}`,
    });
  }
  for (const { file, value } of runtimeRuns.slice(-10)) {
    sessions.push({
      session_id: value.run_id || `runtime_${file.replace(/\.json$/, '')}`,
      bot_id: botId,
      source: 'runtime-self-improvement',
      status: value.self_improve?.data?.run?.status || value.status || 'unknown',
      created_at: value.created_at || null,
      idea_id: null,
      task_id: value.run_id || null,
      summary: value.intent || value.self_improve?.data?.run?.user_intent || 'Runtime self-improvement run.',
      artifact_ref: `artifact://self-improvement/${file}`,
    });
  }

  if (sessions.length === 0 && ideas.length > 0) {
    sessions.push({
      session_id: `pending_${ideas[0].idea_id}`,
      bot_id: botId,
      source: 'observatory-idea',
      status: 'awaiting_owner_feedback',
      created_at: ideas[0].created_at,
      idea_id: ideas[0].idea_id,
      task_id: null,
      summary: 'Idea is ready for owner review; no delegated work has been launched.',
      artifact_ref: `artifact://observatory/ideas#${ideas[0].idea_id}`,
    });
  }

  return dedupeBySessionId(sessions, 20);
}

function buildObservatoryRun() {
  const timestamp = nowIso();
  const botId = process.env.BOT_ID || process.env.TRADING_BOT_ID || 'unknown-bot';
  const botName = process.env.BOT_NAME || process.env.TRADING_BOT_NAME || botId;
  const trigger = process.env.OBSERVATORY_TRIGGER || 'manual';
  const requestedBy = process.env.OBSERVATORY_REQUESTED_BY || null;

  const contexts = readJsonl(DECISION_CONTEXTS_FILE, 60);
  const reflections = readJsonl(REFLECTIONS_FILE, 60);
  const decisions = readJsonl(DECISION_LOG_FILE, 80);
  const intents = readJsonl(IMPROVEMENT_INTENTS_FILE, 80);
  const dispatches = readJsonl(IMPROVEMENT_DISPATCHES_FILE, 80);
  const feedback = readJsonl(OWNER_FEEDBACK_FILE, 80);
  const usageEvents = readJsonl(USAGE_TELEMETRY_FILE, 300);
  const mcpTasks = readJsonFiles(path.join(ROOT, '.evolve', 'mcp-self-improvement', 'tasks'), 30);
  const runtimeRuns = readJsonFiles(path.join(ROOT, '.evolve', 'self-improvement'), 30);

  const latestContext = last(contexts);
  const latestReflection = last(reflections);
  const signalEvidence = latestSignalEvidence(latestContext);
  const usage = usageSummary(usageEvents);
  const runId = `obs_${hash({ botId, timestamp, trigger, latestContextId: latestContext && latestContext.context_id }).slice(0, 20)}`;

  const worldSignalDigest = {
    digest_id: `digest_${hash({ botId, runId, signalEvidence }).slice(0, 18)}`,
    bot_id: botId,
    created_at: timestamp,
    source_status: signalEvidence.source_status
      || (signalEvidence.unavailable ? 'unavailable' : signalEvidence.checked ? 'checked' : signalEvidence.required ? 'missing' : 'not_required'),
    freshness: latestContext?.run_completed_at || latestContext?.timestamp || null,
    confidence: signalEvidence.checked && !signalEvidence.unavailable ? 'medium' : signalEvidence.required ? 'low' : 'not_required',
    source_count: signalEvidence.market_signal_count + signalEvidence.external_observation_count + signalEvidence.generated_signal_count,
    signals: [
      signalEvidence.market_signal_count > 0 ? {
        kind: 'market',
        count: signalEvidence.market_signal_count,
        summary: `${signalEvidence.market_signal_count} market signal(s) were present in the latest decision context.`,
      } : null,
      signalEvidence.external_observation_count > 0 ? {
        kind: 'external',
        count: signalEvidence.external_observation_count,
        summary: `${signalEvidence.external_observation_count} external observation(s) were present in the latest decision context.`,
      } : null,
    ].filter(Boolean),
    unavailable_reason: signalEvidence.unavailable ? signalEvidence.source_status || 'source_unavailable' : null,
    evidence_ref: latestContext?.context_id ? `artifact://memory/decision-contexts.jsonl#${latestContext.context_id}` : null,
  };

  const findings = buildFindings({
    contexts,
    reflections,
    decisions,
    usage,
    signalEvidence,
    selfImprovementRuns: runtimeRuns,
  });
  const evidenceRefs = [
    latestContext?.context_id ? `artifact://memory/decision-contexts.jsonl#${latestContext.context_id}` : null,
    latestReflection?.reflection_id ? `artifact://memory/reflections.jsonl#${latestReflection.reflection_id}` : null,
    usage.event_count > 0 ? 'artifact://telemetry/llm-usage.jsonl' : null,
  ].filter(Boolean);

  const primaryIdea = ideaFromFinding({
    botId,
    botName,
    runId,
    finding: findings[0],
    evidenceRefs,
    timestamp,
  });
  const ideas = primaryIdea ? [primaryIdea] : [];
  const delegatedWorkSessions = buildDelegatedWorkSessions({
    botId,
    ideas,
    dispatches,
    mcpTasks,
    runtimeRuns,
  });
  const workPressure = delegationPressure(delegatedWorkSessions, usage);

  const reflectionRun = {
    run_id: runId,
    bot_id: botId,
    bot_name: botName,
    created_at: timestamp,
    trigger,
    requested_by: requestedBy,
    mode: 'deterministic-observatory',
    world_model_questions: [
      'What am I not doing?',
      'What is not working well enough?',
      'What process should change?',
      'What external information would improve my world model?',
      'What should be delegated instead of done inline?',
    ],
    evidence: {
      decision_context_count: contexts.length,
      reflection_count: reflections.length,
      decision_count: decisions.length,
      open_improvement_intent_count: intents.filter((intent) => !['resolved', 'discarded'].includes(intent.status)).length,
      delegated_work_count: workPressure.unique_sessions,
      active_delegated_work_count: workPressure.active_sessions,
      delegation_pressure: workPressure,
      latest_context: compact(latestContext),
      latest_reflection: compact(latestReflection),
      world_signal_digest_id: worldSignalDigest.digest_id,
    },
    conclusions: findings.length > 0
      ? findings.map((finding) => finding.summary)
      : ['No immediate operating gap was found from current deterministic evidence.'],
    uncertainties: [
      contexts.length === 0 ? 'No current DecisionContext is available.' : null,
      usage.reporting_status === 'unreported' ? 'Some model usage lacks complete token/cost reporting.' : null,
      signalEvidence.required && !signalEvidence.checked ? 'External signal coverage is not proven.' : null,
    ].filter(Boolean),
    findings,
    idea_ids: ideas.map((idea) => idea.idea_id),
    delegated_session_ids: delegatedWorkSessions.map((session) => session.session_id),
    delegation_pressure: workPressure,
    usage_summary: usage,
  };

  appendJsonl(WORLD_SIGNAL_DIGESTS_FILE, worldSignalDigest);
  appendJsonl(REFLECTION_RUNS_FILE, reflectionRun);
  for (const idea of ideas) appendJsonl(IDEAS_FILE, idea);
  const existingDelegatedIds = new Set(readJsonl(DELEGATED_WORK_FILE, 1000).map((session) => session.session_id).filter(Boolean));
  for (const session of delegatedWorkSessions) {
    if (existingDelegatedIds.has(session.session_id)) continue;
    appendJsonl(DELEGATED_WORK_FILE, session);
    existingDelegatedIds.add(session.session_id);
  }

  return {
    schema_version: 1,
    bot_id: botId,
    created_at: timestamp,
    trigger,
    records_written: {
      world_signal_digest_id: worldSignalDigest.digest_id,
      reflection_run_id: reflectionRun.run_id,
      idea_ids: ideas.map((idea) => idea.idea_id),
      delegated_session_ids: delegatedWorkSessions.map((session) => session.session_id),
    },
    records: {
      world_signal_digests: [worldSignalDigest],
      reflection_runs: [reflectionRun],
      ideas,
      delegated_work_sessions: delegatedWorkSessions,
      owner_feedback: feedback.slice(-20),
      usage_summary: usage,
      delegation_pressure: workPressure,
    },
  };
}

function main() {
  const result = buildObservatoryRun();
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildObservatoryRun,
  usageSummary,
  readJsonl,
  latestSignalEvidence,
  buildFindings,
};
