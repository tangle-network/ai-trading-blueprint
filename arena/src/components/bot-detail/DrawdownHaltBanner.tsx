/**
 * Circuit-breaker halt surface for the bot detail page.
 *
 * A bot whose latest metrics snapshot shows drawdown at or beyond its
 * `max_drawdown_pct` mandate is halted by the operator's circuit breaker:
 * every tick is skipped until the submitter acknowledges the loss via
 * `POST /api/bots/{id}/risk/acknowledge-drawdown`. Without this banner the
 * halt is silent — the bot just stops trading forever.
 *
 * Halt detection mirrors the operator's own check (latest snapshot
 * `drawdown_pct` >= mandate from `risk_params.max_drawdown_pct`), using data
 * the arena already consumes. Everyone sees the halted state; only the
 * submitter wallet (canCommand) gets the acknowledge-and-resume action, which
 * matches the endpoint's submitter-only authorization.
 */

import { useState } from 'react';
import { useAcknowledgeDrawdown, useBotMetrics } from '~/lib/hooks/useBotApi';
import { formatNumber } from '~/lib/format';
import type { Bot } from '~/lib/types/bot';

function readMandateMaxDrawdownPct(riskParams: Record<string, unknown> | undefined): number | null {
  const raw = riskParams?.max_drawdown_pct;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string'
      ? Number(raw)
      : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatPct(value: number): string {
  return `${formatNumber(value, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
}

interface DrawdownHaltBannerProps {
  bot: Bot;
  canCommand: boolean;
}

export function DrawdownHaltBanner({ bot, canCommand }: DrawdownHaltBannerProps) {
  const [confirming, setConfirming] = useState(false);
  const mandatePct = readMandateMaxDrawdownPct(bot.riskParams);
  const metricsQuery = useBotMetrics(bot.id, 1, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    enabled: mandatePct != null,
    refetchInterval: 60_000,
  });
  const acknowledge = useAcknowledgeDrawdown(bot.id, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
  });

  if (mandatePct == null) return null;
  const snapshots = metricsQuery.data;
  const latest = snapshots && snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const drawdownPct = latest != null && Number.isFinite(latest.drawdown_pct)
    ? latest.drawdown_pct
    : null;
  // Hide until we have an authoritative snapshot; a tripped breaker is the
  // exception, so never flash the alert while the query resolves.
  if (drawdownPct == null || drawdownPct < mandatePct) return null;

  const drawdownLabel = formatPct(drawdownPct);
  const mandateLabel = formatPct(mandatePct);
  const isPending = acknowledge.isPending;

  return (
    <div
      role="alert"
      aria-label="Trading halted by drawdown breaker"
      className="flex flex-col gap-3 border border-[color-mix(in_srgb,var(--arena-terminal-danger)_36%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-danger)_8%,var(--arena-terminal-panel))] px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--arena-terminal-danger)] animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-semibold text-[var(--arena-terminal-danger)]">
            Trading halted — drawdown breaker tripped
          </div>
          <p className="mt-0.5 text-xs text-[var(--arena-terminal-text-secondary)]">
            Drawdown <span className="font-data font-semibold tabular-nums">{drawdownLabel}</span> breached
            the <span className="font-data font-semibold tabular-nums">{mandateLabel}</span> mandate.
            Every tick is skipped until the loss is acknowledged
            {canCommand ? '.' : ' by the agent creator.'}
          </p>
          {acknowledge.isSuccess && (
            <p role="status" className="mt-1.5 text-xs font-semibold text-[var(--arena-terminal-success)]">
              Breaker re-armed — drawdown now measures from current NAV.
            </p>
          )}
          {acknowledge.isError && (
            <p role="status" className="mt-1.5 text-xs font-semibold text-[var(--arena-terminal-danger)]">
              Could not re-arm the breaker: {acknowledge.error.message}
            </p>
          )}
        </div>
        {canCommand && !confirming && !acknowledge.isSuccess && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex h-8 shrink-0 items-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-2.5 font-display text-xs font-semibold text-[var(--arena-terminal-text-secondary)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-danger)]"
          >
            Acknowledge &amp; resume
          </button>
        )}
      </div>
      {canCommand && confirming && !acknowledge.isSuccess && (
        <div className="flex flex-col gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-[var(--arena-terminal-text-secondary)]">
            Accept the {drawdownLabel} loss as the new baseline and re-arm the breaker.
            The loss stays in history; future drawdown is measured from current NAV.
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={isPending}
              onClick={() => acknowledge.mutate(undefined, { onSettled: () => setConfirming(false) })}
              className="inline-flex h-8 items-center border border-[color-mix(in_srgb,var(--arena-terminal-danger)_42%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-danger)_12%,var(--arena-terminal-panel))] px-2.5 font-display text-xs font-semibold text-[var(--arena-terminal-danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--arena-terminal-danger)_18%,var(--arena-terminal-panel))] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-danger)]"
            >
              {isPending ? 'Re-arming…' : `Accept ${drawdownLabel} loss & re-arm`}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setConfirming(false)}
              className="inline-flex h-8 items-center border border-[var(--arena-terminal-border)] px-2.5 font-display text-xs font-semibold text-[var(--arena-terminal-text-muted)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
