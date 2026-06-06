import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import { SparklineChart } from '~/components/arena/SparklineChart';
import type { Bot } from '~/lib/types/bot';
import { STRATEGY_SHORT } from '~/lib/format';
import { botStatusBadgeVariant, botStatusLabel } from '~/lib/format';
import { buildVaultPath } from '~/lib/utils/vaultRoute';

const STATUS_BADGE: Record<string, { tone: 'success' | 'warning' | 'muted' | 'danger' | 'outline'; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  paused: { tone: 'warning', label: 'Paused' },
  needs_config: { tone: 'warning', label: 'Needs Config' },
  winding_down: { tone: 'warning', label: 'Winding Down' },
  archived: { tone: 'muted', label: 'Archived' },
  unknown: { tone: 'outline', label: 'Unknown' },
  stopped: { tone: 'muted', label: 'Stopped' },
};

function statusToneClass(tone: 'success' | 'warning' | 'muted' | 'danger' | 'outline') {
  if (tone === 'success') {
    return 'border-[color-mix(in_srgb,var(--arena-terminal-success)_32%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-success)_8%,var(--arena-terminal-panel))] text-[var(--arena-terminal-success)]';
  }
  if (tone === 'warning') {
    return 'border-[color-mix(in_srgb,var(--arena-terminal-warning)_34%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_9%,var(--arena-terminal-panel))] text-[var(--arena-terminal-warning)]';
  }
  if (tone === 'danger') {
    return 'border-[color-mix(in_srgb,var(--arena-terminal-danger)_34%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-danger)_8%,var(--arena-terminal-panel))] text-[var(--arena-terminal-danger)]';
  }
  if (tone === 'outline') {
    return 'border-[var(--arena-terminal-border-hover)] bg-transparent text-[var(--arena-terminal-text-secondary)]';
  }
  return 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-text-muted)]';
}

function StatusChip({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'muted' | 'danger' | 'outline';
  children: ReactNode;
}) {
  return (
    <span className={`inline-flex h-5 items-center border px-1.5 font-mono text-[10px] uppercase tracking-[0.08em] ${statusToneClass(tone)}`}>
      {children}
    </span>
  );
}

function MetricCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger' | 'muted';
}) {
  const toneClass = tone === 'success'
    ? 'text-[var(--arena-terminal-success)]'
    : tone === 'danger'
      ? 'text-[var(--arena-terminal-danger)]'
      : tone === 'muted'
        ? 'text-[var(--arena-terminal-text-subtle)]'
        : 'text-[var(--arena-terminal-text)]';

  return (
    <span className="min-w-0 border-l border-[var(--arena-terminal-border)] px-2 first:border-l-0">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--arena-terminal-text-subtle)]">
        {label}
      </span>
      <span className={`mt-0.5 block truncate font-data text-[15px] font-bold leading-none tabular-nums ${toneClass}`}>
        {value}
      </span>
    </span>
  );
}

function formatUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function ActionLink({
  to,
  icon,
  children,
}: {
  to: string;
  icon: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="inline-flex h-8 items-center gap-1.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-2.5 font-display text-xs font-semibold text-[var(--arena-terminal-text-secondary)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
    >
      <span className={`${icon} text-sm`} aria-hidden="true" />
      {children}
    </Link>
  );
}

