import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Badge, Identicon } from '@tangle-network/blueprint-ui/components';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useBotLiveSummary } from '~/lib/hooks/useBotLiveSummary';
import { botStatusBadgeVariant, botStatusLabel, formatNumber, normalizeDisplayNumber } from '~/lib/format';
import { resolveBotDisplayName } from '~/lib/utils/botNames';
import { getBotStrategyChainId, readStrategyNumber } from '~/lib/utils/botStrategy';
import { networks } from '~/lib/contracts/chains';
import { HEADER_RETURN_PERCENT_COPY } from './metricCopy';

export type AgentWorkspaceSection = 'performance' | 'portfolio' | 'runs' | 'chat' | 'operations';

export interface AgentWorkspaceNavItem {
  value: AgentWorkspaceSection;
  label: string;
  icon: string;
  badge?: ReactNode;
}

interface AgentWorkspaceShellProps {
  bot: Bot;
  displayName: string;
  activeSection: AgentWorkspaceSection;
  navItems: AgentWorkspaceNavItem[];
  onSectionChange: (value: AgentWorkspaceSection) => void;
  focusMode?: boolean;
  children: ReactNode;
}

function readInitialCapitalUsd(strategyConfig?: Record<string, unknown>): number | null {
  const value = readStrategyNumber(
    strategyConfig?.initial_capital_usd
      ?? strategyConfig?.initial_capital
      ?? strategyConfig?.cash_balance,
  );
  return value != null && value > 0 ? value : null;
}

