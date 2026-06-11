import {
  asRecord,
  formatRunTimestamp,
  getStatusLabel,
  type BotRun,
} from './botRuns';
import { formatNumber } from './format';
import { isExplicitPaperValidationBypass } from './tradeValidation';
import {
  getTradePairLabel,
  VENUE_CONFIG,
  type Trade,
} from './types/trade';

export type DecisionFeedSource = 'run' | 'trade';
export type DecisionFeedTone = 'neutral' | 'success' | 'warning' | 'danger' | 'active';
export type DecisionStageKey = 'state' | 'decision' | 'validation' | 'execution';

export interface RunResultSection {
  title: string;
  items: Array<{ label: string; value: string }>;
}

export interface DecisionFeedFact {
  label: string;
  value: string;
}

export interface DecisionFeedStage {
  key: DecisionStageKey;
  label: string;
  value: string;
  detail?: string;
  tone: DecisionFeedTone;
  iconClass: string;
}

export interface DecisionFeedItem {
  id: string;
  source: DecisionFeedSource;
  sourceId: string;
  title: string;
  subtitle: string;
  timestampMs: number;
  statusLabel: string;
  statusTone: DecisionFeedTone;
  actionLabel: string;
  instrumentLabel: string;
  reason: string;
  notionalLabel?: string;
  venueLabel?: string;
  validationLabel?: string;
  executionLabel?: string;
  provenance: DecisionFeedFact[];
  stages: DecisionFeedStage[];
  sections?: RunResultSection[];
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeUpper(value: string): string {
  const cleaned = humanize(value);
  return cleaned ? cleaned.toUpperCase() : value;
}

export function parseRunResultJson(result: string | null): Record<string, unknown> | null {
  if (!result) return null;

  try {
    return asRecord(JSON.parse(result));
  } catch {
    return null;
  }
}

export function formatResultValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? `${value}` : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return `${value.length}`;
  return null;
}

