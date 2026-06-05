import { Link } from 'react-router';
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
import { getBotStrategyChainId, readStrategyNumber } from '~/lib/utils/botStrategy';
import { networks } from '~/lib/contracts/chains';
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

const NAV_GROUPS: Array<{ label: string; values: string[] }> = [
  { label: 'Monitor', values: ['performance', 'positions', 'trades'] },
  { label: 'Autonomy', values: ['runs', 'chat', 'reasoning', 'arena'] },
  { label: 'Admin', values: ['vault', 'envelope', 'controls', 'terminal', 'secrets'] },
];

function groupNavItems(items: BotHeaderNavItem[]) {
  const groupedValues = new Set(NAV_GROUPS.flatMap((group) => group.values));
  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: items.filter((item) => group.values.includes(item.value)),
  })).filter((group) => group.items.length > 0);
  const otherItems = items.filter((item) => !groupedValues.has(item.value));

  if (otherItems.length > 0) {
    groups.push({ label: 'More', items: otherItems });
  }

  return groups;
}

function readInitialCapitalUsd(strategyConfig?: Record<string, unknown>): number | null {
  const value = readStrategyNumber(
    strategyConfig?.initial_capital_usd
      ?? strategyConfig?.initial_capital
      ?? strategyConfig?.cash_balance,
  );
  return value != null && value > 0 ? value : null;
}

function explicitStrategyTitle(identity: string, strategyType: Bot['strategyType']): string {
  const mmMatch = identity.match(/^MM\s+([A-Z0-9./-]+)\s+(.+)$/i);
  if (mmMatch?.[1] && mmMatch?.[2]) {
    return `Market-making bot: ${mmMatch[1]} on ${mmMatch[2]}`;
  }

  if (/^MM\b/i.test(identity)) {
    return identity.replace(/^MM\b/i, 'Market-making bot');
  }

  if (strategyType === 'mm' && !/market.?making/i.test(identity)) {
    return `Market-making bot: ${identity}`;
  }

  return identity;
}

function cleanBotTitle(displayName: string) {
  const statusPattern = /\s*\((active|paused|stopped|unknown|winding down|archived|awaiting secrets)\)\s*$/i;
  const titleWithoutStatus = displayName.replace(statusPattern, '').trim();
  const parentheticalMetadata = Array.from(titleWithoutStatus.matchAll(/\(([^)]+)\)/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const withoutParentheticals = titleWithoutStatus.replace(/\s*\([^)]*\)/g, '').trim();
  const [identity, ...params] = withoutParentheticals.split(/\s+-\s+/);

  return {
    title: identity?.trim() || displayName,
    metadata: [
      ...parentheticalMetadata,
      params.join(' - ').trim(),
    ].filter(Boolean),
  };
}

