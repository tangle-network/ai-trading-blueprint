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
  { label: 'Trading', values: ['performance', 'positions', 'trades'] },
  { label: 'Workflow', values: ['runs', 'chat', 'reasoning', 'arena'] },
  { label: 'Ops', values: ['vault', 'envelope', 'controls', 'terminal', 'secrets'] },
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

function readStrategyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function titleCaseToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function formatCostModel(strategyConfig?: Record<string, unknown>): string {
  const gasCostUsd = readStrategyNumber(strategyConfig?.paper_gas_cost_usd);
  const referenceLiquidityUsd = readStrategyNumber(strategyConfig?.paper_reference_liquidity_usd);
  const parts = [
    gasCostUsd == null ? null : `paper gas ${formatCapital(gasCostUsd)}`,
    referenceLiquidityUsd == null ? null : `liquidity ref ${formatCapital(referenceLiquidityUsd)}`,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' · ') : 'fees/slippage tracked per trade when reported';
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
  const protocol = readStrategyString(bot.strategyConfig?.protocol);
  const validatorCount = detail?.validator_endpoints?.length ?? 0;
  const deploymentMode = bot.operatorKind === 'cloud'
    ? 'Cloud operator'
    : bot.operatorKind === 'instance'
      ? 'Instance operator'
      : bot.operatorKind === 'tee'
        ? 'TEE operator'
        : 'Operator';
  const provenanceItems = [
    { label: 'Provenance', value: bot.verificationState === 'unverified' ? 'Unverified operator snapshot' : 'Authoritative operator snapshot' },
    { label: 'Operator', value: `${deploymentMode} ${formatCompactAddress(bot.operatorAddress)}` },
    { label: 'Workflow', value: bot.workflowId ? `#${bot.workflowId}` : 'No workflow id published' },
    { label: 'Validators', value: validatorCount > 0 ? `${validatorCount} live endpoint${validatorCount === 1 ? '' : 's'}` : 'No validators published' },
  ];
  const executionItems = [
    { label: 'Venue', value: protocol ? `${targetNetwork} / ${titleCaseToken(protocol)}` : targetNetwork },
    { label: 'Mode', value: bot.paperTrade ? 'Paper simulation; no wallet execution' : 'Live execution behind signed controls' },
    { label: 'Costs', value: formatCostModel(bot.strategyConfig) },
    { label: 'Wallet scope', value: 'Read-only until you connect; signing only in Envelope, Controls, or Deploy' },
  ];
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
  const availableNavItems = new Set(navItems.map((item) => item.value));
  const actionItems = [
    { value: 'trades', label: 'Review Trades', icon: 'i-ph:swap', variant: 'default' as const },
    { value: 'runs', label: 'Open Runs', icon: 'i-ph:list-checks', variant: 'outline' as const },
    { value: 'controls', label: 'Manage Risk', icon: 'i-ph:sliders-horizontal', variant: 'outline' as const },
  ].filter((item) => availableNavItems.has(item.value));
  const trustItems = [
    { label: 'Mode', value: bot.paperTrade ? 'Paper' : 'Live' },
    { label: 'Network', value: targetNetwork },
    { label: 'Capital', value: formatCapital(initialCapitalUsd) },
    { label: 'Max DD', value: maxDrawdownLimit == null ? '—' : `${formatNumber(maxDrawdownLimit, { maximumFractionDigits: 1 })}%` },
    { label: 'Telemetry', value: '30s public snapshots' },
  ];

  return (
    <div className="sticky top-[var(--header-height)] z-30 mb-5 -mx-4 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1 px-4 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.06)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.22)] sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="mx-auto max-w-[1800px]">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
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
              <h1 className="min-w-0 max-w-[920px] break-words font-display text-2xl font-bold leading-tight tracking-tight md:text-3xl">
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

            <div className="mt-3 flex flex-wrap gap-2">
              {[...titleParts.metadata, ...trustItems.map((item) => `${item.label}: ${item.value}`)].map((label) => (
                <span
                  key={label}
                  className="inline-flex min-h-7 items-center rounded-full border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2 px-2.5 py-1 font-data text-[11px] uppercase tracking-wider text-arena-elements-textSecondary"
                >
                  {label}
                </span>
              ))}
            </div>

            <div className="mt-3 grid max-w-[1180px] gap-2 lg:grid-cols-2">
              {[
                { label: 'Verified Context', items: provenanceItems },
                { label: 'Risk And Permissions', items: executionItems },
              ].map((group) => (
                <div
                  key={group.label}
                  className="rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 p-3"
                >
                  <div className="mb-2 flex items-center gap-2 font-data text-[11px] uppercase tracking-wider text-arena-elements-textTertiary">
                    <span className="i-ph:shield-check text-sm text-violet-500" aria-hidden="true" />
                    {group.label}
                  </div>
                  <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                    {group.items.map((item) => (
                      <div key={item.label} className="min-w-0">
                        <dt className="font-data text-[11px] uppercase tracking-wider text-arena-elements-textTertiary">
                          {item.label}
                        </dt>
                        <dd className="mt-0.5 break-words font-display text-sm font-medium leading-snug text-arena-elements-textPrimary" title={item.value}>
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>

            {onTabChange && actionItems.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {actionItems.map((item) => (
                  <Button
                    key={item.value}
                    size="sm"
                    variant={item.variant}
                    className="h-9 px-3"
                    onClick={() => onTabChange(item.value)}
                  >
                    <span className={`${item.icon} text-sm`} aria-hidden="true" />
                    {item.label}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <Tooltip.Provider delayDuration={150}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:min-w-[860px] xl:grid-cols-6">
              {metrics.map((stat) => (
                <div
                  key={stat.label}
                  className="min-h-[76px] rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                >
                  <div className="mb-1 flex min-h-[28px] items-start gap-1.5 text-[11px] font-data font-medium uppercase leading-tight tracking-wider text-arena-elements-textTertiary">
                    <span className="break-words">{stat.label}</span>
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
                  <div className={`truncate font-data text-2xl font-bold leading-tight ${stat.color}`}>
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          </Tooltip.Provider>
        </div>

        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {navItems.length > 0 && onTabChange && (
            <nav
              className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
              aria-label="Agent workspace sections"
            >
              {navGroups.map((group) => (
                <div
                  key={group.label}
                  className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/50 p-1"
                >
                  <span className="px-2 text-[10px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
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
