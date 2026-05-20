import { useMemo } from "react";
import type { BotOperatorKind, BotVerificationState } from "~/lib/types/bot";
import {
  type RevisionArenaEntry,
  type RevisionRunMode,
  useRevisionArena,
} from "~/lib/hooks/useBotApi";
import { AuthBanner } from "~/components/bot-detail/AuthBanner";
import { OperatorAccessCard } from "~/components/operator/OperatorAccessCard";
import { useOperatorAuth } from "~/lib/hooks/useOperatorAuth";

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

function RevisionRow({ revision }: { revision: RevisionArenaEntry }) {
  const blockerCount = revision.promotion_blockers.length;
  const changedFiles = revision.files_changed.slice(0, 4);

  return (
    <div className="border-b border-arena-elements-dividerColor/50 px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${statusClass(revision.status)}`} />
            <h3 className="text-sm font-display font-semibold text-arena-elements-textPrimary">
              {revision.display_name}
            </h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-data ${modeClass(revision.run_mode)}`}
            >
              {modeLabel(revision.run_mode)}
            </span>
            <span className="rounded-full border border-arena-elements-dividerColor/60 px-2 py-0.5 text-[11px] font-data text-arena-elements-textSecondary">
              {revision.status}
            </span>
          </div>
          <p className="mt-2 text-sm text-arena-elements-textSecondary">
            {revision.user_intent}
          </p>
        </div>
        <div className="text-right text-[11px] font-data text-arena-elements-textTertiary">
          <div>{formatTime(revision.created_at)}</div>
          <div className="mt-1">{shortHash(revision.patch_sha256)}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-[11px] font-data text-arena-elements-textSecondary sm:grid-cols-3">
        <div>
          <span className="text-arena-elements-textTertiary">Parent</span>{" "}
          {revision.parent_revision_id ?? "none"}
        </div>
        <div>
          <span className="text-arena-elements-textTertiary">Run</span>{" "}
          {revision.run_id ?? "none"}
        </div>
        <div>
          <span className="text-arena-elements-textTertiary">Live execution</span>{" "}
          {revision.can_execute_live ? "enabled" : "blocked"}
        </div>
      </div>

      {changedFiles.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {changedFiles.map((file) => (
            <span
              key={file}
              className="rounded-md border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/30 px-2 py-1 text-[11px] font-data text-arena-elements-textSecondary"
            >
              {file}
            </span>
          ))}
          {revision.files_changed.length > changedFiles.length && (
            <span className="px-2 py-1 text-[11px] font-data text-arena-elements-textTertiary">
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

      {revision.paper_evidence && (
        <div className="mt-3 grid gap-2 text-[11px] font-data text-arena-elements-textSecondary sm:grid-cols-3">
          <div>
            <span className="text-arena-elements-textTertiary">Paper trades</span>{" "}
            {revision.paper_evidence.trades ?? 0}
          </div>
          <div>
            <span className="text-arena-elements-textTertiary">Paper return</span>{" "}
            {revision.paper_evidence.total_return_pct ?? 0}%
          </div>
          <div>
            <span className="text-arena-elements-textTertiary">Max drawdown</span>{" "}
            {revision.paper_evidence.max_drawdown_pct ?? 0}%
          </div>
        </div>
      )}
    </div>
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
  const query = useRevisionArena(botId, {
    operatorApiUrl,
    operatorKind,
    enabled: verificationState !== "unverified",
    refetchInterval: 15_000,
  });

  const sortedRevisions = useMemo(
    () => query.data?.revisions ?? [],
    [query.data?.revisions],
  );

  if (verificationState === "unverified") {
    return (
      <OperatorAccessCard
        title="Revision arena unavailable"
        description="Revision state stays disabled until this bot has been freshly verified against the operator."
        apiUrl={apiUrl}
      />
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <AuthBanner
        onAuth={auth.authenticate}
        isAuthenticating={auth.isAuthenticating}
        error={auth.error}
      />
    );
  }

  if (query.isLoading) {
    return (
      <div className="glass-card rounded-xl py-16 text-center text-arena-elements-textSecondary">
        <div className="i-ph:git-branch mx-auto mb-3 animate-pulse text-3xl text-arena-elements-textTertiary" />
        Loading revision arena...
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="glass-card rounded-xl py-16 text-center text-arena-elements-textSecondary">
        <div className="i-ph:warning-circle mx-auto mb-3 text-3xl text-crimson-500" />
        <p className="text-sm text-crimson-600 dark:text-crimson-300">
          {query.error instanceof Error
            ? query.error.message
            : "Failed to load revision arena."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="glass-card rounded-xl border border-arena-elements-dividerColor p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-display font-semibold text-arena-elements-textPrimary">
              Revision Arena
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-arena-elements-textSecondary">
              {query.data.invariant}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-right text-[11px] font-data sm:min-w-[260px]">
            <div className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 p-2">
              <div className="text-arena-elements-textTertiary">Active</div>
              <div className="mt-1 text-arena-elements-textPrimary">
                {query.data.active_revision_id}
              </div>
            </div>
            <div className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 p-2">
              <div className="text-arena-elements-textTertiary">Live</div>
              <div className="mt-1 text-arena-elements-textPrimary">
                {query.data.live_revision_id ?? "none"}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="glass-card overflow-hidden rounded-xl border border-arena-elements-dividerColor">
        {sortedRevisions.map((revision) => (
          <RevisionRow key={revision.revision_id} revision={revision} />
        ))}
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {query.data.modes.map((mode) => (
          <div
            key={mode.mode}
            className="rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-1/25 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-data ${modeClass(mode.mode)}`}
              >
                {modeLabel(mode.mode)}
              </span>
              <span className="text-[11px] font-data text-arena-elements-textTertiary">
                {mode.can_touch_funds ? "fund access" : "no fund access"}
              </span>
            </div>
            <p className="mt-2 text-xs text-arena-elements-textSecondary">
              {mode.description}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
