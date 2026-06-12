import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { RunGroup } from '@tangle-network/sandbox-ui/run';
import type {
  AgentBranding,
  CustomToolRenderer,
  Run,
  SessionMessage,
  SessionPart,
  ToolPart,
  ToolStatus,
} from '@tangle-network/sandbox-ui/types';
import { useAccount } from 'wagmi';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import {
  WorkspaceCollapsedPane,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePanePercent,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';
import { ConnectWalletPanel } from '~/components/layout/ConnectWalletPanel';
import { OperatorAccessCard, OperatorSessionBanner } from '~/components/operator/OperatorAccessCard';
import { SkeletonCard } from '~/components/ui/Skeleton';
import {
  type ObservatoryDelegatedWorkSession,
  type ObservatoryDelegationPressure,
  type ObservatoryFinding,
  type ObservatoryIdea,
  type ObservatoryOverviewBot,
  type ObservatoryReflectionRun,
  type ObservatoryResearchTask,
  type ObservatoryWorldSignalDigest,
  useObservatoryIdeaFeedback,
  useObservatoryOverview,
  useTriggerBotObservatory,
} from '~/lib/hooks/useBotApi';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { useTradingRouteAutoAuth } from '~/lib/hooks/useTradingRouteAutoAuth';
import { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } from '~/lib/operator/meta';

interface ObservatoryWorkspaceLayout {
  botListPercent: number;
  botListCollapsed: boolean;
}

const OBSERVATORY_WORKSPACE_LAYOUT_KEY = 'arena:observatory-workspace-layout';
const DEFAULT_OBSERVATORY_WORKSPACE_LAYOUT: ObservatoryWorkspaceLayout = {
  botListPercent: 23,
  botListCollapsed: false,
};

const OBSERVATORY_AGENT_BRANDING: AgentBranding = {
  label: 'Agent',
  accentClass: 'text-[#50d2c1]',
  bgClass: 'bg-[#50d2c1]/10',
  containerBgClass: 'bg-[var(--arena-terminal-bg)]',
  borderClass: 'border-[#50d2c1]/25',
  iconClass: 'i-ph:brain',
  textClass: 'whitespace-nowrap text-[var(--arena-terminal-text)]',
};

function normalizeObservatoryLayout(value: Partial<ObservatoryWorkspaceLayout>): ObservatoryWorkspaceLayout {
  return {
    botListPercent: clampNumber(
      Number(value.botListPercent) || DEFAULT_OBSERVATORY_WORKSPACE_LAYOUT.botListPercent,
      20,
      38,
    ),
    botListCollapsed: value.botListCollapsed === true,
  };
}

export const meta: MetaFunction = () => [
  { title: 'Observatory — Tangle Trading' },
];

function formatDate(value?: string | null): string {
  if (!value) return 'No record';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return 'Unknown';
  return time.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function timestampMs(value?: string | null): number | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function toolStatusFor(value?: string | null): ToolStatus {
  const lower = (value ?? '').toLowerCase();
  if (/fail|error|reject|blocked/.test(lower)) return 'error';
  if (/running|dispatch|execut/.test(lower)) return 'running';
  if (/complete|done|success|accepted/.test(lower)) return 'completed';
  return 'pending';
}

function latestByCreatedAt<T extends { created_at?: string | null }>(items: T[]): T | null {
  return [...items].sort((left, right) =>
    new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime(),
  )[0] ?? null;
}

function severityClass(severity: string): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'border-crimson-500/25 bg-crimson-500/8 text-crimson-600 dark:text-crimson-300';
    case 'medium':
      return 'border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300';
    default:
      return 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text-secondary)]';
  }
}

function statusClass(status: string): string {
  const lower = status.toLowerCase();
  if (lower.includes('fail') || lower.includes('error') || lower.includes('reject')) {
    return 'text-crimson-600 dark:text-crimson-300';
  }
  if (lower.includes('open') || lower.includes('awaiting') || lower.includes('pending')) {
    return 'text-amber-700 dark:text-amber-300';
  }
  return 'text-emerald-700 dark:text-emerald-300';
}

function humanizeStatus(status?: string | null): string {
  const value = (status ?? '').trim();
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function compactStatusLabel(status?: string | null): string {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'awaiting_owner_feedback') return 'Awaiting owner';
  if (normalized === 'queued_research') return 'Queued research';
  if (normalized === 'queued_build') return 'Queued build';
  return humanizeStatus(status);
}

function ideaSourceChips(idea: ObservatoryIdea): string[] {
  return [
    idea.finding_code ?? 'observatory-finding',
    idea.category,
    idea.finding_severity ? `${idea.finding_severity} severity` : null,
    idea.source_run_id ? `run ${idea.source_run_id}` : null,
  ].filter(Boolean) as string[];
}

function latestReflection(bot: ObservatoryOverviewBot): ObservatoryReflectionRun | null {
  return latestByCreatedAt(bot.records.reflection_runs);
}

function latestDigest(bot: ObservatoryOverviewBot): ObservatoryWorldSignalDigest | null {
  return latestByCreatedAt(bot.records.world_signal_digests);
}

function countOpenIdeas(bot: ObservatoryOverviewBot): number {
  return bot.records.ideas.filter((idea) => idea.status !== 'rejected' && idea.status !== 'muted').length;
}

function activeDelegationStatus(status: string): boolean {
  return /dispatch|queued|running|pending|await|open/i.test(status);
}

function uniqueDelegatedWorkSessions(sessions: ObservatoryDelegatedWorkSession[]): ObservatoryDelegatedWorkSession[] {
  const byId = new Map<string, ObservatoryDelegatedWorkSession>();
  for (const session of sessions) {
    const existing = byId.get(session.session_id);
    if (!existing || new Date(session.created_at || 0).getTime() >= new Date(existing.created_at || 0).getTime()) {
      byId.set(session.session_id, session);
    }
  }
  return [...byId.values()].sort((left, right) =>
    new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime(),
  );
}