export function HomeBotCard({
  bot,
  onConfigure,
  onDismiss,
}: {
  bot: Bot;
  onConfigure?: () => void;
  onDismiss?: () => void;
}) {
  const hasVault = bot.vaultAddress && bot.vaultAddress !== zeroAddress;
  const isProvisioning = bot.id.startsWith('provision:');
  const isNeedsConfig = bot.status === 'needs_config';
  const isPaper = bot.paperTrade === true;

  const borderColor = bot.status === 'active'
    ? 'border-[color-mix(in_srgb,var(--arena-terminal-success)_22%,var(--arena-terminal-border))] hover:border-[color-mix(in_srgb,var(--arena-terminal-success)_42%,var(--arena-terminal-border))]'
    : isNeedsConfig || isProvisioning
      ? 'border-[color-mix(in_srgb,var(--arena-terminal-warning)_26%,var(--arena-terminal-border))] hover:border-[color-mix(in_srgb,var(--arena-terminal-warning)_44%,var(--arena-terminal-border))]'
      : 'border-[var(--arena-terminal-border)] hover:border-[var(--arena-terminal-border-hover)]';

  const strategyInitial = STRATEGY_SHORT[bot.strategyType]?.[0] ?? bot.strategyType[0]?.toUpperCase() ?? 'A';
  const iconBg = bot.status === 'active'
    ? 'bg-emerald-700/10 dark:bg-emerald-500/10'
    : isNeedsConfig || isProvisioning
      ? 'bg-amber-500/10'
      : 'bg-arena-elements-background-depth-3';
  const iconColor = bot.status === 'active'
    ? 'text-arena-elements-icon-success'
    : isNeedsConfig || isProvisioning
      ? 'text-amber-500'
      : 'text-arena-elements-textTertiary';

  const fallbackBadgeVariant = botStatusBadgeVariant(bot.status);
  const badge = isProvisioning
    ? { tone: 'warning' as const, label: 'Provisioning' }
    : STATUS_BADGE[bot.status] ?? {
        tone: fallbackBadgeVariant === 'destructive'
          ? 'danger'
          : fallbackBadgeVariant === 'success'
            ? 'success'
            : fallbackBadgeVariant === 'amber'
              ? 'warning'
              : fallbackBadgeVariant === 'outline'
                ? 'outline'
                : 'muted',
        label: botStatusLabel(bot.status),
      };
  const pnlTone = bot.pnlPercent > 0 ? 'success' : bot.pnlPercent < 0 ? 'danger' : 'muted';
  const pnlValue = bot.pnlPercent !== 0
    ? `${bot.pnlPercent >= 0 ? '+' : ''}${bot.pnlPercent.toFixed(1)}%`
    : '-';
  const riskTone = bot.avgValidatorScore >= 85
    ? 'success'
    : bot.avgValidatorScore > 0 && bot.avgValidatorScore < 70
      ? 'danger'
      : undefined;

  return (
    <article
      className={`grid min-h-[74px] border bg-[var(--arena-terminal-panel)] transition-[border-color,background-color] duration-150 hover:bg-[var(--arena-terminal-panel-strong)] ${borderColor}`}
    >
      <div className="grid min-w-0 gap-2 p-2.5 min-[980px]:grid-cols-[minmax(18rem,1.25fr)_minmax(20rem,0.9fr)_108px_auto] min-[980px]:items-center">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] ${iconBg}`}>
            <span className={`font-display text-base font-bold ${iconColor}`}>{strategyInitial}</span>
          </div>

          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`}
                className="min-w-0 truncate font-display text-[15px] font-semibold leading-tight text-[var(--arena-terminal-text)] transition-colors hover:text-[var(--arena-terminal-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
              >
                {bot.name}
              </Link>
              <StatusChip tone={badge.tone}>{badge.label}</StatusChip>
              {isPaper && <StatusChip tone="outline">Paper</StatusChip>}
              {bot.verificationState === 'unverified' && <StatusChip tone="outline">Unverified</StatusChip>}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
              <span className="truncate">{STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}</span>
              {bot.serviceId > 0 && (
                <>
                  <span className="h-1 w-1 shrink-0 bg-[var(--arena-terminal-text-subtle)]" aria-hidden="true" />
                  <span className="shrink-0">Service #{bot.serviceId}</span>
                </>
              )}
              <span className="h-1 w-1 shrink-0 bg-[var(--arena-terminal-text-subtle)]" aria-hidden="true" />
              <Identicon address={bot.operatorAddress as Address} size={16} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
          <MetricCell label="PNL" value={pnlValue} tone={pnlTone} />
          <MetricCell label="NAV" value={formatUsd(bot.tvl)} />
          <MetricCell label="Exec" value={bot.totalTrades > 0 ? String(bot.totalTrades) : '-'} />
          <MetricCell label="Risk" value={bot.avgValidatorScore > 0 ? String(bot.avgValidatorScore) : '-'} tone={riskTone} />
        </div>

        <div className="hidden justify-end min-[980px]:flex">
          {bot.sparklineData.length > 1 ? (
            <SparklineChart data={bot.sparklineData} positive={bot.pnlPercent >= 0} width={96} height={32} />
          ) : (
            <div className="flex h-8 w-24 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
              <span className="font-mono text-[10px] text-[var(--arena-terminal-text-subtle)]">No chart</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 min-[980px]:justify-end">
          {isProvisioning ? (
            <div className="flex h-8 items-center gap-2 border border-[var(--arena-terminal-border)] px-2.5 font-mono text-xs text-[var(--arena-terminal-text-muted)]">
              <div className="h-2.5 w-2.5 shrink-0 animate-spin border-[1.5px] border-[var(--arena-terminal-warning)] border-t-transparent" />
              Setting up
            </div>
          ) : (
            <>
              {isNeedsConfig && onConfigure && (
                <button
                  type="button"
                  onClick={onConfigure}
                  className="inline-flex h-8 items-center gap-1.5 border border-[color-mix(in_srgb,var(--arena-terminal-warning)_34%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_9%,var(--arena-terminal-panel))] px-2.5 font-display text-xs font-semibold text-[var(--arena-terminal-warning)] transition-colors hover:bg-[color-mix(in_srgb,var(--arena-terminal-warning)_14%,var(--arena-terminal-panel))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-warning)]"
                >
                  <span className="i-ph:key text-sm" aria-hidden="true" />
                  Configure
                </button>
              )}
              <ActionLink to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`} icon="i-ph:chart-line-up">
                Details
              </ActionLink>
              {hasVault && (
                <ActionLink to={buildVaultPath(bot.vaultAddress, bot.chainId)} icon="i-ph:vault">
                  Vault
                </ActionLink>
              )}
              {onDismiss && (bot.status === 'needs_config' || (bot.status === 'stopped' && !bot.secretsConfigured)) && (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="inline-flex h-8 w-8 items-center justify-center border border-[var(--arena-terminal-border)] text-[var(--arena-terminal-text-muted)] transition-colors hover:border-[color-mix(in_srgb,var(--arena-terminal-danger)_42%,var(--arena-terminal-border))] hover:bg-[color-mix(in_srgb,var(--arena-terminal-danger)_8%,var(--arena-terminal-panel))] hover:text-[var(--arena-terminal-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-danger)]"
                  aria-label="Dismiss from dashboard"
                >
                  <span className="i-ph:x text-sm" aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
