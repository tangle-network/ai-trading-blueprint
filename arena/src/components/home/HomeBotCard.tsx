import { Link } from 'react-router';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { Card, CardContent } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { SparklineChart } from '~/components/arena/SparklineChart';
import { Identicon } from '~/components/shared/Identicon';
import type { Bot } from '~/lib/types/bot';
import { STRATEGY_SHORT } from '~/lib/format';

const STATUS_BADGE: Record<string, { variant: 'success' | 'amber' | 'secondary' | 'destructive'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  paused: { variant: 'amber', label: 'Paused' },
  needs_config: { variant: 'amber', label: 'Needs Config' },
  stopped: { variant: 'secondary', label: 'Stopped' },
};

export function HomeBotCard({
  bot,
  onConfigure,
}: {
  bot: Bot;
  onConfigure?: () => void;
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
    : STATUS_BADGE[bot.status] ?? STATUS_BADGE.stopped;

  return (
    <Card className={`${borderColor} transition-all duration-200`}>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          {/* Strategy icon */}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
            <span className={`text-lg font-display font-bold ${iconColor}`}>
              {strategyInitial}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-display font-semibold truncate">
                {bot.name}
              </span>
              <Badge variant={badge.variant} className="text-[10px]">
                {badge.label}
              </Badge>
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
        </div>

        {/* Metrics row */}
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            {/* PnL */}
            <div>
              {bot.pnlPercent !== 0 ? (
                <span className={`font-data font-bold text-xl ${
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
                <span>${bot.tvl >= 1000 ? `${(bot.tvl / 1000).toFixed(0)}K` : bot.tvl.toFixed(0)} TVL</span>
              )}
              {bot.totalTrades > 0 && (
                <span>{bot.totalTrades} trades</span>
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
                <span className={`text-xs font-data font-bold px-1.5 py-0.5 rounded ${
                  bot.avgValidatorScore >= 85
                    ? 'bg-emerald-700/10 dark:bg-emerald-500/10 text-arena-elements-icon-success'
                    : bot.avgValidatorScore >= 70
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-crimson-500/10 text-crimson-600 dark:text-crimson-400'
                }`}>
                  {bot.avgValidatorScore}
                </span>
                <span className="text-[11px] font-data text-arena-elements-textTertiary">score</span>
              </div>
            )}
          </div>

          {/* Sparkline */}
          <div className="shrink-0">
            {bot.sparklineData.length > 1 ? (
              <SparklineChart data={bot.sparklineData} positive={bot.pnlPercent >= 0} width={100} height={40} />
            ) : (
              <div className="w-[100px] h-[40px] rounded bg-arena-elements-background-depth-3/50 flex items-center justify-center">
                <span className="text-[10px] font-data text-arena-elements-textTertiary">No data</span>
              </div>
            )}
          </div>
        </div>

        {/* Needs config banner */}
        {isNeedsConfig && onConfigure && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/15">
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
                <Link to={`/arena/bot/${bot.id}`}>
                  <div className="i-ph:chart-line-up text-xs mr-1" />
                  Details
                </Link>
              </Button>
              {hasVault && (
                <Button variant="outline" size="sm" asChild className="text-xs">
                  <Link to={`/vault/${bot.vaultAddress}`}>
                    <div className="i-ph:vault text-xs mr-1" />
                    Vault
                  </Link>
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