function buildDelegationPressure(sessions: ObservatoryDelegatedWorkSession[]): ObservatoryDelegationPressure {
  const unique = uniqueDelegatedWorkSessions(sessions);
  const active = unique.filter((session) => activeDelegationStatus(session.status));
  const byStatus: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const session of unique) {
    byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
    bySource[session.source] = (bySource[session.source] ?? 0) + 1;
  }
  const pressureLevel = active.length >= 5 ? 'high' : active.length >= 2 ? 'medium' : 'low';
  return {
    unique_sessions: unique.length,
    active_sessions: active.length,
    terminal_sessions: unique.length - active.length,
    duplicate_rows_removed: Math.max(0, sessions.length - unique.length),
    by_status: byStatus,
    by_source: bySource,
    usage_reporting_status: 'not_applicable',
    usage_event_count: 0,
    total_tokens: 0,
    cost_usd: 0,
    pressure_level: pressureLevel,
  };
}

function delegationPressureForBot(bot: ObservatoryOverviewBot): ObservatoryDelegationPressure {
  return bot.records.delegation_pressure
    ?? latestReflection(bot)?.delegation_pressure
    ?? buildDelegationPressure(bot.records.delegated_work_sessions);
}

function pressureClass(level: string): string {
  const lower = level.toLowerCase();
  if (lower === 'high') return 'text-crimson-600 dark:text-crimson-300';
  if (lower === 'medium') return 'text-amber-700 dark:text-amber-300';
  return 'text-emerald-700 dark:text-emerald-300';
}

function delegateActionForIdea(
  idea: ObservatoryIdea,
  feedback?: string,
): 'delegate_research' | 'delegate_build' {
  if (feedback === 'delegate_research' || feedback === 'delegate_build') return feedback;
  return idea.proposed_action === 'delegate_build' ? 'delegate_build' : 'delegate_research';
}

function delegateActionLabel(action: 'delegate_research' | 'delegate_build'): string {
  return action === 'delegate_build' ? 'Delegate build' : 'Delegate research';
}

function researchTaskById(tasks: ObservatoryResearchTask[] | undefined): Map<string, ObservatoryResearchTask> {
  const map = new Map<string, ObservatoryResearchTask>();
  for (const task of tasks ?? []) {
    map.set(task.task_id, task);
  }
  return map;
}

function ideaById(ideas: ObservatoryIdea[]): Map<string, ObservatoryIdea> {
  const map = new Map<string, ObservatoryIdea>();
  for (const idea of ideas) {
    map.set(idea.idea_id, idea);
  }
  return map;
}

function buildDriverText(
  bot: ObservatoryOverviewBot,
  session: ObservatoryDelegatedWorkSession | null,
  task?: ObservatoryResearchTask | null,
  idea?: ObservatoryIdea | null,
): string {
  if (!session) {
    return [
      `Observe ${bot.bot_name}.`,
      'Review the latest market context, operating gaps, ideas, delegated work, and whether this agent is improving its trading process.',
    ].join('\n\n');
  }

  return [
    task?.worker_launch ? `Launch: ${task.worker_launch}` : null,
    task?.prompt ?? idea?.thesis ?? session.summary,
  ].filter(Boolean).join('\n\n');
}

function buildAgentOutput(
  bot: ObservatoryOverviewBot,
  reflection: ObservatoryReflectionRun | null,
  session: ObservatoryDelegatedWorkSession | null,
  task?: ObservatoryResearchTask | null,
): string {
  if (session) {
    if (task?.result_summary) return task.result_summary;
    if (task?.result_ref) return `Output recorded at ${task.result_ref}.`;
    return `Output pending. Current status: ${session.status}.`;
  }

  if (reflection?.conclusions.length) {
    return reflection.conclusions.join('\n');
  }

  if (bot.error) {
    return `Observatory could not load records for this bot: ${bot.error}.`;
  }

  return 'No Observatory output has been recorded yet. Trigger an observation to create the first run.';
}

function buildReasoningSummary(
  reflection: ObservatoryReflectionRun | null,
  session: ObservatoryDelegatedWorkSession | null,
  idea?: ObservatoryIdea | null,
): string | null {
  const lines = [
    idea?.finding_code ? `Finding: ${idea.finding_code}${idea.finding_severity ? ` (${idea.finding_severity})` : ''}` : null,
    idea?.category ? `Category: ${idea.category}` : null,
    idea?.thesis ? `Idea thesis: ${idea.thesis}` : null,
    idea?.expected_value ? `Expected value: ${idea.expected_value}` : null,
    idea?.risk ? `Risk: ${idea.risk}` : null,
    idea?.source_run_id ? `Source run: ${idea.source_run_id}` : null,
    session?.summary ? `Session summary: ${session.summary}` : null,
    ...(reflection?.uncertainties ?? []).map((uncertainty) => `Uncertainty: ${uncertainty}`),
  ].filter(Boolean);

  return lines.length ? lines.join('\n') : null;
}