function countRecords(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? asRecord(value[0]) : null;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function canonicalAgenticHeading(value: string): string {
  const normalized = humanize(value).toLowerCase();
  switch (normalized) {
    case 'observed':
      return 'Observed';
    case 'concern':
      return 'Concern';
    case 'next safe action':
      return 'Next safe action';
    case 'missing evidence':
      return 'Missing evidence';
    default:
      return humanize(value);
  }
}

function agenticAssistantItems(value: unknown): RunResultSection['items'] {
  const text = formatResultValue(value);
  if (!text) return [];

  const headingPattern = /(?:^|\n+)\s*\*\*(Observed|Concern|Next safe action|Missing evidence)\*\*\s*:?\s*/gi;
  const matches = Array.from(text.matchAll(headingPattern));
  if (matches.length === 0) {
    return [{ label: 'Summary', value: stripInlineMarkdown(text) }];
  }

  return matches.flatMap((match, index) => {
    const label = canonicalAgenticHeading(match[1] ?? 'Summary');
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const sectionText = stripInlineMarkdown(text.slice(start, end));
    return sectionText ? [{ label, value: sectionText }] : [];
  });
}

function joinFormattedList(value: unknown, formatter: (entry: unknown, index: number) => string | null): string | null {
  if (!Array.isArray(value)) return null;
  const formatted = value
    .map((entry, index) => formatter(entry, index))
    .filter((entry): entry is string => Boolean(entry));
  return formatted.length > 0 ? formatted.join('\n') : null;
}

function summarizeFinding(value: unknown): string | null {
  const finding = asRecord(value);
  if (!finding) return formatResultValue(value);
  const severity = formatResultValue(finding.severity);
  const summary = formatResultValue(finding.summary);
  const code = formatResultValue(finding.code);
  const prefix = [severity, code].filter(Boolean).join(' / ');
  return [prefix || null, summary].filter(Boolean).join(': ') || null;
}

function summarizeIdea(value: unknown, index: number): string | null {
  const idea = asRecord(value);
  if (!idea) return formatResultValue(value);
  const title = formatResultValue(idea.title) ?? `Idea ${index + 1}`;
  const action = formatResultValue(idea.proposed_action);
  const status = formatResultValue(idea.status);
  return [title, action, status].filter(Boolean).join(' / ');
}

function summarizeDelegatedSession(value: unknown, index: number): string | null {
  const session = asRecord(value);
  if (!session) return formatResultValue(value);
  const summary = formatResultValue(session.summary) ?? `Session ${index + 1}`;
  const status = formatResultValue(session.status);
  const source = formatResultValue(session.source);
  return [summary, status, source].filter(Boolean).join(' / ');
}

function pushObservatorySections(
  sections: RunResultSection[],
  result: Record<string, unknown>,
) {
  const records = asRecord(result.records) ?? result;
  const agentic = asRecord(result.agentic_reflection) ?? asRecord(records.agentic_reflection);
  const latestReflection = firstRecord(records.reflection_runs);
  const pressure = asRecord(records.delegation_pressure) ?? asRecord(latestReflection?.delegation_pressure);
  const usage = asRecord(records.usage_summary) ?? asRecord(latestReflection?.usage_summary);

  if (agentic) {
    const items = agenticAssistantItems(agentic.assistant_text);
    pushResultItem(items, 'Status', agentic.status);
    pushResultItem(items, 'Session', agentic.session_id);
    pushResultItem(items, 'Trace', agentic.trace_id);
    pushResultItem(items, 'Input tok', agentic.input_tokens);
    pushResultItem(items, 'Output tok', agentic.output_tokens);
    pushResultItem(items, 'Cost USD', agentic.cost_usd);
    if (items.length) sections.push({ title: 'Agentic Reflection', items });
  }

  if (latestReflection) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Trigger', latestReflection.trigger);
    pushResultItem(items, 'Mode', latestReflection.mode);
    pushResultItem(items, 'Conclusions', joinFormattedList(latestReflection.conclusions, (entry) => formatResultValue(entry)));
    pushResultItem(items, 'Uncertainties', joinFormattedList(latestReflection.uncertainties, (entry) => formatResultValue(entry)));
    pushResultItem(items, 'Findings', joinFormattedList(latestReflection.findings, summarizeFinding));
    if (items.length) sections.push({ title: 'Reflection Record', items });
  }

  const recordItems: RunResultSection['items'] = [];
  pushResultItem(recordItems, 'World signals', countRecords(records.world_signal_digests));
  pushResultItem(recordItems, 'Reflection runs', countRecords(records.reflection_runs));
  pushResultItem(recordItems, 'Ideas', countRecords(records.ideas));
  pushResultItem(recordItems, 'Research tasks', countRecords(records.research_tasks));
  pushResultItem(recordItems, 'Delegated work', countRecords(records.delegated_work_sessions));
  pushResultItem(recordItems, 'Idea queue', joinFormattedList(records.ideas, summarizeIdea));
  pushResultItem(recordItems, 'Work queue', joinFormattedList(records.delegated_work_sessions, summarizeDelegatedSession));
  if (recordItems.length) sections.push({ title: 'Observatory Records', items: recordItems });

  if (pressure) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Pressure', pressure.pressure_level);
    pushResultItem(items, 'Active', pressure.active_sessions);
    pushResultItem(items, 'Total', pressure.unique_sessions);
    pushResultItem(items, 'Allows new work', pressure.allows_new_delegation);
    pushResultItem(items, 'Deny reasons', joinFormattedList(pressure.deny_reasons, (entry) => formatResultValue(entry)));
    if (items.length) sections.push({ title: 'Delegation Pressure', items });
  }

  if (usage) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Status', usage.reporting_status);
    pushResultItem(items, 'Events', usage.event_count);
    pushResultItem(items, 'Input tok', usage.input_tokens);
    pushResultItem(items, 'Output tok', usage.output_tokens);
    pushResultItem(items, 'Total tok', usage.total_tokens);
    pushResultItem(items, 'Cost USD', usage.cost_usd);
    pushResultItem(items, 'Providers', joinFormattedList(usage.providers, (entry) => formatResultValue(entry)));
    pushResultItem(items, 'Models', joinFormattedList(usage.models, (entry) => formatResultValue(entry)));
    if (items.length) sections.push({ title: 'Usage', items });
  }
}

