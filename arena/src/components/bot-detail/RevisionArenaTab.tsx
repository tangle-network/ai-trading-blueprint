import { useEffect, useMemo, useState } from "react";
import type { BotOperatorKind, BotVerificationState } from "~/lib/types/bot";
import {
  type RevisionArenaEntry,
  type RevisionRunMode,
  useRevisionDecision,
  useRevisionArena,
} from "~/lib/hooks/useBotApi";
import { OperatorAccessCard } from "~/components/operator/OperatorAccessCard";
import { useOperatorAuth } from "~/lib/hooks/useOperatorAuth";
import { Button } from "@tangle-network/blueprint-ui/components";
import { getDeploymentKindForOperatorKind } from "~/lib/operator/meta";

interface RevisionArenaTabProps {
  botId: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
}

function modeLabel(mode: RevisionRunMode): string {
  switch (mode) {
    case "live":
      return "Live";
    case "canary":
      return "Canary";
    case "paper":
      return "Paper";
    case "shadow":
      return "Shadow";
    case "backtest":
      return "Backtest";
    case "research":
      return "Research";
  }
}

function modeClass(mode: RevisionRunMode): string {
  switch (mode) {
    case "live":
    case "canary":
      return "border-crimson-500/20 bg-crimson-500/8 text-crimson-600 dark:text-crimson-300";
    case "paper":
      return "border-sky-500/20 bg-sky-500/8 text-sky-700 dark:text-sky-300";
    case "shadow":
      return "border-violet-500/20 bg-violet-500/8 text-violet-700 dark:text-violet-300";
    case "backtest":
      return "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
    case "research":
      return "border-amber-500/20 bg-amber-500/8 text-amber-700 dark:text-amber-300";
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500";
    case "staged":
    case "candidate":
      return "bg-sky-500";
    case "blocked":
    case "failed":
      return "bg-crimson-500";
    case "superseded":
      return "bg-slate-500";
    default:
      return "bg-amber-500";
  }
}