function formatCompactAddress(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatCapital(value: number | null): string {
  if (value == null) return '—';
  return `$${formatNumber(value, { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

function cleanBotTitle(displayName: string) {
  const statusPattern = /\s*\((active|paused|stopped|unknown|winding down|archived|awaiting secrets)\)\s*$/i;
  return displayName.replace(statusPattern, '').trim() || displayName;
}

export function AgentWorkspaceShell({
  bot,
  displayName,
  activeSection,
  navItems,
  onSectionChange,
  focusMode = false,
  children,
}: AgentWorkspaceShellProps) {
  const { data: detail } = useBotDetail(bot.id, bot.operatorApiUrl, bot.operatorKind);
  const title = cleanBotTitle(resolveBotDisplayName({
    primaryName: detail?.name,
    fallbackName: displayName,
    strategyType: detail?.strategy_type ?? bot.strategyType,
  }));
  const initialCapitalUsd = readInitialCapitalUsd(bot.strategyConfig);
  const maxDrawdownLimit = readStrategyNumber(bot.riskParams?.max_drawdown_pct);
  const targetChainId = getBotStrategyChainId(bot);
  const targetNetwork = targetChainId != null
    ? networks[targetChainId]?.label ?? `Chain ${targetChainId}`
    : 'Unknown network';
  const summary = useBotLiveSummary({
    botId: bot.id,
    botName: displayName,
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    chainId: bot.chainId,
  });
  const [showAgentRail, setShowAgentRail] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;

    const mediaQuery = window.matchMedia('(min-width: 1536px)');
    const syncAgentRail = () => setShowAgentRail(mediaQuery.matches);

    syncAgentRail();
    mediaQuery.addEventListener('change', syncAgentRail);
    return () => {
      mediaQuery.removeEventListener('change', syncAgentRail);
    };
  }, []);

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
      title: 'Risk-adjusted return over sampled account value snapshots.',
    },
    {
      label: 'Max DD',
      value: formatPercent(summary.maxDrawdown),
      color: summary.maxDrawdown == null ? '' : 'text-crimson-400',
      title: 'Maximum drawdown over sampled account value history.',
    },
    { label: 'Trades', value: bot.totalTrades > 0 ? bot.totalTrades.toLocaleString() : '—', color: '' },
    { label: 'Equity', value: formatPortfolioValue(summary.portfolioValue), color: '' },
  ];

  const trustItems = [
    { label: 'Mode', value: bot.paperTrade ? 'Paper' : 'Live' },
    { label: 'Network', value: targetNetwork },
    { label: 'Capital', value: formatCapital(initialCapitalUsd) },
    {
      label: 'Max DD',
      value: maxDrawdownLimit == null
        ? '—'
        : `${formatNumber(maxDrawdownLimit, { maximumFractionDigits: 1 })}%`,
    },
  ];

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {showAgentRail && (
      <aside className="hidden w-56 shrink-0 flex-col border-r border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/76 2xl:flex">
        <div className="border-b border-arena-elements-dividerColor/70 p-3">
          <Link
            to="/"
            className="mb-3 inline-flex items-center gap-1.5 text-sm font-display font-medium text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary"
          >
            <span className="i-ph:arrow-left text-sm" aria-hidden="true" />
            Arena
          </Link>
          <div className="flex items-center gap-2.5">
            <Identicon address={bot.operatorAddress as Address} size={34} />
            <div className="min-w-0">
              <div className="truncate font-display text-base font-semibold text-arena-elements-textPrimary">
                {title}
              </div>
              <code className="font-data text-xs text-arena-elements-textTertiary" title={bot.operatorAddress}>
                {formatCompactAddress(bot.operatorAddress)}
              </code>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge variant={botStatusBadgeVariant(bot.status)}>{botStatusLabel(bot.status)}</Badge>
            <Badge variant="accent">{bot.strategyType}</Badge>
            {bot.verificationState === 'unverified' && <Badge variant="outline">Unverified</Badge>}
          </div>
        </div>

        <nav className="shrink-0 space-y-1 p-2" aria-label="Agent workspace sections">
          {navItems.map((item) => {
            const selected = item.value === activeSection;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => onSectionChange(item.value)}
                aria-current={selected ? 'page' : undefined}
                className={`group flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                  selected
                    ? 'bg-violet-500/14 text-arena-elements-textPrimary'
                    : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                }`}
              >
                <span className={`${item.icon} text-base ${selected ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary group-hover:text-arena-elements-textSecondary'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badge}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-arena-elements-dividerColor/70 p-3">
          <div className="space-y-2">
            {trustItems.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-3 text-xs">
                <span className="font-data uppercase tracking-wider text-arena-elements-textTertiary">
                  {item.label}
                </span>
                <span className="truncate text-right font-data text-arena-elements-textSecondary">
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>
      )}

      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {focusMode && !showAgentRail && (
          <nav
            className="absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] gap-1 overflow-x-auto rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/88 p-1 shadow-xl backdrop-blur-xl"
            aria-label="Agent focus navigation"
          >
            {navItems.map((item) => {
              const selected = item.value === activeSection;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => onSectionChange(item.value)}
                  aria-current={selected ? 'page' : undefined}
                  className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                    selected
                      ? 'bg-violet-500/14 text-arena-elements-textPrimary'
                      : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                  }`}
                >
                  <span
                    className={`${item.icon} text-base ${
                      selected ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary'
                    }`}
                    aria-hidden="true"
                  />
                  <span>{item.label}</span>
                  {item.badge}
                </button>
              );
            })}
          </nav>
        )}

        {!focusMode && (
          <div className="shrink-0 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/76 px-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                {!showAgentRail ? (
                  <div className="flex items-center gap-2">
                    <Identicon address={bot.operatorAddress as Address} size={24} />
                    <h1 className="truncate font-display text-lg font-semibold text-arena-elements-textPrimary">
                      {title}
                    </h1>
                  </div>
                ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate font-display text-lg font-semibold text-arena-elements-textPrimary">
                    {title}
                  </h1>
                  <span className="font-data text-xs text-arena-elements-textTertiary">
                    {bot.paperTrade ? 'Paper' : 'Live'} · {targetNetwork}
                  </span>
                </div>
                )}
              </div>

              <Tooltip.Provider delayDuration={120}>
                <div className="hidden shrink-0 grid-cols-5 gap-1.5 sm:grid">
                  {metrics.map((metric) => (
                    <Tooltip.Root key={metric.label}>
                      <Tooltip.Trigger asChild>
                        <div className="min-w-[78px] rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/62 px-2 py-1.5 md:min-w-[86px]">
                          <div className="font-data text-[9px] font-medium uppercase tracking-wider text-arena-elements-textTertiary">
                            {metric.label}
                          </div>
                          <div className={`mt-0.5 truncate font-data text-sm font-bold ${metric.color}`}>
                            {metric.value}
                          </div>
                        </div>
                      </Tooltip.Trigger>
                      {metric.title && (
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="bottom"
                            align="end"
                            sideOffset={8}
                            className="z-50 max-w-[240px] rounded-lg border border-[var(--arena-elements-borderColor)] bg-[var(--arena-elements-bg-depth-2)] px-3 py-2 text-xs leading-relaxed text-arena-elements-textSecondary shadow-xl"
                          >
                            {metric.title}
                            <Tooltip.Arrow className="fill-[var(--arena-elements-bg-depth-2)]" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      )}
                    </Tooltip.Root>
                  ))}
                </div>
              </Tooltip.Provider>
            </div>
            {!showAgentRail && (
            <nav
              className="mt-2 flex gap-1 overflow-x-auto pb-0.5"
              aria-label="Agent workspace sections"
            >
              {navItems.map((item) => {
                const selected = item.value === activeSection;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => onSectionChange(item.value)}
                    aria-current={selected ? 'page' : undefined}
                    className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-display font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                      selected
                        ? 'bg-violet-500/14 text-arena-elements-textPrimary'
                        : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                    }`}
                  >
                    <span
                      className={`${item.icon} text-base ${
                        selected ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary'
                      }`}
                      aria-hidden="true"
                    />
                    <span>{item.label}</span>
                    {item.badge}
                  </button>
                );
              })}
            </nav>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
          {children}
        </div>
      </section>
    </div>
  );
}