function getAgenticReflectionText(result: Record<string, unknown> | null): string | null {
  const records = asRecord(result?.records) ?? result;
  const agentic = asRecord(result?.agentic_reflection) ?? asRecord(records?.agentic_reflection);
  const text = formatResultValue(agentic?.assistant_text);
  return text ? stripInlineMarkdown(text) : null;
}

function hasObservatoryResult(result: Record<string, unknown> | null): boolean {
  const records = asRecord(result?.records) ?? result;
  return Boolean(
    asRecord(result?.agentic_reflection)
    || asRecord(records?.agentic_reflection)
    || Array.isArray(records?.reflection_runs)
    || Array.isArray(records?.world_signal_digests)
    || Array.isArray(records?.delegated_work_sessions)
  );
}

export function getRunSignalLabel(run: BotRun): string {
  if (run.error) return 'ERROR';
  const result = parseRunResultJson(run.result);
  if (hasObservatoryResult(result)) return 'REFLECT';
  const decision = asRecord(result?.decision);
  const tradeAction = asRecord(result?.trade_action);
  const setup = asRecord(decision?.setup);
  const candidate =
    formatResultValue(decision?.action) ??
    formatResultValue(setup?.action) ??
    formatResultValue(tradeAction?.execution_status) ??
    formatResultValue(tradeAction?.validation_status);

  if (candidate) return humanizeUpper(candidate);
  return getStatusLabel(run.status).toUpperCase();
}

function pushResultItem(
  items: RunResultSection['items'],
  label: string,
  value: unknown,
) {
  const formatted = formatResultValue(value);
  if (formatted) {
    items.push({ label, value: formatted });
  }
}

function approvalItems(value: unknown): RunResultSection['items'] {
  const items: RunResultSection['items'] = [];
  const approval = asRecord(value);
  if (!approval) {
    pushResultItem(items, 'Approval', value);
    return items;
  }

  pushResultItem(items, 'Status', approval.status);
  pushResultItem(items, 'Verified', approval.verified_corewriter_approval);
  pushResultItem(items, 'API wallet', approval.api_wallet_address);
  pushResultItem(items, 'Vault account', approval.vault_account);
  pushResultItem(items, 'Tx hash', approval.tx_hash);
  pushResultItem(items, 'Extra agents', approval.extra_agents);
  return items;
}