function buildObservatoryTranscript({
  bot,
  reflection,
  session,
  task,
  idea,
}: {
  bot: ObservatoryOverviewBot;
  reflection: ObservatoryReflectionRun | null;
  session: ObservatoryDelegatedWorkSession | null;
  task?: ObservatoryResearchTask | null;
  idea?: ObservatoryIdea | null;
}): {
  userMessage: SessionMessage;
  assistantRun: Run;
  partMap: Record<string, SessionPart[]>;
} {
  const sessionId = session?.session_id ?? reflection?.run_id ?? `${bot.bot_id}-observatory`;
  const userMessageId = `${sessionId}:driver`;
  const assistantMessageId = `${sessionId}:agent`;
  const created = timestampMs(task?.created_at ?? session?.created_at ?? reflection?.created_at);
  const updated = timestampMs(task?.updated_at ?? reflection?.created_at);
  const output = buildAgentOutput(bot, reflection, session, task);
  const reasoning = buildReasoningSummary(reflection, session, idea);
  const assistantParts: SessionPart[] = [
    { type: 'text', text: output },
  ];

  if (reasoning) {
    assistantParts.push({
      type: 'reasoning',
      text: `Recorded reasoning summary\n${reasoning}`,
      time: created ? { start: created, end: updated ?? created } : undefined,
    });
  }

  if (session || task) {
    const evidenceRefs = task?.evidence_refs?.length ? task.evidence_refs : idea?.evidence_refs ?? [];
    assistantParts.push({
      type: 'tool',
      id: `${sessionId}:tool`,
      tool: task?.worker ?? session?.source ?? 'observatory',
      state: {
        status: toolStatusFor(task?.status ?? session?.status),
        input: task?.prompt ?? session?.summary,
        output: task?.result_summary ?? task?.result_ref ?? session?.artifact_ref ?? null,
        metadata: {
          observatory_kind: 'delegated_work',
          title: task?.title ?? session?.summary ?? 'Observatory work',
          category: idea?.category ?? null,
          finding_code: idea?.finding_code ?? null,
          finding_severity: idea?.finding_severity ?? null,
          expected_value: idea?.expected_value ?? null,
          risk: idea?.risk ?? null,
          source_run_id: idea?.source_run_id ?? reflection?.run_id ?? null,
          prompt: task?.prompt ?? null,
          evidence_refs: evidenceRefs,
          acceptance_criteria: task?.acceptance_criteria ?? [],
          safety_limits: task?.safety_limits ?? {},
          artifact_ref: session?.artifact_ref ?? null,
          result_ref: task?.result_ref ?? null,
          status: task?.status ?? session?.status ?? 'unknown',
        },
        time: created ? { start: created, end: updated ?? created } : undefined,
      },
    });
  }

  const userMessage: SessionMessage = {
    id: userMessageId,
    role: 'user',
    sessionID: sessionId,
    time: { created },
    _insertionIndex: 0,
  };
  const assistantMessage: SessionMessage = {
    id: assistantMessageId,
    role: 'assistant',
    sessionID: sessionId,
    time: { created: updated ?? created, updated, completed: updated },
    _insertionIndex: 1,
  };

  return {
    userMessage,
    assistantRun: {
      id: `${sessionId}:run`,
      messages: [assistantMessage],
      isComplete: toolStatusFor(task?.status ?? session?.status) !== 'running',
      isStreaming: false,
      stats: {
        toolCount: assistantParts.filter((part) => part.type === 'tool').length,
        messageCount: 1,
        thinkingDurationMs: 0,
        textPartCount: assistantParts.filter((part) => part.type === 'text').length,
        toolCategories: new Set(['task']),
      },
      summaryText: output,
      finalTextPart: {
        messageId: assistantMessageId,
        partIndex: 0,
        text: output,
      },
    },
    partMap: {
      [userMessageId]: [{ type: 'text', text: buildDriverText(bot, session, task, idea) }],
      [assistantMessageId]: assistantParts,
    },
  };
}

function useSelectedBot(bots: ObservatoryOverviewBot[]) {
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedBotId && bots.some((bot) => bot.bot_id === selectedBotId)) return;
    setSelectedBotId(bots[0]?.bot_id ?? null);
  }, [bots, selectedBotId]);

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.bot_id === selectedBotId) ?? bots[0] ?? null,
    [bots, selectedBotId],
  );

  return { selectedBot, selectedBotId, setSelectedBotId };
}

function BotRow({
  bot,
  selected,
  onSelect,
}: {
  bot: ObservatoryOverviewBot;
  selected: boolean;
  onSelect: () => void;
}) {
  const reflection = latestReflection(bot);
  const digest = latestDigest(bot);
  const findingCount = reflection?.findings.length ?? 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-3 text-left transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60 ${
        selected
          ? 'bg-[var(--arena-terminal-panel-strong)] text-[var(--arena-terminal-text)]'
          : 'bg-transparent text-[var(--arena-terminal-text-secondary)] hover:bg-[var(--arena-terminal-panel)] hover:text-[var(--arena-terminal-text)]'
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate font-display text-sm font-semibold">
          {bot.bot_name}
        </span>
        <span className="mt-1 block truncate font-data text-xs text-[var(--arena-terminal-text-muted)]">
          {reflection ? formatDate(reflection.created_at) : bot.error ? 'Read unavailable' : 'No reflection yet'}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 font-data text-xs">
        <span className={findingCount > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}>
          {findingCount} findings
        </span>
        <span className="text-[var(--arena-terminal-text-muted)]">
          {digest?.source_status ?? 'no signal'}
        </span>
      </span>
    </button>
  );
}