function formatCapital(value: number | null): string {
  if (value == null) return '—';
  return `$${formatNumber(value, { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

function formatCompactAddress(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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
  const titleParts = cleanBotTitle(displayName);
  const explicitTitle = explicitStrategyTitle(titleParts.title, bot.strategyType);
  const initialCapitalUsd = readInitialCapitalUsd(bot.strategyConfig);
  const maxDrawdownLimit = readStrategyNumber(bot.riskParams?.max_drawdown_pct);
  const targetChainId = getBotStrategyChainId(bot);
  const targetNetwork = targetChainId != null
    ? networks[targetChainId]?.label ?? `Chain ${targetChainId}`
    : 'Unknown network';
  const validatorCount = detail?.validator_endpoints?.length ?? 0;
  const summary = useBotLiveSummary({
    botId: bot.id,
    botName: displayName,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    chainId: bot.chainId,
  });

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
      title: HEADER_RETURN_PERCENT_COPY.title,
    },
    {
      label: 'Sharpe',
      value: formatDecimal(summary.sharpeRatio),
      color: '',
      title: 'Risk-adjusted return based on snapshot-to-snapshot portfolio returns and their variability over the sampled history.',
    },
    {
      label: 'Max DD',
      value: formatPercent(summary.maxDrawdown),
      color: summary.maxDrawdown == null ? '' : 'text-crimson-400',
      title: 'Maximum drawdown: the largest peak-to-trough drop in portfolio value over the sampled history.',
    },
    {
      label: 'Win Rate',
      value: formatPercent(summary.winRate),
      color: '',
      title: 'Estimated win rate: share of new trades between metrics snapshots where portfolio value increased by the next snapshot.',
    },
    { label: 'Portfolio Value', value: formatPortfolioValue(summary.portfolioValue), color: '' },
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
    },
  ];
  const navGroups = groupNavItems(navItems);
  const trustItems = [
    { label: 'Mode', value: bot.paperTrade ? 'Paper' : 'Live' },
    { label: 'Network', value: targetNetwork },
    { label: 'Capital', value: formatCapital(initialCapitalUsd) },
    { label: 'Max DD', value: maxDrawdownLimit == null ? '—' : `${formatNumber(maxDrawdownLimit, { maximumFractionDigits: 1 })}%` },
    { label: 'Cadence', value: '30s snapshots' },
  ];

  return (
    <div className="sticky top-[var(--header-height)] z-30 mb-4 -mx-4 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1 px-4 py-2 shadow-[0_8px_20px_rgba(15,23,42,0.06)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.22)] sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="mx-auto max-w-[1320px]">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
              <Link
                to="/arena"
                className="inline-flex items-center gap-1.5 font-display font-medium text-arena-elements-textTertiary transition-colors hover:text-violet-700 dark:hover:text-violet-400"
              >
                <span className="i-ph:arrow-left text-sm" aria-hidden="true" />
                Tangle
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

            <div className="flex flex-col gap-1.5 md:flex-row md:items-end">
              <h1 className="min-w-0 max-w-[720px] break-words font-display text-2xl font-bold leading-[1.08] tracking-tight sm:text-[1.65rem]">
                {explicitTitle}
              </h1>
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pb-0.5 text-sm text-arena-elements-textTertiary">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-data" title={bot.operatorAddress}>
                  <span className="text-arena-elements-textSecondary">Operator</span>
                  <Identicon address={bot.operatorAddress as Address} size={16} />
                  <code className="select-all rounded border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2 px-1.5 py-0.5 text-xs text-arena-elements-textSecondary">
                    {formatCompactAddress(bot.operatorAddress)}
                  </code>
                </span>
                {validatorCount > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="i-ph:shield-check text-sm text-violet-500" aria-hidden="true" />
                    <span>{validatorCount} validator{validatorCount !== 1 ? 's' : ''}</span>
                  </span>
                )}
              </div>
            </div>

            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-data text-xs text-arena-elements-textTertiary">
              {[...titleParts.metadata, ...trustItems.map((item) => `${item.label}: ${item.value}`)].map((label) => (
                <span
                  key={label}
                  className="inline-flex min-h-5 items-center text-arena-elements-textSecondary"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          <Tooltip.Provider delayDuration={150}>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 xl:min-w-[590px]">
              {metrics.map((stat) => (
                <div
                  key={stat.label}
                  className="min-h-[54px] rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] md:min-h-[60px]"
                >
                  <div className="mb-1 flex min-h-[16px] items-start gap-1 text-[10px] font-data font-medium uppercase leading-tight tracking-wider text-arena-elements-textTertiary md:text-[11px]">
                    <span className="break-words">{stat.label}</span>
                    {stat.title && (
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            type="button"
                            aria-label={`About ${stat.label}: ${stat.title}`}
                            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/70"
                          >
                            <span className="i-ph:info text-[11px]" aria-hidden="true" />
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
                  <div className={`truncate font-data text-lg font-bold leading-tight md:text-xl xl:text-[1.35rem] ${stat.color}`}>
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          </Tooltip.Provider>
        </div>

        <div className="mt-1.5 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          {navItems.length > 0 && onTabChange && (
            <nav
              className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
              aria-label="Agent workspace sections"
            >
              {navGroups.map((group) => (
                <div
                  key={group.label}
                  className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/50 p-0.5"
                >
                  <span className="px-1.5 text-[10px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
                    {group.label}
                  </span>
                  {group.items.map((item) => {
                    const selected = item.value === activeTab;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => onTabChange(item.value)}
                        aria-current={selected ? 'page' : undefined}
                        className={`group inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 lg:h-10 lg:px-3 lg:text-[15px] ${
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
                </div>
              ))}
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