function formatTime(value?: string | null): string {
  if (!value) return "Initial";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "Unknown";
  return time.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortHash(value?: string | null): string {
  if (!value) return "n/a";
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function shortRevisionId(value?: string | null): string {
  if (!value) return "none";
  return value.length > 16 ? `${value.slice(0, 16)}...` : value;
}

function isRevisionArenaAuthError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return /HTTP (401|403)/i.test(raw)
    || /missing authorization|unauthorized|forbidden|authentication required/i.test(raw);
}

function RevisionRow({
  revision,
  onApprove,
  onReject,
  decisionPending,
  canSubmitDecision,
}: {
  revision: RevisionArenaEntry;
  onApprove: (revisionId: string) => void;
  onReject: (revisionId: string) => void;
  decisionPending: boolean;
  canSubmitDecision: boolean;
}) {
  const blockerCount = revision.promotion_blockers.length;
  const changedFiles = revision.files_changed.slice(0, 4);
  const canDecide = canSubmitDecision
    && revision.source === "self-improvement-mcp"
    && revision.status === "candidate";

  return (
    <article className="border-b border-[var(--arena-terminal-border)] px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${statusClass(revision.status)}`} />
            <h3 className="text-lg font-display font-semibold leading-tight text-[var(--arena-terminal-text)]">
              {revision.display_name}
            </h3>
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-data ${modeClass(revision.run_mode)}`}
            >
              {modeLabel(revision.run_mode)}
            </span>
            <span className="rounded-full border border-[var(--arena-terminal-border)] px-2.5 py-1 text-xs font-data text-[var(--arena-terminal-text-secondary)]">
              {revision.status}
            </span>
          </div>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--arena-terminal-text-secondary)]">
            {revision.user_intent}
          </p>
        </div>
        <div className="text-right text-xs font-data text-[var(--arena-terminal-text-muted)]">
          <div>{formatTime(revision.created_at)}</div>
          <div className="mt-1">{shortHash(revision.patch_sha256)}</div>
          {canDecide && (
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                onClick={() => onApprove(revision.revision_id)}
                disabled={decisionPending}
                className="h-7 px-3 text-[11px]"
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onReject(revision.revision_id)}
                disabled={decisionPending}
                className="h-7 px-3 text-[11px]"
              >
                Reject
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-sm font-data text-[var(--arena-terminal-text-secondary)] sm:grid-cols-3">
        <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3">
          <span className="text-[var(--arena-terminal-text-muted)]">Parent</span>{" "}
          {revision.parent_revision_id ?? "none"}
        </div>
        <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3">
          <span className="text-[var(--arena-terminal-text-muted)]">Run</span>{" "}
          {revision.run_id ?? "none"}
        </div>
        <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3">
          <span className="text-[var(--arena-terminal-text-muted)]">Live execution</span>{" "}
          {revision.can_execute_live ? "enabled" : "blocked"}
        </div>
      </div>

      {changedFiles.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {changedFiles.map((file) => (
            <span
              key={file}
              className="rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 py-1 text-[11px] font-data text-[var(--arena-terminal-text-secondary)]"
            >
              {file}
            </span>
          ))}
          {revision.files_changed.length > changedFiles.length && (
            <span className="px-2 py-1 text-[11px] font-data text-[var(--arena-terminal-text-muted)]">
              +{revision.files_changed.length - changedFiles.length}
            </span>
          )}
        </div>
      )}

      {blockerCount > 0 && (
        <div className="mt-3 rounded-lg border border-crimson-500/20 bg-crimson-500/5 px-3 py-2">
          <div className="text-[11px] font-data font-semibold uppercase tracking-wider text-crimson-600 dark:text-crimson-300">
            Promotion blockers
          </div>
          <ul className="mt-1 space-y-1 text-xs text-crimson-700 dark:text-crimson-200">
            {revision.promotion_blockers.slice(0, 3).map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {revision.rejection?.reason && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <div className="text-[11px] font-data font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Rejected
          </div>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
            {revision.rejection.reason}
          </p>
        </div>
      )}

      {revision.paper_evidence && (
        <div className="mt-3 grid gap-2 text-sm font-data text-arena-elements-textSecondary sm:grid-cols-3">
          <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
            <span className="text-arena-elements-textTertiary">Paper trades</span>{" "}
            {revision.paper_evidence.trades ?? 0}
          </div>
          <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
            <span className="text-arena-elements-textTertiary">Paper return</span>{" "}
            {revision.paper_evidence.total_return_pct ?? 0}%
          </div>
          <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
            <span className="text-arena-elements-textTertiary">Max drawdown</span>{" "}
            {revision.paper_evidence.max_drawdown_pct ?? 0}%
          </div>
        </div>
      )}
    </article>
  );
}

export function RevisionArenaTab({
  botId,
  operatorApiUrl,
  operatorKind,
  verificationState,
}: RevisionArenaTabProps) {
  const apiUrl = operatorApiUrl ?? "";
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
  const readRequiresOwner = deploymentKind !== "fleet";
  const query = useRevisionArena(botId, {
    operatorApiUrl,
    operatorKind,
    enabled: verificationState !== "unverified",
    refetchInterval: 15_000,
  });
  const decision = useRevisionDecision(botId, {
    operatorApiUrl,
    operatorKind,
  });
  const [slowLoad, setSlowLoad] = useState(false);

  const sortedRevisions = useMemo(
    () => query.data?.revisions ?? [],
    [query.data?.revisions],
  );

  useEffect(() => {
    if (!query.isLoading) {
      setSlowLoad(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setSlowLoad(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [query.isLoading]);

  const approveRevision = (revisionId: string) => {
    decision.mutate({ revisionId, action: "approve", confirmLive: true });
  };

  const rejectRevision = (revisionId: string) => {
    decision.mutate({
      revisionId,
      action: "reject",
      reason: "Rejected by user in Arena",
    });
  };

  if (verificationState === "unverified") {
    return (
      <OperatorAccessCard
        title="Revision arena unavailable"
        description="Revision state stays disabled until this bot has been freshly verified against the operator."
        apiUrl={apiUrl}
      />
    );
  }

  if (readRequiresOwner && !auth.isAuthenticated) {
    return (
      <OperatorAccessCard
        title="Revision arena owner-only"
        description="Sign with the owner wallet to inspect and approve this instance bot's revisions."
        apiUrl={apiUrl}
      />
    );
  }

  if (query.isLoading) {
    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-6 py-14 text-center text-[var(--arena-terminal-text-secondary)]">
        <div className="i-ph:git-branch mx-auto mb-3 animate-pulse text-3xl text-[var(--arena-terminal-text-muted)]" />
        <h3 className="font-display text-lg font-semibold text-[var(--arena-terminal-text)]">
          {slowLoad ? "Revision arena is still loading" : "Loading revision arena…"}
        </h3>
        <p className="mx-auto mt-2 max-w-xl text-sm">
          {slowLoad
            ? "The operator has not returned revision state yet. You can keep this page open or retry the request."
            : "Loading self-improvement revisions and promotion modes."}
        </p>
        {slowLoad && (
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => { void query.refetch(); }}
          >
            Retry
          </Button>
        )}
      </div>
    );
  }

  if (query.error || !query.data) {
    if (!auth.isAuthenticated && isRevisionArenaAuthError(query.error)) {
      return (
        <OperatorAccessCard
          title="Revision arena owner-only"
          description="Sign with the owner wallet to view and approve revisions."
          apiUrl={apiUrl}
        />
      );
    }

    return (
      <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-6 py-14 text-center text-[var(--arena-terminal-text-secondary)]">
        <div className="i-ph:warning-circle mx-auto mb-3 text-3xl text-crimson-500" />
        <p className="text-sm text-crimson-600 dark:text-crimson-300">
          {query.error instanceof Error
            ? query.error.message
            : "Failed to load revision arena."}
        </p>
      </div>
    );
  }

  const activeRevision = sortedRevisions.find(
    (revision) => revision.revision_id === query.data.active_revision_id,
  );
  const liveRevision = sortedRevisions.find(
    (revision) => revision.revision_id === query.data.live_revision_id,
  );
  const candidateCount = sortedRevisions.filter(
    (revision) => revision.status === "candidate" || revision.status === "staged",
  ).length;
  const blockedCount = sortedRevisions.filter(
    (revision) =>
      revision.status === "blocked" ||
      revision.status === "failed" ||
      revision.promotion_blockers.length > 0,
  ).length;
  const activeMode = activeRevision?.run_mode ?? "research";
  const statCards = [
    {
      label: "Active",
      value: activeRevision?.display_name ?? shortRevisionId(query.data.active_revision_id),
      meta: shortRevisionId(query.data.active_revision_id),
    },
    {
      label: "Live",
      value: liveRevision?.display_name ?? shortRevisionId(query.data.live_revision_id),
      meta: query.data.live_revision_id ? modeLabel(liveRevision?.run_mode ?? "live") : "no fund access",
    },
    {
      label: "Candidates",
      value: candidateCount.toString(),
      meta: `${sortedRevisions.length} revisions`,
    },
    {
      label: "Blocked",
      value: blockedCount.toString(),
      meta: "promotion gates",
    },
  ];

  return (
    <div className="space-y-3">
      <section className="overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
        <div className="border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${statusClass(activeRevision?.status ?? "active")}`} />
                <span className={`rounded-full border px-2.5 py-1 text-xs font-data ${modeClass(activeMode)}`}>
                  {modeLabel(activeMode)}
                </span>
              </div>
              <h2 className="font-display text-2xl font-bold tracking-tight text-[var(--arena-terminal-text)]">
                Evolution Arena
              </h2>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--arena-terminal-text-secondary)]">
                {query.data.invariant}
              </p>
            </div>
            {!auth.isAuthenticated && !readRequiresOwner && (
              <Button
                variant="outline"
                size="sm"
                onClick={auth.authenticate}
                disabled={auth.isAuthenticating}
                className="h-9"
              >
                {auth.isAuthenticating ? "Connecting…" : "Owner Sign In"}
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-0 border-b border-[var(--arena-terminal-border)] sm:grid-cols-2 xl:grid-cols-4">
          {statCards.map((stat) => (
            <div
              key={stat.label}
              className="border-b border-[var(--arena-terminal-border)] px-4 py-3"
            >
              <div className="text-xs font-data uppercase tracking-wider text-[var(--arena-terminal-text-muted)]">
                {stat.label}
              </div>
              <div className="mt-1 truncate font-display text-2xl font-bold text-[var(--arena-terminal-text)]">
                {stat.value}
              </div>
              <div className="mt-1 truncate text-sm font-data text-[var(--arena-terminal-text-muted)]">
                {stat.meta}
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-0 md:grid-cols-3">
          {query.data.modes.map((mode) => (
            <div
              key={mode.mode}
              className="border-b border-[var(--arena-terminal-border)] px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`rounded-full border px-2.5 py-1 text-xs font-data ${modeClass(mode.mode)}`}
                >
                  {modeLabel(mode.mode)}
                </span>
                <span className="text-xs font-data text-[var(--arena-terminal-text-muted)]">
                  {mode.can_touch_funds ? "fund access" : "no fund access"}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-[var(--arena-terminal-text-secondary)]">
                {mode.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
        <div className="flex items-center justify-between border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-4 py-3">
          <div>
            <h3 className="font-display text-lg font-semibold text-[var(--arena-terminal-text)]">
              Revision Timeline
            </h3>
            <p className="mt-1 text-sm text-[var(--arena-terminal-text-secondary)]">
              Candidates, blockers, paper evidence, and live authority.
            </p>
          </div>
          <span className="rounded-full border border-[var(--arena-terminal-border)] px-3 py-1 text-xs font-data text-[var(--arena-terminal-text-muted)]">
            {sortedRevisions.length}
          </span>
        </div>
        {sortedRevisions.length > 0 ? (
          sortedRevisions.map((revision) => (
            <RevisionRow
              key={revision.revision_id}
              revision={revision}
              onApprove={approveRevision}
              onReject={rejectRevision}
              decisionPending={decision.isPending}
              canSubmitDecision={auth.isAuthenticated}
            />
          ))
        ) : (
          <div className="px-6 py-12 text-center text-[var(--arena-terminal-text-secondary)]">
            <div className="i-ph:git-branch mx-auto mb-3 text-3xl text-[var(--arena-terminal-text-muted)]" />
            <h3 className="font-display text-lg font-semibold text-[var(--arena-terminal-text)]">
              No revisions yet
            </h3>
            <p className="mx-auto mt-2 max-w-xl text-sm">
              Self-improvement candidates will appear here after the agent generates and evaluates a revision.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