function formatAssetSummary(value: unknown): string | null {
  const asset = asRecord(value);
  if (!asset) return null;

  const symbol = formatResultValue(asset.symbol ?? asset.asset ?? asset.token ?? asset.address);
  const balance = formatResultValue(asset.balance ?? asset.amount ?? asset.quantity);
  const valueUsd = formatResultValue(asset.value_usd ?? asset.notional_usd ?? asset.usd_value);
  const priceUsd = formatResultValue(asset.price_usd ?? asset.mark_price_usd);
  const parts = [
    symbol,
    balance ? `${balance} units` : null,
    valueUsd ? `$${valueUsd}` : null,
    priceUsd ? `price $${priceUsd}` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(' / ') : null;
}

export function buildRunResultSections(result: Record<string, unknown>): RunResultSection[] {
  const sections: RunResultSection[] = [];
  pushObservatorySections(sections, result);
  const checkedState = asRecord(result.checked_state);
  const decision = asRecord(result.decision);
  const setup = asRecord(decision?.setup);
  const fundingAction = asRecord(result.funding_action);
  const approvalAction = asRecord(result.api_wallet_approval_action);
  const approvalResponse = asRecord(approvalAction?.response);
  const tradeAction = asRecord(result.trade_action);

  const timing: RunResultSection['items'] = [];
  pushResultItem(timing, 'Started', result.run_started_at);
  pushResultItem(timing, 'Completed', result.run_completed_at);
  if (timing.length) sections.push({ title: 'Timing', items: timing });

  if (checkedState) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'NAV status', checkedState.nav_status);
    pushResultItem(items, 'Mode', checkedState.mode);
    pushResultItem(items, 'Protocol', checkedState.protocol);
    pushResultItem(items, 'Total NAV USDC', checkedState.total_nav_usdc);
    pushResultItem(items, 'Total NAV USD', checkedState.total_nav_usd);
    pushResultItem(items, 'Total value USD', checkedState.total_value_usd);
    pushResultItem(
      items,
      'Hyperliquid equity USDC',
      checkedState.hyperliquid_equity_usdc,
    );
    pushResultItem(items, 'Perp margin USDC', checkedState.perp_margin_usdc);
    pushResultItem(items, 'WETH held', checkedState.weth_held);
    pushResultItem(items, 'USDC held', checkedState.usdc_held);
    pushResultItem(items, 'WETH price', checkedState.weth_price);
    pushResultItem(items, 'RSI 14', checkedState.rsi_14);
    pushResultItem(items, 'EMA 12', checkedState.ema_12);
    pushResultItem(items, 'EMA 26', checkedState.ema_26);
    pushResultItem(items, 'Candles', checkedState.candles);
    pushResultItem(items, 'Base weight', checkedState.base_weight);
    pushResultItem(items, 'Target base weight', checkedState.target_base_weight);
    pushResultItem(items, 'Rebalance band %', checkedState.rebalance_band_pct);
    pushResultItem(items, 'Positions', checkedState.positions_count);
    pushResultItem(items, 'Open orders', checkedState.open_orders_count);
    if (Array.isArray(checkedState.assets)) {
      checkedState.assets.slice(0, 6).forEach((asset, index) => {
        pushResultItem(items, `Asset ${index + 1}`, formatAssetSummary(asset));
      });
    }
    if (items.length) sections.push({ title: 'Checked State', items });
  }

  if (decision) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Action', decision.action);
    pushResultItem(items, 'Reason', decision.reason);
    pushResultItem(items, 'Setup action', setup?.action);
    pushResultItem(items, 'Asset', setup?.asset);
    pushResultItem(items, 'Amount in', setup?.amount_in);
    pushResultItem(items, 'Rationale', setup?.rationale);
    if (items.length) sections.push({ title: 'Decision', items });

    const approval = approvalItems(decision.approval);
    if (approval.length) sections.push({ title: 'Approval', items: approval });
  }

  if (fundingAction) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Attempted', fundingAction.attempted);
    pushResultItem(items, 'Status', fundingAction.status);
    pushResultItem(items, 'Requested USDC', fundingAction.requested_usdc);
    if (items.length) sections.push({ title: 'Funding', items });
  }

  if (approvalAction) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Attempted', approvalAction.attempted);
    pushResultItem(items, 'Status', approvalAction.status);
    pushResultItem(items, 'Response', approvalResponse?.status);
    pushResultItem(items, 'Verified', approvalResponse?.verified_corewriter_approval);
    pushResultItem(items, 'Tx hash', approvalResponse?.tx_hash);
    if (items.length) {
      sections.push({ title: 'API Wallet Approval Action', items });
    }
  }

  if (tradeAction) {
    const items: RunResultSection['items'] = [];
    pushResultItem(items, 'Attempted', tradeAction.attempted);
    pushResultItem(items, 'Validation status', tradeAction.validation_status);
    pushResultItem(items, 'Execution status', tradeAction.execution_status);
    pushResultItem(items, 'Tx hash', tradeAction.tx_hash);
    pushResultItem(items, 'Paper', tradeAction.paper_trade);
    pushResultItem(items, 'Notional USD', tradeAction.notional_usd);
    pushResultItem(items, 'Protocol', tradeAction.target_protocol);
    pushResultItem(items, 'Token in', tradeAction.token_in);
    pushResultItem(items, 'Token out', tradeAction.token_out);
    if (items.length) sections.push({ title: 'Trade', items });
  }

  return sections;
}

