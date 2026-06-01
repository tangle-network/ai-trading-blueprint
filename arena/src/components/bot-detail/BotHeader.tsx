import { Link } from 'react-router';
import { m } from 'framer-motion';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Badge, Button, Identicon } from '@tangle-network/blueprint-ui/components';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useBotLiveSummary } from '~/lib/hooks/useBotLiveSummary';
import { botStatusBadgeVariant, botStatusLabel, formatNumber, normalizeDisplayNumber } from '~/lib/format';
import { resolveBotDisplayName } from '~/lib/utils/botNames';
import { buildVaultPath } from '~/lib/utils/vaultRoute';
import { HEADER_RETURN_PERCENT_COPY } from './metricCopy';

interface BotHeaderProps {
  bot: Bot;
  activeTab?: string;
  navItems?: BotHeaderNavItem[];
  onTabChange?: (value: string) => void;
}

export interface BotHeaderNavItem {
  value: string;
  label: string;
  icon: string;
  badge?: ReactNode;
}

export function BotHeader({ bot, activeTab, navItems = [], onTabChange }: BotHeaderProps) {
  const { data: detail } = useBotDetail(bot.id, bot.operatorApiUrl, bot.operatorKind);
  const hasVaultAddress = Boolean(
    bot.vaultAddress && bot.vaultAddress !== '0x0000000000000000000000000000000000000000',
  );
  const displayName = resolveBotDisplayName({
    primaryName: detail?.name,
    fallbackName: bot.name,
    strategyType: detail?.strategy_type ?? bot.strategyType,
  });
  const summary = useBotLiveSummary({
    botId: bot.id,
    botName: displayName,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    chainId: bot.chainId,
  });
  const validatorCount = detail?.validator_endpoints?.length ?? 0;

  const formatSignedPercent = (value: number | null) => {
    if (value == null) return '—';
    const displayValue = normalizeDisplayNumber(value, 1);
    return `${displayValue > 0 ? '+' : ''}${formatNumber(displayValue, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    })}%`;
  };

  const formatPercent = (value: number | null) => {
    if (value == null) return '—';
    return `${formatNumber(value, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    })}%`;
  };

  const formatDecimal = (value: number | null) => {
    if (value == null) return '—';
    return formatNumber(value, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    });
  };

  const formatPortfolioValue = (value: number | null) => {
    if (value == null) return '—';
    const displayValue = normalizeDisplayNumber(value, 0);
    if (displayValue >= 1000) {
      return `$${formatNumber(displayValue / 1000, {
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
      })}K`;
    }
    return `$${formatNumber(displayValue, { maximumFractionDigits: 0 })}`;
  };

  const metrics = [
    {
      label: HEADER_RETURN_PERCENT_COPY.label,
      value: formatSignedPercent(summary.pnlPercent),
      color: summary.pnlPercent == null
        ? ''
        : summary.pnlPercent >= 0
          ? 'text-arena-elements-icon-success'
          : 'text-arena-elements-icon-error',
      glow: summary.pnlPercent == null
        ? ''
        : summary.pnlPercent >= 0
          ? 'glow-emerald'
          : 'glow-crimson',
      title: HEADER_RETURN_PERCENT_COPY.title,
    },
    {
      label: 'Sharpe',
      value: formatDecimal(summary.sharpeRatio),
      color: '',
      glow: '',
      title: 'Risk-adjusted return based on snapshot-to-snapshot portfolio returns and their variability over the sampled history.',
    },
    {
      label: 'Max DD',
      value: formatPercent(summary.maxDrawdown),
      color: summary.maxDrawdown == null ? '' : 'text-crimson-400',
      glow: '',
      title: 'Maximum drawdown: the largest peak-to-trough drop in portfolio value over the sampled history.',
    },
    {
      label: 'Win Rate',
      value: formatPercent(summary.winRate),
      color: '',
      glow: '',
      title: 'Estimated win rate: share of new trades between metrics snapshots where portfolio value increased by the next snapshot.',
    },
    { label: 'Portfolio Value', value: formatPortfolioValue(summary.portfolioValue), color: '', glow: '' },
    {
      label: 'Avg Score',
      value: summary.avgValidatorScore == null ? '—' : `${summary.avgValidatorScore}`,
      color: summary.avgValidatorScore == null
        ? ''
        : summary.avgValidatorScore >= 85
          ? 'text-arena-elements-icon-success'
          : summary.avgValidatorScore >= 70
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-arena-elements-icon-error',
      glow: '',
    },
  ];

  return (
    <div className="sticky top-[var(--header-height)] z-30 mb-5 -mx-4 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/92 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="mx-auto max-w-[1800px]">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <Link
                to="/arena"
                className="inline-flex items-center gap-1.5 font-display font-medium text-arena-elements-textTertiary transition-colors hover:text-violet-700 dark:hover:text-violet-400"
              >
                <span className="i-ph:arrow-left text-sm" aria-hidden="true" />
                Arena
              </Link>
              <span className="text-arena-elements-textTertiary/50">/</span>
              <Badge variant={botStatusBadgeVariant(bot.status)} className="h-7">
                <div className={`h-1.5 w-1.5 rounded-full ${
                  bot.status === 'active'
                    ? 'bg-emerald-700 animate-glow-pulse dark:bg-emerald-400'
                    : (bot.status === 'paused' || bot.status === 'needs_config' || bot.status === 'winding_down')
                      ? 'bg-amber-400'
                      : 'bg-arena-elements-textTertiary'
                }`} />
                {botStatusLabel(bot.status)}
              </Badge>
              <Badge variant="accent" className="h-7">{bot.strategyType}</Badge>
              {bot.verificationState === 'unverified' && (
                <Badge variant="outline" className="h-7">Unverified</Badge>
              )}
            </div>

            <div className="flex flex-col gap-2 md:flex-row md:items-end">
              <h1 className="min-w-0 truncate font-display text-2xl font-bold tracking-tight md:text-3xl">
                {displayName}
              </h1>
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pb-0.5 text-sm text-arena-elements-textTertiary">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-data">
                  <span className="text-arena-elements-textSecondary">Operator</span>
                  <Identicon address={bot.operatorAddress as Address} size={16} />
                  <span className="truncate">{bot.operatorAddress.slice(0, 6)}...{bot.operatorAddress.slice(-4)}</span>
                </span>
                {validatorCount > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="i-ph:shield-check text-sm text-violet-500" aria-hidden="true" />
                    <span>{validatorCount} validator{validatorCount !== 1 ? 's' : ''}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <Tooltip.Provider delayDuration={150}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:min-w-[720px] xl:grid-cols-6">
              {metrics.map((stat, i) => (
                <m.div
                  key={stat.label}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.025, duration: 0.25 }}
                  className={`rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/58 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${stat.glow}`}
                >
                  <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-data font-medium uppercase tracking-wider text-arena-elements-textTertiary">
                    <span className="truncate">{stat.label}</span>
                    {stat.title && (
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            type="button"
                            aria-label={`About ${stat.label}: ${stat.title}`}
                            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/70"
                          >
                            <span className="i-ph:info text-[13px]" aria-hidden="true" />
                          </button>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="bottom"
                            align="end"
                            sideOffset={8}
                            className="z-50 max-w-[260px] rounded-lg border border-[var(--arena-elements-borderColor)] bg-[var(--arena-elements-bg-depth-2)] px-3 py-2 text-xs normal-case leading-relaxed tracking-normal text-arena-elements-textSecondary shadow-xl"
                          >
                            {stat.title}
                            <Tooltip.Arrow className="fill-[var(--arena-elements-bg-depth-2)]" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    )}
                  </div>
                  <div className={`truncate font-data text-lg font-bold leading-tight ${stat.color}`}>
                    {stat.value}
                  </div>
                </m.div>
              ))}
            </div>
          </Tooltip.Provider>
        </div>

        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {navItems.length > 0 && onTabChange && (
            <nav
              className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
              aria-label="Agent workspace sections"
            >
              {navItems.map((item) => {
                const selected = item.value === activeTab;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => onTabChange(item.value)}
                    aria-current={selected ? 'page' : undefined}
                    className={`group inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                      selected
                        ? 'border-violet-500/35 bg-violet-500/14 text-arena-elements-textPrimary shadow-[0_0_0_1px_rgba(142,89,255,0.08)]'
                        : 'border-transparent text-arena-elements-textSecondary hover:border-arena-elements-dividerColor/70 hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                    }`}
                  >
                    <span className={`${item.icon} text-base ${selected ? 'text-violet-600 dark:text-violet-300' : 'text-arena-elements-textTertiary group-hover:text-arena-elements-textSecondary'}`} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.badge}
                  </button>
                );
              })}
            </nav>
          )}

          {hasVaultAddress && (
            <Button asChild size="sm" className="h-10 w-fit px-4 shadow-[0_0_24px_rgba(142,89,255,0.28)]">
              <Link to={buildVaultPath(bot.vaultAddress, bot.chainId)}>
                <span className="i-ph:wallet text-sm" aria-hidden="true" />
                View Vault
                <span className="i-ph:arrow-square-out text-[11px]" aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