function FindingList({ findings }: { findings: ObservatoryFinding[] }) {
  if (findings.length === 0) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
        No active operating gap in the latest record.
      </div>
    );
  }

  return (
    <div className="divide-y divide-[var(--arena-terminal-border)] border border-[var(--arena-terminal-border)]">
      {findings.map((finding) => (
        <div key={`${finding.code}-${finding.summary}`} className="grid gap-2 bg-[var(--arena-terminal-bg)] p-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <span className={`w-fit border px-2 py-1 font-data text-[11px] uppercase tracking-[0.08em] ${severityClass(finding.severity)}`}>
            {finding.severity}
          </span>
          <div className="min-w-0">
            <div className="truncate font-data text-xs text-[var(--arena-terminal-text-muted)]">
              {finding.code}
            </div>
            <div className="mt-1 text-sm leading-5 text-[var(--arena-terminal-text)]">
              {finding.summary}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function IdeaList({
  ideas,
  feedbackByIdeaId,
  onFeedback,
  isPending,
}: {
  ideas: ObservatoryIdea[];
  feedbackByIdeaId: Map<string, string>;
  onFeedback: (ideaId: string, action: 'interesting' | 'rejected' | 'delegate_research' | 'delegate_build' | 'mute') => void;
  isPending: boolean;
}) {
  if (ideas.length === 0) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
        No ideas emitted from the current evidence.
      </div>
    );
  }

  return (
    <div className="divide-y divide-[var(--arena-terminal-border)] border border-[var(--arena-terminal-border)]">
      {ideas.map((idea) => {
        const feedback = feedbackByIdeaId.get(idea.idea_id);
        const delegateAction = delegateActionForIdea(idea, feedback);
        const sourceChips = ideaSourceChips(idea);
        return (
          <article key={idea.idea_id} className="bg-[var(--arena-terminal-bg)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="break-words font-display text-base font-semibold leading-5 text-[var(--arena-terminal-text)]">
                  {idea.title}
                </h3>
                <p className="mt-1 text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
                  {idea.thesis}
                </p>
              </div>
              <span
                title={feedback ?? idea.status}
                className={`max-w-full break-words text-right font-data text-xs leading-4 ${statusClass(feedback ?? idea.status)}`}
              >
                {compactStatusLabel(feedback ?? idea.status)}
              </span>
            </div>
            <div className="mt-3 grid gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-2">
              <div className="flex flex-wrap gap-1.5">
                {sourceChips.map((chip) => (
                  <span key={chip} className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-1.5 py-1 font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
                    {chip}
                  </span>
                ))}
              </div>
              <p className="text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
                {idea.expected_value}
              </p>
              <div className="grid gap-1 font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
                <span className="break-words">Risk: {idea.risk}</span>
                {idea.evidence_refs.length > 0 ? (
                  <span className="break-all">Evidence: {idea.evidence_refs[0]}</span>
                ) : (
                  <span>No evidence artifact attached.</span>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={isPending}
                onClick={() => onFeedback(idea.idea_id, 'interesting')}
                className="h-7 border border-[var(--arena-terminal-border)] px-2 font-display text-xs text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] disabled:opacity-50"
              >
                Interesting
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => onFeedback(idea.idea_id, delegateAction)}
                className="h-7 border border-[#50d2c1]/35 bg-[#50d2c1]/10 px-2 font-display text-xs text-[var(--arena-terminal-text)] transition-colors hover:bg-[#50d2c1]/18 disabled:opacity-50"
              >
                {delegateActionLabel(delegateAction)}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => onFeedback(idea.idea_id, 'rejected')}
                className="h-7 border border-[var(--arena-terminal-border)] px-2 font-display text-xs text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function DelegatedWorkList({
  sessions,
  pressure,
  researchTasks,
  selectedSessionId,
  onSelectSession,
}: {
  sessions: ObservatoryDelegatedWorkSession[];
  pressure: ObservatoryDelegationPressure;
  researchTasks?: ObservatoryResearchTask[];
  selectedSessionId?: string | null;
  onSelectSession: (sessionId: string) => void;
}) {
  const uniqueSessions = uniqueDelegatedWorkSessions(sessions);
  const taskById = researchTaskById(researchTasks);
  const gateBlocked = pressure.allows_new_delegation === false;
  const gateLabel = gateBlocked ? 'Blocked' : 'Open';
  const gateDetail = gateBlocked
    ? (pressure.deny_reasons?.join(', ') || 'pressure cap')
    : `cap ${pressure.limits?.max_active_delegations ?? 3}`;

  if (uniqueSessions.length === 0) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
        No delegated work sessions yet.
      </div>
    );
  }

  return (
    <div className="border border-[var(--arena-terminal-border)]">
      <div className="grid gap-2 border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] p-3 font-data text-xs sm:grid-cols-5">
        <div>
          <div className="text-base font-bold text-[var(--arena-terminal-text)]">{pressure.unique_sessions}</div>
          <div className="uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Unique</div>
        </div>
        <div>
          <div className={`text-base font-bold ${pressureClass(pressure.pressure_level)}`}>{pressure.active_sessions}</div>
          <div className="uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Active</div>
        </div>
        <div>
          <div className="text-base font-bold text-[var(--arena-terminal-text)]">{pressure.duplicate_rows_removed}</div>
          <div className="uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Dedupe</div>
        </div>
        <div>
          <div className={`text-base font-bold ${pressureClass(pressure.pressure_level)}`}>{pressure.pressure_level}</div>
          <div className="uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Pressure</div>
        </div>
        <div>
          <div className={`truncate text-base font-bold ${gateBlocked ? 'text-[#ff7a5c]' : 'text-[#50d2c1]'}`}>{gateLabel}</div>
          <div className="truncate uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">{gateDetail}</div>
        </div>
      </div>
      <div className="divide-y divide-[var(--arena-terminal-border)]">
        {uniqueSessions.slice(0, 8).map((session) => {
          const task = session.task_id ? taskById.get(session.task_id) : null;
          const selected = selectedSessionId === session.session_id;
          return (
            <button
              key={session.session_id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectSession(session.session_id)}
              className={`grid w-full gap-2 p-3 text-left transition-colors sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(7rem,9rem)] ${
                selected
                  ? 'bg-[var(--arena-terminal-panel-strong)]'
                  : 'bg-[var(--arena-terminal-bg)] hover:bg-[var(--arena-terminal-panel)]'
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60`}
            >
              <span className="truncate font-data text-xs text-[var(--arena-terminal-text-muted)]">
                {session.source}
              </span>
              <span className="min-w-0 text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
                {task?.title ?? session.summary}
                <span className="mt-1 block truncate font-data text-xs text-[var(--arena-terminal-text-muted)]">
                  {task?.worker_launch ? `${task.worker_launch} · ` : null}
                  {session.task_id ?? session.artifact_ref ?? 'no task id'}
                </span>
              </span>
              <span
                title={session.status}
                className={`min-w-0 justify-self-start break-words font-data text-xs leading-4 sm:justify-self-end sm:text-right ${statusClass(session.status)}`}
              >
                {compactStatusLabel(session.status)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const renderObservatoryToolDetail: CustomToolRenderer = (part: ToolPart) => {
  const metadata = part.state.metadata as {
    observatory_kind?: string;
    title?: string | null;
    category?: string | null;
    finding_code?: string | null;
    finding_severity?: string | null;
    expected_value?: string | null;
    risk?: string | null;
    source_run_id?: string | null;
    prompt?: string | null;
    evidence_refs?: string[];
    acceptance_criteria?: string[];
    safety_limits?: Record<string, unknown>;
    artifact_ref?: string | null;
    result_ref?: string | null;
    status?: string | null;
  } | undefined;

  if (metadata?.observatory_kind !== 'delegated_work') return null;

  const evidenceRefs = metadata.evidence_refs ?? [];
  const acceptanceCriteria = metadata.acceptance_criteria ?? [];
  const safetyEntries = Object.entries(metadata.safety_limits ?? {});
  const artifactRefs = [metadata.artifact_ref, metadata.result_ref].filter(Boolean);
  const sourceEntries = [
    ['Finding', metadata.finding_code],
    ['Severity', metadata.finding_severity],
    ['Category', metadata.category],
    ['Source run', metadata.source_run_id],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <div className="grid gap-3 p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
      {sourceEntries.length > 0 || metadata.expected_value || metadata.risk ? (
        <section className="grid gap-2">
          <h5 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Source</h5>
          {sourceEntries.length > 0 ? (
            <div className="grid gap-1 sm:grid-cols-2">
              {sourceEntries.map(([label, value]) => (
                <span key={label} className="min-w-0 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 py-1.5 font-data text-xs">
                  <span className="block truncate text-[var(--arena-terminal-text-muted)]">{label}</span>
                  <span className="mt-0.5 block break-words text-[var(--arena-terminal-text)]">{value}</span>
                </span>
              ))}
            </div>
          ) : null}
          {metadata.expected_value ? (
            <p className="leading-5 text-[var(--arena-terminal-text-secondary)]">{metadata.expected_value}</p>
          ) : null}
          {metadata.risk ? (
            <p className="font-data text-xs text-[var(--arena-terminal-text-muted)]">Risk: {metadata.risk}</p>
          ) : null}
        </section>
      ) : null}

      {metadata.prompt ? (
        <section className="grid gap-1.5">
          <h5 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Prompt</h5>
          <p className="whitespace-pre-wrap leading-5">{metadata.prompt}</p>
        </section>
      ) : null}

      {acceptanceCriteria.length > 0 ? (
        <section className="grid gap-1.5">
          <h5 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Acceptance</h5>
          <div className="grid gap-1.5">
            {acceptanceCriteria.map((criterion) => (
              <span key={criterion} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
                <span className="i-ph:check-circle text-sm text-[#50d2c1]" aria-hidden="true" />
                <span>{criterion}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {safetyEntries.length > 0 ? (
        <section className="grid gap-1.5">
          <h5 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Gates</h5>
          <div className="grid gap-1 sm:grid-cols-3">
            {safetyEntries.map(([key, value]) => (
              <span key={key} className="min-w-0 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 py-1.5 font-data text-xs">
                <span className="block truncate text-[var(--arena-terminal-text-muted)]">{key}</span>
                <span className="mt-0.5 block truncate text-[var(--arena-terminal-text)]">{String(value)}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {evidenceRefs.length > 0 || artifactRefs.length > 0 ? (
        <section className="grid gap-1.5">
          <h5 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Artifacts</h5>
          <div className="grid gap-1 font-data text-xs">
            {[...artifactRefs, ...evidenceRefs].slice(0, 6).map((ref) => (
              <span key={ref} className="break-all text-[var(--arena-terminal-text-muted)]">{ref}</span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
};

function WorkSessionStrip({
  sessions,
  selectedSessionId,
  onSelectSession,
}: {
  sessions: ObservatoryDelegatedWorkSession[];
  selectedSessionId?: string | null;
  onSelectSession: (sessionId: string) => void;
}) {
  const uniqueSessions = uniqueDelegatedWorkSessions(sessions);

  if (uniqueSessions.length === 0) return null;

  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-2" aria-label="Work sessions">
      {uniqueSessions.map((session) => {
        const selected = selectedSessionId === session.session_id;
        return (
          <button
            key={session.session_id}
            type="button"
            onClick={() => onSelectSession(session.session_id)}
            aria-pressed={selected}
            title={`${session.source} · ${humanizeStatus(session.status)}`}
            className={`inline-flex h-8 max-w-[18rem] min-w-0 shrink-0 items-center gap-1.5 border px-2.5 font-data text-xs transition-colors ${
              selected
                ? 'border-[#50d2c1]/45 bg-[#50d2c1]/12 text-[var(--arena-terminal-text)]'
                : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-muted)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)]'
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60`}
          >
            <span className="truncate">{session.source}</span>
            <span className="shrink-0 text-[var(--arena-terminal-text-muted)]">·</span>
            <span className={`shrink-0 ${statusClass(session.status)}`}>{compactStatusLabel(session.status)}</span>
          </button>
        );
      })}
    </div>
  );
}

function DriverMessage({
  message,
  parts,
}: {
  message: SessionMessage;
  parts: SessionPart[];
}) {
  const text = parts
    .filter((part) => part.type === 'text' || part.type === 'reasoning')
    .map((part) => ('text' in part ? part.text : ''))
    .filter(Boolean)
    .join('\n\n');

  return (
    <article
      data-chat-role={message.role}
      className="arena-observatory-driver grid gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 py-2.5 text-[var(--arena-terminal-text)]"
    >
      <div className="flex items-center gap-2">
        <span className="i-ph:steering-wheel text-base text-[var(--arena-terminal-accent)]" aria-hidden="true" />
        <span className="font-data text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">
          Driver
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-5 text-[var(--arena-terminal-text)]">
        {text || 'Observe this agent and report the latest output.'}
      </p>
    </article>
  );
}

function ObservatoryRunTranscript({
  bot,
  reflection,
  session,
  task,
  idea,
  usage,
}: {
  bot: ObservatoryOverviewBot;
  reflection: ObservatoryReflectionRun | null;
  session: ObservatoryDelegatedWorkSession | null;
  task?: ObservatoryResearchTask | null;
  idea?: ObservatoryIdea | null;
  usage?: ObservatoryReflectionRun['usage_summary'];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const transcript = useMemo(
    () => buildObservatoryTranscript({ bot, reflection, session, task, idea }),
    [bot, idea, reflection, session, task],
  );
  useEffect(() => {
    setCollapsed(false);
  }, [bot.bot_id, reflection?.run_id, session?.session_id]);

  return (
    <div
      data-sandbox-ui="true"
      data-sandbox-theme="vault"
      className="arena-chat-shell arena-sandbox-transcript arena-sandbox-transcript--terminal arena-observatory-transcript arena-trace-terminal flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#081013] text-[#f6fefd]"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#273035] bg-[#0b1418] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
            {session ? task?.title ?? session.summary : 'Latest Observatory output'}
          </div>
          <div className="mt-0.5 truncate font-data text-xs text-[var(--arena-terminal-text-muted)]">
            {session ? `${session.source} · ${formatDate(session.created_at)}` : reflection ? `${reflection.trigger} · ${formatDate(reflection.created_at)}` : 'No run yet'}
          </div>
        </div>
        {usage ? (
          <span className="shrink-0 font-data text-xs text-[var(--arena-terminal-text-muted)]">
            {usage.reporting_status} · {usage.total_tokens} tok · {formatCost(usage.cost_usd)}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3" aria-label="Work session transcript">
        <div className="mx-auto grid max-w-[980px] gap-3">
          <div data-observatory-trace-role="user" className="min-w-0">
            <DriverMessage
              message={transcript.userMessage}
              parts={transcript.partMap[transcript.userMessage.id] ?? []}
            />
          </div>
          <div data-observatory-trace-role="assistant" className="min-w-0 overflow-hidden">
            <RunGroup
              run={transcript.assistantRun}
              partMap={transcript.partMap}
              collapsed={collapsed}
              onToggle={() => setCollapsed((value) => !value)}
              branding={OBSERVATORY_AGENT_BRANDING}
              renderToolDetail={renderObservatoryToolDetail}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SignalDigest({ digest }: { digest: ObservatoryWorldSignalDigest | null }) {
  if (!digest) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
        No signal digest yet.
      </div>
    );
  }

  return (
    <div className="grid gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 sm:grid-cols-3">
      <div>
        <div className="font-data text-lg font-bold text-[var(--arena-terminal-text)]">{digest.source_count}</div>
        <div className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Sources</div>
      </div>
      <div>
        <div className="truncate font-data text-sm font-semibold text-[var(--arena-terminal-text)]">{digest.source_status}</div>
        <div className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Signal state</div>
      </div>
      <div>
        <div className="truncate font-data text-sm font-semibold text-[var(--arena-terminal-text)]">{digest.confidence}</div>
        <div className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-muted)]">Confidence</div>
      </div>
    </div>
  );
}

function Inspector({
  bot,
  onTrigger,
  triggerPending,
}: {
  bot: ObservatoryOverviewBot | null;
  onTrigger: () => void;
  triggerPending: boolean;
}) {
  const feedback = useObservatoryIdeaFeedback(bot?.bot_id ?? '', {
    operatorApiUrl: ALL_TRADING_OPERATOR_API_URLS[0],
    enabled: !!bot,
  });
  const reflection = bot ? latestReflection(bot) : null;
  const digest = bot ? latestDigest(bot) : null;
  const delegatedSessions = useMemo(
    () => uniqueDelegatedWorkSessions(bot?.records.delegated_work_sessions ?? []),
    [bot?.records.delegated_work_sessions],
  );
  const taskById = useMemo(
    () => researchTaskById(bot?.records.research_tasks),
    [bot?.records.research_tasks],
  );
  const ideasById = useMemo(
    () => ideaById(bot?.records.ideas ?? []),
    [bot?.records.ideas],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const feedbackByIdeaId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of bot?.records.owner_feedback ?? []) {
      map.set(item.idea_id, item.action);
    }
    return map;
  }, [bot?.records.owner_feedback]);

  useEffect(() => {
    if (delegatedSessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }
    if (selectedSessionId && delegatedSessions.some((session) => session.session_id === selectedSessionId)) return;
    setSelectedSessionId(delegatedSessions[0].session_id);
  }, [delegatedSessions, selectedSessionId]);

  if (!bot) {
    return (
      <div className="flex h-full items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-6 text-center text-sm text-[var(--arena-terminal-text-secondary)]">
        No bot selected.
      </div>
    );
  }

  const usage = reflection?.usage_summary;
  const pressure = delegationPressureForBot(bot);
  const selectedSession = delegatedSessions.find((session) => session.session_id === selectedSessionId) ?? delegatedSessions[0] ?? null;
  const selectedTask = selectedSession?.task_id ? taskById.get(selectedSession.task_id) : null;
  const selectedIdea = selectedSession?.idea_id ? ideasById.get(selectedSession.idea_id) : null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--arena-terminal-panel)]">
      <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--arena-terminal-border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="min-w-0 max-w-full truncate font-display text-lg font-semibold text-[var(--arena-terminal-text)]">
            {bot.bot_name}
          </h2>
          <p className="mt-1 max-w-full break-words font-data text-xs text-[var(--arena-terminal-text-muted)] sm:truncate">
            {reflection ? `${reflection.trigger} · ${formatDate(reflection.created_at)}` : 'No Observatory record yet'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to={`/arena/bot/${encodeURIComponent(bot.bot_id)}`}
            className="inline-flex h-9 items-center gap-1 border border-[var(--arena-terminal-border)] px-2 font-display text-xs text-[var(--arena-terminal-text-secondary)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
          >
            <span className="i-ph:chart-line-up text-sm" aria-hidden="true" />
            Open
          </Link>
          <button
            type="button"
            onClick={onTrigger}
            disabled={triggerPending}
            className="inline-flex h-9 items-center gap-2 border border-[#50d2c1]/40 bg-[#50d2c1]/12 px-3 font-display text-sm font-medium text-[var(--arena-terminal-text)] transition-colors hover:bg-[#50d2c1]/20 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
          >
            <span className={triggerPending ? 'i-ph:spinner-gap animate-spin text-sm' : 'i-ph:eye text-sm'} aria-hidden="true" />
            {triggerPending ? 'Observing' : 'Observe now'}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden 2xl:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)] 2xl:overflow-hidden">
        <div className="flex min-h-[560px] min-w-0 flex-col overflow-hidden 2xl:min-h-0">
          <WorkSessionStrip
            sessions={bot.records.delegated_work_sessions}
            selectedSessionId={selectedSession?.session_id ?? null}
            onSelectSession={setSelectedSessionId}
          />
          <div className="min-h-0 flex-1">
            <ObservatoryRunTranscript
              bot={bot}
              reflection={reflection}
              session={selectedSession}
              task={selectedTask}
              idea={selectedIdea}
              usage={usage}
            />
          </div>
        </div>

        <aside className="overflow-visible border-t border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 2xl:min-h-0 2xl:overflow-y-auto 2xl:overflow-x-hidden 2xl:border-l 2xl:border-t-0" aria-label="Observatory context">
          <div className="grid gap-4">
            <section className="grid gap-2">
              <h3 className="flex items-center justify-between gap-3 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                <span>Signal</span>
                <span className="font-data text-xs text-[var(--arena-terminal-text-muted)]">
                  {digest?.source_status ?? 'none'}
                </span>
              </h3>
              <SignalDigest digest={digest} />
            </section>

            <section className="grid gap-2">
              <h3 className="flex items-center justify-between gap-3 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                <span>Operating gaps</span>
                <span className="font-data text-xs text-[var(--arena-terminal-text-muted)]">
                  {reflection?.findings.length ?? 0}
                </span>
              </h3>
              <FindingList findings={reflection?.findings ?? []} />
            </section>

            <section className="grid gap-2">
              <h3 className="flex items-center justify-between gap-3 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                <span>Proposals</span>
                <span className="font-data text-xs text-[var(--arena-terminal-text-muted)]">
                  {bot.records.ideas.length}
                </span>
              </h3>
              <IdeaList
                ideas={bot.records.ideas}
                feedbackByIdeaId={feedbackByIdeaId}
                isPending={feedback.isPending}
                onFeedback={(ideaId, action) => feedback.mutate({ ideaId, action })}
              />
            </section>

            <section className="grid gap-2">
              <h3 className="flex items-center justify-between gap-3 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                <span>Work queue</span>
                <span className="font-data text-xs text-[var(--arena-terminal-text-muted)]">
                  {pressure.active_sessions}/{pressure.unique_sessions}
                </span>
              </h3>
              <DelegatedWorkList
                sessions={bot.records.delegated_work_sessions}
                pressure={pressure}
                researchTasks={bot.records.research_tasks}
                selectedSessionId={selectedSession?.session_id ?? null}
                onSelectSession={setSelectedSessionId}
              />
            </section>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default function ObservatoryPage() {
  const { isConnected } = useAccount();
  const apiUrl = ALL_TRADING_OPERATOR_API_URLS[0] ?? '';
  const operatorAuth = useOperatorAuth(apiUrl);
  const hasOperatorSession = Boolean(operatorAuth.authCacheKey && operatorAuth.getCachedToken());
  const canLoadObservatory = HAS_TRADING_OPERATOR_API && (isConnected || hasOperatorSession);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    OBSERVATORY_WORKSPACE_LAYOUT_KEY,
    DEFAULT_OBSERVATORY_WORKSPACE_LAYOUT,
    normalizeObservatoryLayout,
  );

  useTradingRouteAutoAuth({
    enabled: isConnected && HAS_TRADING_OPERATOR_API,
    routeKey: 'observatory',
  });

  const overview = useObservatoryOverview({
    operatorApiUrl: apiUrl,
    enabled: canLoadObservatory,
    refetchInterval: 15_000,
  });
  const bots = useMemo(() => {
    return [...(overview.data?.bots ?? [])].sort((left, right) => {
      const leftReflection = latestReflection(left);
      const rightReflection = latestReflection(right);
      return new Date(rightReflection?.created_at || 0).getTime() - new Date(leftReflection?.created_at || 0).getTime();
    });
  }, [overview.data?.bots]);
  const { selectedBot, selectedBotId, setSelectedBotId } = useSelectedBot(bots);
  const trigger = useTriggerBotObservatory(selectedBotId ?? '', {
    operatorApiUrl: apiUrl,
    enabled: !!selectedBotId,
  });

  const freshReflections = bots.filter((bot) => {
    const reflection = latestReflection(bot);
    if (!reflection) return false;
    return Date.now() - new Date(reflection.created_at).getTime() <= 24 * 60 * 60 * 1000;
  }).length;
  const openIdeas = bots.reduce((sum, bot) => sum + countOpenIdeas(bot), 0);
  const delegated = bots.reduce(
    (sum, bot) => sum + delegationPressureForBot(bot).unique_sessions,
    0,
  );
  const activeDelegated = bots.reduce(
    (sum, bot) => sum + delegationPressureForBot(bot).active_sessions,
    0,
  );

  const botListStyle = {
    '--observatory-bot-list-percent': `${layout.botListPercent}%`,
  };

  if (!isConnected && !hasOperatorSession) {
    return (
      <ConnectWalletPanel
        title="Connect owner wallet"
        description="Connect to inspect bot reflections, ideas, delegated work, and spend."
        bullets={['Trigger bot observation', 'Review emitted ideas', 'Track delegated work']}
      />
    );
  }

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col overflow-x-hidden lg:h-full lg:overflow-hidden">
      <ArenaPageHeader
        title="Observatory"
        titleWidthClassName="min-[1180px]:w-[12rem]"
        metrics={[
          { value: `${freshReflections}/${overview.data?.bot_count ?? 0}`, label: 'Fresh' },
          { value: String(openIdeas), label: 'Ideas' },
          { value: `${activeDelegated}/${delegated}`, label: 'Active/Work' },
        ]}
        controls={(
          <>
            <ArenaHeaderLink to="/activity" icon="i-ph:pulse">Activity</ArenaHeaderLink>
            <ArenaHeaderLink to="/leaderboard" icon="i-ph:table">Agents</ArenaHeaderLink>
          </>
        )}
      />

      <OperatorSessionBanner />

      {!HAS_TRADING_OPERATOR_API ? (
        <OperatorAccessCard
          apiUrls={ALL_TRADING_OPERATOR_API_URLS}
          title="Operator API unavailable"
          description="Configure a trading operator API URL to inspect Observatory records."
        />
      ) : overview.isLoading || overview.isFetching && !overview.data ? (
        <div className="min-h-0 flex-1">
          <SkeletonCard className="h-full min-h-[520px]" />
        </div>
      ) : overview.isError ? (
        <OperatorAccessCard
          apiUrls={ALL_TRADING_OPERATOR_API_URLS}
          title="Operator authentication required"
          description="Authenticate with the owner or operator wallet to load Observatory records."
        />
      ) : (
        <section
          ref={workspaceRef}
          className="min-h-0 flex-1 overflow-hidden lg:flex"
          aria-label="Agent Observatory"
        >
          {layout.botListCollapsed && (
            <WorkspaceCollapsedPane
              label="Bots"
              icon="i-ph:robot"
              orientation="vertical"
              className="hidden w-11 shrink-0 border-r border-[var(--arena-terminal-border)] lg:flex"
              onClick={() => setLayout((current) => ({ ...current, botListCollapsed: false }))}
            />
          )}
            <aside
              style={botListStyle as CSSProperties}
              className={`max-h-[40vh] min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] lg:max-h-none lg:w-[var(--observatory-bot-list-percent)] lg:basis-[var(--observatory-bot-list-percent)] lg:border-b-0 lg:border-r ${
                layout.botListCollapsed ? 'flex lg:hidden' : 'flex'
              }`}
            >
              <div className="shrink-0 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                    Bots
                  </span>
                  <span className="font-data text-xs text-[var(--arena-terminal-text-muted)]">
                    {bots.length}
                  </span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {bots.length > 0 ? (
                  bots.map((bot) => (
                    <BotRow
                      key={bot.bot_id}
                      bot={bot}
                      selected={bot.bot_id === selectedBot?.bot_id}
                      onSelect={() => setSelectedBotId(bot.bot_id)}
                    />
                  ))
                ) : (
                  <div className="p-4 text-sm text-[var(--arena-terminal-text-secondary)]">
                    No bots available for this authenticated operator.
                  </div>
                )}
              </div>
            </aside>

          <WorkspaceResizeHandle
            orientation="vertical"
            ariaLabel="Resize Observatory bot list"
            onPointerDown={(event) => {
              const bounds = workspaceRef.current?.getBoundingClientRect();
              if (!bounds) return;
              beginWorkspaceResize(event, {
                cursor: 'col-resize',
                onMove: (moveEvent) => {
                  const next = ((moveEvent.clientX - bounds.left) / bounds.width) * 100;
                  if (shouldCollapsePanePercent(next)) {
                    setLayout((current) => ({
                      ...current,
                      botListCollapsed: true,
                    }));
                    return;
                  }
                  setLayout((current) => ({
                    ...current,
                    botListPercent: clampNumber(next, 20, 38),
                    botListCollapsed: false,
                  }));
                },
              });
            }}
          />

          <Inspector
            bot={selectedBot}
            triggerPending={trigger.isPending}
            onTrigger={() => {
              if (!selectedBotId) return;
              trigger.mutate('manual');
            }}
          />
        </section>
      )}
    </div>
  );
}