function toneFromStatus(value: string | null | undefined): DecisionFeedTone {
  const normalized = value?.toLowerCase() ?? '';
  if (/(failed|error|reject|denied|invalid|no fill|no_fill)/.test(normalized)) return 'danger';
  if (/(running|submitted|pending|partial|working)/.test(normalized)) return 'active';
  if (/(skip|skipped|none|false|not verified|attempted false)/.test(normalized)) return 'warning';
  if (/(complete|completed|approved|filled|confirmed|executed|fresh|true|pass)/.test(normalized)) return 'success';
  return 'neutral';
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${formatNumber(value / 1_000_000, { maximumFractionDigits: 2 })}M`;
  }
  if (value >= 1_000) {
    return `$${formatNumber(value / 1_000, { maximumFractionDigits: 1 })}K`;
  }
  return `$${formatNumber(value, { maximumFractionDigits: value >= 100 ? 0 : 2 })}`;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNotional(value: unknown): string | undefined {
  const parsed = parseFiniteNumber(value);
  if (parsed != null && parsed > 0) return formatUsd(parsed);
  const formatted = formatResultValue(value);
  return formatted ? `$${formatted}` : undefined;
}

function addFact(facts: DecisionFeedFact[], label: string, value: unknown) {
  const formatted = formatResultValue(value);
  if (formatted) facts.push({ label, value: formatted });
}

function makeStage(
  key: DecisionStageKey,
  label: string,
  value: string | null | undefined,
  detail: string | null | undefined,
  fallbackTone: DecisionFeedTone,
  iconClass: string,
): DecisionFeedStage {
  const displayValue = value && value.length > 0 ? humanize(value) : 'Not captured';
  return {
    key,
    label,
    value: displayValue,
    detail: detail ?? undefined,
    tone: value ? toneFromStatus(value) : fallbackTone,
    iconClass,
  };
}

function runStatusTone(run: BotRun): DecisionFeedTone {
  if (run.status === 'running') return 'active';
  if (run.status === 'completed') return 'success';
  if (run.status === 'interrupted') return 'warning';
  return 'danger';
}

export function buildDecisionItemFromRun(run: BotRun): DecisionFeedItem {
  const parsed = parseRunResultJson(run.result);
  const isObservatory = hasObservatoryResult(parsed);
  const observatoryRecords = asRecord(parsed?.records) ?? parsed;
  const latestReflection = firstRecord(observatoryRecords?.reflection_runs);
  const observatoryPressure =
    asRecord(observatoryRecords?.delegation_pressure)
    ?? asRecord(latestReflection?.delegation_pressure);
  const checkedState = asRecord(parsed?.checked_state);
  const decision = asRecord(parsed?.decision);
  const setup = asRecord(decision?.setup);
  const tradeAction = asRecord(parsed?.trade_action);
  const approval = asRecord(decision?.approval);
  const actionLabel = getRunSignalLabel(run);
  const setupAsset = formatResultValue(setup?.asset);
  const tradeAsset = formatResultValue(tradeAction?.asset ?? tradeAction?.token_out ?? tradeAction?.token_in);
  const protocol = formatResultValue(tradeAction?.target_protocol ?? checkedState?.protocol);
  const validationLabel = formatResultValue(tradeAction?.validation_status ?? approval?.status);
  const executionLabel = formatResultValue(tradeAction?.execution_status);
  const plainResult = parsed ? null : run.result?.trim();
  const agenticText = getAgenticReflectionText(parsed);
  const reason =
    agenticText ??
    formatResultValue(decision?.reason) ??
    formatResultValue(setup?.rationale) ??
    (plainResult && plainResult !== 'No messages.' ? plainResult : null) ??
    run.error ??
    (parsed ? 'Structured result captured' : 'No structured result captured');
  const sections = parsed ? buildRunResultSections(parsed) : [];
  const provenance: DecisionFeedFact[] = [];
  addFact(provenance, 'Cycle', run.runId);
  addFact(provenance, 'Workflow', run.workflowKind);
  addFact(provenance, 'Trace', run.traceId);
  addFact(provenance, 'Session', run.sessionId);
  addFact(provenance, 'Input tok', run.inputTokens);
  addFact(provenance, 'Output tok', run.outputTokens);

  const stateValue =
    (isObservatory ? formatResultValue(observatoryPressure?.pressure_level) : null) ??
    formatResultValue(checkedState?.nav_status) ??
    formatResultValue(checkedState?.mode);
  const decisionValue =
    (isObservatory ? 'reflect' : null) ??
    formatResultValue(decision?.action) ??
    formatResultValue(setup?.action) ??
    (run.error ? 'error' : null);
  const observatoryWorkCount = formatResultValue(observatoryPressure?.active_sessions);
  const tradeAttempted = formatResultValue(tradeAction?.attempted);
  const executionValue =
    (isObservatory && observatoryWorkCount ? `${observatoryWorkCount} active delegations` : null) ??
    executionLabel ??
    (tradeAttempted ? `attempted ${tradeAttempted.toLowerCase()}` : null);

  return {
    id: `run:${run.runId}`,
    source: 'run',
    sourceId: run.runId,
    title: `${actionLabel} / ${getStatusLabel(run.status)}`,
    subtitle: formatRunTimestamp(run.startedAt),
    timestampMs: run.startedAt * 1000,
    statusLabel: getStatusLabel(run.status),
    statusTone: runStatusTone(run),
    actionLabel,
    instrumentLabel: isObservatory
      ? 'Observatory'
      : setupAsset ?? tradeAsset ?? protocol ?? 'Trace',
    reason,
    notionalLabel: formatNotional(tradeAction?.notional_usd ?? setup?.amount_in),
    venueLabel: protocol ?? undefined,
    validationLabel: validationLabel ? humanize(validationLabel) : undefined,
    executionLabel: executionLabel ? humanize(executionLabel) : undefined,
    provenance,
    stages: [
      makeStage('state', 'State', stateValue, protocol, 'neutral', 'i-ph:activity'),
      makeStage('decision', 'Decision', decisionValue, reason, run.error ? 'danger' : 'neutral', 'i-ph:brain'),
      makeStage(
        'validation',
        isObservatory ? 'Pressure' : 'Validation',
        isObservatory ? formatResultValue(observatoryPressure?.allows_new_delegation) : validationLabel,
        isObservatory ? formatResultValue(observatoryPressure?.pressure_level) : null,
        'neutral',
        'i-ph:shield-check',
      ),
      makeStage('execution', isObservatory ? 'Delegation' : 'Execution', executionValue, null, 'neutral', 'i-ph:lightning'),
    ],
    sections,
  };
}

function tradeStatusTone(trade: Trade): DecisionFeedTone {
  if (trade.status === 'executed') return 'success';
  if (trade.status === 'paper' || trade.status === 'pending') return 'active';
  if (trade.status === 'rejected' || trade.status === 'failed') return 'danger';
  return 'neutral';
}

function formatTradeAction(action: Trade['action']): string {
  if (action === 'open_long') return 'LONG';
  if (action === 'close_long') return 'CLOSE LONG';
  if (action === 'open_short') return 'SHORT';
  if (action === 'close_short') return 'CLOSE SHORT';
  return humanizeUpper(action);
}

function formatRunnerSignal(signal: unknown): string | null {
  const formatted = formatResultValue(signal);
  if (formatted) return formatted;
  const record = asRecord(signal);
  if (!record) return null;

  const action = formatResultValue(record.action ?? record.signal ?? record.side);
  const confidence = formatResultValue(record.confidence ?? record.score);
  return [action, confidence ? `score ${confidence}` : null].filter(Boolean).join(' / ') || null;
}

export function buildDecisionItemFromTrade(trade: Trade): DecisionFeedItem {
  const actionLabel = formatTradeAction(trade.action);
  const instrumentLabel = getTradePairLabel(trade);
  const isPaperBypass = isExplicitPaperValidationBypass(trade.validation, trade.paperTrade);
  const validationScore =
    trade.validation?.aggregateScore ??
    trade.validatorScore ??
    null;
  const validationLabel = isPaperBypass
    ? 'Paper — validation bypassed'
    : trade.validation
      ? `${trade.validation.approved ? 'Approved' : 'Rejected'} · ${formatNumber(validationScore ?? 0, { maximumFractionDigits: 2 })}`
      : validationScore != null
        ? `Score ${formatNumber(validationScore, { maximumFractionDigits: 2 })}`
        : undefined;
  const executionLabel = trade.execution?.status
    ? humanize(trade.execution.status)
    : humanize(trade.status);
  const venueLabel = VENUE_CONFIG[trade.venue]?.label ?? humanizeUpper(trade.targetProtocol ?? 'unknown');
  const runnerSignal = formatRunnerSignal(trade.runnerSignal);
  const reason =
    trade.agentReasoning ??
    trade.execution?.reason ??
    trade.validatorReasoning ??
    runnerSignal ??
    'No reason captured';
  const provenance: DecisionFeedFact[] = [];
  addFact(provenance, 'Source', trade.decisionSource);
  addFact(provenance, 'Strategy', trade.strategyModuleId);
  addFact(provenance, 'Revision', trade.revisionId);
  addFact(provenance, 'Candidate', trade.candidateHash);
  addFact(provenance, 'Harness', trade.harnessVersion);
  addFact(provenance, 'Tx', trade.txHash);
  addFact(provenance, 'Protocol', trade.targetProtocol);

  return {
    id: `trade:${trade.id}`,
    source: 'trade',
    sourceId: trade.id,
    title: `${actionLabel} / ${instrumentLabel}`,
    subtitle: new Date(trade.timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    timestampMs: trade.timestamp,
    statusLabel: humanize(trade.status),
    statusTone: tradeStatusTone(trade),
    actionLabel,
    instrumentLabel,
    reason,
    notionalLabel: trade.notionalUsd != null && trade.notionalUsd > 0
      ? formatUsd(trade.notionalUsd)
      : undefined,
    venueLabel,
    validationLabel,
    executionLabel,
    provenance,
    stages: [
      makeStage('state', 'Source', trade.decisionSource, venueLabel, 'neutral', 'i-ph:activity'),
      makeStage('decision', 'Decision', trade.action, reason, 'success', 'i-ph:brain'),
      isPaperBypass
        ? {
            key: 'validation' as const,
            label: 'Validation',
            value: 'Paper — validation bypassed',
            detail: undefined,
            tone: 'neutral' as const,
            iconClass: 'i-ph:shield-check',
          }
        : makeStage(
            'validation',
            'Validation',
            trade.validation ? (trade.validation.approved ? 'approved' : 'rejected') : validationLabel,
            trade.validation?.responses[0]?.reasoning ?? trade.validatorReasoning,
            'neutral',
            'i-ph:shield-check',
          ),
      makeStage('execution', 'Execution', trade.execution?.status ?? trade.status, trade.execution?.reason, 'neutral', 'i-ph:lightning'),
    ],
  };
}

export function buildDecisionItemsFromRuns(runs: BotRun[]): DecisionFeedItem[] {
  return runs.map(buildDecisionItemFromRun);
}

export function buildDecisionItemsFromTrades(trades: Trade[]): DecisionFeedItem[] {
  return trades.map(buildDecisionItemFromTrade);
}
