import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useAccount } from 'wagmi';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import {
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
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
}

const OBSERVATORY_WORKSPACE_LAYOUT_KEY = 'arena:observatory-workspace-layout';
const DEFAULT_OBSERVATORY_WORKSPACE_LAYOUT: ObservatoryWorkspaceLayout = {
  botListPercent: 34,
};

function normalizeObservatoryLayout(value: Partial<ObservatoryWorkspaceLayout>): ObservatoryWorkspaceLayout {
  return {
    botListPercent: clampNumber(
      Number(value.botListPercent) || DEFAULT_OBSERVATORY_WORKSPACE_LAYOUT.botListPercent,
      24,
      52,
    ),
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
        return (
          <article key={idea.idea_id} className="bg-[var(--arena-terminal-bg)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-display text-base font-semibold text-[var(--arena-terminal-text)]">
                  {idea.title}
                </h3>
                <p className="mt-1 text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
                  {idea.thesis}
                </p>
              </div>
              <span className={`font-data text-xs ${statusClass(feedback ?? idea.status)}`}>
                {feedback ?? idea.status}
              </span>
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
              className={`grid w-full gap-2 p-3 text-left transition-colors sm:grid-cols-[9rem_minmax(0,1fr)_7rem] ${
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
              <span className={`text-right font-data text-xs ${statusClass(session.status)}`}>
                {session.status}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TraceMessage({
  role,
  title,
  meta,
  icon,
  align = 'left',
  children,
}: {
  role: string;
  title: string;
  meta?: string | null;
  icon: string;
  align?: 'left' | 'right';
  children: string;
}) {
  const messageRole = align === 'right' ? 'user' : 'assistant';
  const isUser = align === 'right';

  return (
    <div
      className={`arena-observatory-chat-message flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        data-observatory-trace-role={messageRole}
        className={`grid max-w-[92%] grid-cols-[1.75rem_minmax(0,1fr)] gap-2 border px-3 py-2.5 font-display text-sm ${
          isUser
            ? 'border-[#50d2c1]/35 bg-[#50d2c1]/10 text-[var(--arena-terminal-text)]'
            : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)]'
        }`}
      >
        <span
          className={`flex size-7 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] ${icon} text-base ${
            isUser ? 'text-[#50d2c1]' : 'text-[var(--arena-terminal-text-muted)]'
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center justify-between gap-3">
            <span className="font-data text-[11px] uppercase text-[var(--arena-terminal-text-muted)]">
              {role}
            </span>
            {meta ? (
              <span className="truncate text-right font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
                {meta}
              </span>
            ) : null}
          </span>
          <span className="mt-2 block whitespace-pre-wrap break-words leading-5">
            {children}
          </span>
          <span className="mt-2 block truncate border-t border-[var(--arena-terminal-border)] pt-2 font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
            {title}
          </span>
        </span>
      </div>
    </div>
  );
}

function TraceDataPanel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3">
      <h5 className="mb-2 flex items-center gap-2 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
        <span className={`${icon} text-base text-[var(--arena-terminal-text-muted)]`} aria-hidden="true" />
        {title}
      </h5>
      {children}
    </section>
  );
}

function WorkSessionTrace({
  session,
  task,
  idea,
}: {
  session: ObservatoryDelegatedWorkSession | null;
  task?: ObservatoryResearchTask | null;
  idea?: ObservatoryIdea | null;
}) {
  if (!session) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
        Select delegated work to inspect its prompt, artifacts, and gates.
      </div>
    );
  }

  const safetyEntries = Object.entries(task?.safety_limits ?? {});
  const evidenceRefs = task?.evidence_refs?.length ? task.evidence_refs : idea?.evidence_refs ?? [];
  const driverText = task?.prompt ?? idea?.thesis ?? session.summary;
  const agentText = task?.result_summary
    || (task?.result_ref ? `Result artifact: ${task.result_ref}` : null)
    || `No result recorded yet. Current status: ${session.status}.`;

  return (
    <div className="min-w-0 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)]" aria-label="Work session transcript">
      <div className="border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
              {task?.title ?? session.summary}
            </h4>
            <p className="mt-1 truncate font-data text-xs text-[var(--arena-terminal-text-muted)]">
              {session.source} · {formatDate(session.created_at)} · {session.task_id ?? session.session_id}
            </p>
          </div>
          <span className={`font-data text-xs ${statusClass(session.status)}`}>
            {session.status}
          </span>
        </div>
      </div>

      <div className="grid gap-3 p-3">
        <div className="space-y-3">
          <TraceMessage
            role="Driver"
            title="Owner / Observatory"
            meta={task?.worker_launch ?? session.source}
            icon="i-ph:user-circle"
            align="right"
          >
            {driverText}
          </TraceMessage>

          <TraceMessage
            role="Coding agent"
            title={task?.worker ?? 'Delegated worker'}
            meta={session.status}
            icon="i-ph:code"
          >
            {agentText}
          </TraceMessage>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <TraceDataPanel title="Artifacts" icon="i-ph:archive">
            <div className="mt-2 grid gap-1.5 font-data text-xs text-[var(--arena-terminal-text-secondary)]">
              <span className="break-all">{session.artifact_ref ?? 'No session artifact recorded.'}</span>
              {evidenceRefs.slice(0, 4).map((ref) => (
                <span key={ref} className="break-all text-[var(--arena-terminal-text-muted)]">{ref}</span>
              ))}
            </div>
          </TraceDataPanel>

          <TraceDataPanel title="Gates" icon="i-ph:shield-check">
            <div className="mt-2 grid gap-1.5 font-data text-xs text-[var(--arena-terminal-text-secondary)]">
              {safetyEntries.length > 0 ? safetyEntries.map(([key, value]) => (
                <span key={key} className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate text-[var(--arena-terminal-text-muted)]">{key}</span>
                  <span className="shrink-0 text-[var(--arena-terminal-text)]">{String(value)}</span>
                </span>
              )) : (
                <span>No explicit task safety limits recorded.</span>
              )}
            </div>
          </TraceDataPanel>
        </div>

        {task?.acceptance_criteria?.length ? (
          <TraceDataPanel title="Acceptance" icon="i-ph:list-checks">
            <div className="mt-2 grid gap-1.5 text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
              {task.acceptance_criteria.map((criterion) => (
                <span key={criterion}>{criterion}</span>
              ))}
            </div>
          </TraceDataPanel>
        ) : null}
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

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div className="grid min-w-0 gap-4">
          <section className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Latest reflection</h3>
              {usage && (
                <span className="w-full max-w-full break-words font-data text-xs text-[var(--arena-terminal-text-muted)] sm:w-auto sm:whitespace-nowrap">
                  {usage.reporting_status} · {usage.total_tokens} tok · {formatCost(usage.cost_usd)}
                </span>
              )}
            </div>
            {reflection ? (
              <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3">
                <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
                  <div className="min-w-0">
                    {reflection.conclusions.map((conclusion) => (
                      <p key={conclusion} className="break-words text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
                        {conclusion}
                      </p>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-data text-xs lg:grid-cols-1">
                    <div className="min-w-0">
                      <div className="text-base font-bold text-[var(--arena-terminal-text)]">{reflection.findings.length}</div>
                      <div className="uppercase tracking-normal text-[var(--arena-terminal-text-muted)]">Findings</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-base font-bold text-[var(--arena-terminal-text)]">{reflection.idea_ids.length}</div>
                      <div className="uppercase tracking-normal text-[var(--arena-terminal-text-muted)]">Ideas</div>
                    </div>
                    <div className="min-w-0">
                      <div className={`text-base font-bold ${pressureClass(pressure.pressure_level)}`}>{pressure.active_sessions}</div>
                      <div className="uppercase tracking-normal text-[var(--arena-terminal-text-muted)]">Active</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 text-sm text-[var(--arena-terminal-text-secondary)]">
                Trigger this bot to write the first Observatory record.
              </div>
            )}
          </section>

          <section className="min-w-0">
            <h3 className="mb-2 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Signal digest</h3>
            <SignalDigest digest={digest} />
          </section>

          <section className="min-w-0">
            <h3 className="mb-2 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Findings</h3>
            <FindingList findings={reflection?.findings ?? []} />
          </section>

          <section className="min-w-0">
            <h3 className="mb-2 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Ideas</h3>
            <IdeaList
              ideas={bot.records.ideas}
              feedbackByIdeaId={feedbackByIdeaId}
              isPending={feedback.isPending}
              onFeedback={(ideaId, action) => feedback.mutate({ ideaId, action })}
            />
          </section>

          <section className="min-w-0">
            <h3 className="mb-2 font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Delegated work</h3>
            <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              <DelegatedWorkList
                sessions={bot.records.delegated_work_sessions}
                pressure={pressure}
                researchTasks={bot.records.research_tasks}
                selectedSessionId={selectedSession?.session_id ?? null}
                onSelectSession={setSelectedSessionId}
              />
              <WorkSessionTrace
                session={selectedSession}
                task={selectedTask}
                idea={selectedIdea}
              />
            </div>
          </section>
        </div>
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
        description="Owner or operator authentication is required to inspect bot reflections, ideas, delegated work, and cost telemetry."
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
          <aside
            style={botListStyle as CSSProperties}
            className="flex max-h-[40vh] min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] lg:max-h-none lg:w-[var(--observatory-bot-list-percent)] lg:basis-[var(--observatory-bot-list-percent)] lg:border-b-0 lg:border-r"
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
                  setLayout((current) => ({
                    ...current,
                    botListPercent: clampNumber(next, 24, 52),
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
