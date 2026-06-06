import { Link } from 'react-router';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { Badge, Button, Identicon } from '@tangle-network/blueprint-ui/components';
import { SparklineChart } from '~/components/arena/SparklineChart';
import type { Bot } from '~/lib/types/bot';
import { STRATEGY_SHORT } from '~/lib/format';
import { botStatusBadgeVariant, botStatusLabel } from '~/lib/format';
import { buildVaultPath } from '~/lib/utils/vaultRoute';

const STATUS_BADGE: Record<string, { variant: 'success' | 'amber' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  paused: { variant: 'amber', label: 'Paused' },
  needs_config: { variant: 'amber', label: 'Needs Config' },
  winding_down: { variant: 'amber', label: 'Winding Down' },
  archived: { variant: 'secondary', label: 'Archived' },
  unknown: { variant: 'outline', label: 'Unknown' },
  stopped: { variant: 'secondary', label: 'Stopped' },
};

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
    ? 'border-emerald-700/15 dark:border-emerald-500/15 hover:border-emerald-700/30 dark:hover:border-emerald-500/30'
    : isNeedsConfig || isProvisioning
      ? 'border-amber-500/20 hover:border-amber-500/35'
      : 'border-arena-elements-borderColor/40 hover:border-arena-elements-borderColor/60';

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

  const badge = isProvisioning
    ? { variant: 'amber' as const, label: 'Provisioning' }
    : STATUS_BADGE[bot.status] ?? {
        variant: botStatusBadgeVariant(bot.status),
        label: botStatusLabel(bot.status),
      };

  return (
    <article
      className={`border bg-[var(--arena-terminal-panel)] transition-[border-color,background-color] duration-150 ${borderColor}`}
    >
      <div className="space-y-2.5 p-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          {/* Strategy icon */}
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center border border-arena-elements-borderColor/35 ${iconBg}`}>
            <span className={`font-display text-base font-bold ${iconColor}`}>
              {strategyInitial}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="truncate font-display text-sm font-semibold">
                {bot.name}
              </span>
              <Badge variant={badge.variant} className="text-[10px]">
                {badge.label}
              </Badge>
              {bot.verificationState === 'unverified' && (
                <Badge variant="outline" className="text-[10px]">
                  Unverified
                </Badge>
              )}
              {isPaper && (
                <Badge variant="outline" className="text-[10px]">Paper</Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs font-data text-arena-elements-textTertiary">
              <span>{bot.strategyType}</span>
              {bot.serviceId > 0 && (
                <>
                  <span className="text-arena-elements-borderColor">&middot;</span>
                  <span>Service #{bot.serviceId}</span>
                </>
              )}
            </div>
          </div>

          {/* Operator identicon */}
          <Identicon address={bot.operatorAddress as Address} size={24} />

          {/* Dismiss button for pending/unconfigured agents */}
          {onDismiss && (bot.status === 'needs_config' || (bot.status === 'stopped' && !bot.secretsConfigured)) && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onDismiss(); }}
              className="shrink-0 p-1 text-arena-elements-textTertiary transition-colors hover:text-crimson-400"
              aria-label="Dismiss from dashboard"
            >
              <div className="i-ph:x text-sm" />
            </button>
          )}
        </div>

        {/* Metrics row */}
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            {/* PnL */}
            <div>
              {bot.pnlPercent !== 0 ? (
                <span className={`font-data text-xl font-bold ${
                  bot.pnlPercent >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error'
                }`}>
                  {bot.pnlPercent >= 0 ? '+' : ''}{bot.pnlPercent.toFixed(1)}%
                </span>
              ) : (
                <span className="font-data text-xl text-arena-elements-textTertiary">&mdash;</span>
              )}
              {bot.pnlAbsolute !== 0 && (
                <span className={`ml-2 text-xs font-data ${
                  bot.pnlAbsolute >= 0 ? 'text-arena-elements-icon-success/70' : 'text-arena-elements-icon-error/70'
                }`}>
                  {bot.pnlAbsolute >= 0 ? '+' : ''}${Math.abs(bot.pnlAbsolute).toFixed(0)}
                </span>
              )}
            </div>

            {/* Stats */}
            <div className="flex items-center gap-3 text-xs font-data text-arena-elements-textSecondary flex-wrap">
              {bot.tvl > 0 && (
                <span>${bot.tvl >= 1000 ? `${(bot.tvl / 1000).toFixed(0)}K` : bot.tvl.toFixed(0)} NAV</span>
              )}
              {bot.totalTrades > 0 && (
                <span>{bot.totalTrades} executions</span>
              )}
              {bot.sharpeRatio > 0 && (
                <span>{bot.sharpeRatio.toFixed(1)} Sharpe</span>
              )}
              {bot.winRate > 0 && (
                <span>{(bot.winRate * 100).toFixed(0)}% win</span>
              )}
            </div>

            {/* Validator score */}
            {bot.avgValidatorScore > 0 && (
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 font-data text-xs font-bold ${
                  bot.avgValidatorScore >= 85
                    ? 'bg-emerald-700/10 dark:bg-emerald-500/10 text-arena-elements-icon-success'
                    : bot.avgValidatorScore >= 70
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-crimson-500/10 text-crimson-600 dark:text-crimson-400'
                }`}>
                  {bot.avgValidatorScore}
                </span>
                <span className="text-[11px] font-data text-arena-elements-textTertiary">risk</span>
              </div>
            )}
          </div>

          {/* Sparkline */}
          <div className="shrink-0">
            {bot.sparklineData.length > 1 ? (
              <SparklineChart data={bot.sparklineData} positive={bot.pnlPercent >= 0} width={100} height={40} />
            ) : (
              <div className="flex h-[40px] w-[100px] items-center justify-center border border-arena-elements-borderColor/30 bg-arena-elements-background-depth-3/50">
                <span className="text-[10px] font-data text-arena-elements-textTertiary">No data</span>
              </div>
            )}
          </div>
        </div>

        {/* Needs config banner */}
        {isNeedsConfig && onConfigure && (
          <div className="flex items-center gap-2 border border-amber-500/15 bg-amber-500/5 p-2.5">
            <div className="i-ph:key text-sm text-amber-500 shrink-0" />
            <span className="text-xs font-data text-arena-elements-textSecondary flex-1">
              Configure API keys to activate trading
            </span>
            <Button size="sm" onClick={onConfigure} className="text-xs h-7 px-3 shrink-0">
              Configure
            </Button>
          </div>
        )}

        {/* Actions row */}
        <div className="flex items-center gap-2 pt-1">
          {isProvisioning ? (
            <div className="flex items-center gap-2 text-xs font-data text-arena-elements-textTertiary">
              <div className="w-2.5 h-2.5 rounded-full border-[1.5px] border-amber-400 border-t-transparent animate-spin shrink-0" />
              Setting up...
            </div>
          ) : (
            <>
              <Button variant="outline" size="sm" asChild className="text-xs">
                <Link to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`}>
                  <div className="i-ph:chart-line-up text-xs mr-1" />
                  Details
                </Link>
              </Button>
              {hasVault && (
                <Button variant="outline" size="sm" asChild className="text-xs">
                  <Link to={buildVaultPath(bot.vaultAddress, bot.chainId)}>
                    <div className="i-ph:vault text-xs mr-1" />
                    Vault
                  </Link>
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
