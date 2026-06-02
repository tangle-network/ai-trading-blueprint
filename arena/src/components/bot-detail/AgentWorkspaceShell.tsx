import { Link } from 'react-router';
import { useState, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Badge, Identicon } from '@tangle-network/blueprint-ui/components';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useBotLiveSummary } from '~/lib/hooks/useBotLiveSummary';
import { botStatusBadgeVariant, botStatusLabel, formatNumber, normalizeDisplayNumber } from '~/lib/format';
import { resolveBotDisplayName } from '~/lib/utils/botNames';
import { getBotStrategyChainId } from '~/lib/utils/botStrategy';
import { networks } from '~/lib/contracts/chains';
import { HEADER_RETURN_PERCENT_COPY } from './metricCopy';
import {
  WorkspaceMetric,
  WorkspaceNavStrip,
  type WorkspaceNavItem,
} from './shared/WorkspacePrimitives';

export type AgentWorkspaceSection = 'performance' | 'portfolio' | 'runs' | 'chat' | 'operations';

export interface AgentWorkspaceNavItem extends WorkspaceNavItem<AgentWorkspaceSection> {}

interface AgentWorkspaceShellProps {
  bot: Bot;
  displayName: string;
  activeSection: AgentWorkspaceSection;
  navItems: AgentWorkspaceNavItem[];
  onSectionChange: (value: AgentWorkspaceSection) => void;
  focusMode?: boolean;
  children: ReactNode;
}

function formatCompactAddress(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getExplorerAddressUrl(chainId: number | undefined, address: string): { label: string; url: string } | null {
  if (chainId == null) return null;
  const explorer = networks[chainId]?.chain.blockExplorers?.default;
  if (!explorer?.url) return null;
  return {
    label: explorer.name,
    url: `${explorer.url.replace(/\/$/, '')}/address/${address}`,
  };
}

function cleanBotTitle(displayName: string) {
  const statusPattern = /\s*\((active|paused|stopped|unknown|winding down|archived|awaiting secrets)\)\s*$/i;
  return displayName.replace(statusPattern, '').trim() || displayName;
}

function formatStrategyType(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
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
    enabled: !focusMode,
  });
  const [addressCopied, setAddressCopied] = useState(false);
  const explorerAddress = getExplorerAddressUrl(targetChainId ?? bot.chainId, bot.operatorAddress);

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

  const tradeCount = Math.max(summary.tradeCount ?? 0, bot.totalTrades ?? 0);
  const copyOperatorAddress = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(bot.operatorAddress).then(() => {
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1400);
    });
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
      label: '30D Sharpe',
      value: formatDecimal(summary.sharpeRatio),
      color: '',
      title: 'Risk-adjusted return over sampled account value snapshots.',
    },
    {
      label: 'Max Drawdown',
      value: formatPercent(summary.maxDrawdown),
      color: summary.maxDrawdown == null ? '' : 'text-crimson-400',
      title: 'Maximum drawdown over sampled account value history.',
    },
    {
      label: 'Executions',
      value: tradeCount > 0 ? tradeCount.toLocaleString() : '—',
      color: '',
      title: 'Largest observed execution count from live metrics, trade ledger, and operator summary.',
    },
    {
      label: 'NAV',
      value: formatPortfolioValue(summary.portfolioValue),
      color: '',
      title: 'Latest priced account value, falling back to the latest account snapshot when portfolio pricing is unavailable.',
    },
  ];

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {focusMode && (
          <div className="shrink-0 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/88 px-3 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.12)] backdrop-blur-xl">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/58 px-2.5 font-display text-sm font-medium text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                aria-label="Back to agent performance"
                title="Back to agent performance"
              >
                <span className="i-ph:arrow-left text-base" aria-hidden="true" />
                <span className="hidden sm:inline">Agent</span>
              </Link>
              <WorkspaceNavStrip
                items={navItems}
                activeValue={activeSection}
                onSelect={onSectionChange}
                ariaLabel="Agent focus navigation"
                className="ml-auto min-w-0 border-0 bg-transparent p-0"
                buttonClassName="h-9 rounded-lg"
              />
            </div>
          </div>
        )}

        {!focusMode && (
          <div className="shrink-0 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/76 px-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <Identicon address={bot.operatorAddress as Address} size={28} />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h1 className="truncate font-display text-lg font-semibold text-arena-elements-textPrimary">
                      {title}
                    </h1>
                    <div className="hidden shrink-0 items-center overflow-hidden rounded-md border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 font-data text-xs text-arena-elements-textTertiary sm:inline-flex">
                      <code className="px-2 py-1" title={bot.operatorAddress}>
                        {formatCompactAddress(bot.operatorAddress)}
                      </code>
                      <button
                        type="button"
                        onClick={copyOperatorAddress}
                        className="inline-flex h-7 w-7 items-center justify-center border-l border-arena-elements-dividerColor/60 text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                        aria-label={addressCopied ? 'Operator address copied' : 'Copy operator address'}
                        title={addressCopied ? 'Copied' : 'Copy operator address'}
                      >
                        <span className={addressCopied ? 'i-ph:check text-sm text-emerald-500' : 'i-ph:copy text-sm'} aria-hidden="true" />
                      </button>
                      {explorerAddress && (
                        <a
                          href={explorerAddress.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-7 w-7 items-center justify-center border-l border-arena-elements-dividerColor/60 text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                          aria-label={`View operator address on ${explorerAddress.label}`}
                          title={`View on ${explorerAddress.label}`}
                        >
                          <span className="i-ph:arrow-square-out text-sm" aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge variant={botStatusBadgeVariant(bot.status)}>{botStatusLabel(bot.status)}</Badge>
                    <Badge variant="accent">{formatStrategyType(bot.strategyType)}</Badge>
                    {bot.verificationState === 'unverified' && <Badge variant="outline">Unverified</Badge>}
                    <span className="font-data text-xs text-arena-elements-textTertiary">
                      {bot.paperTrade ? 'Paper mode' : 'Live'} · {targetNetwork}
                    </span>
                  </div>
                </div>
              </div>

              <Tooltip.Provider delayDuration={120}>
                <div className="hidden shrink-0 grid-cols-5 gap-1.5 sm:grid">
                  {metrics.map((metric) => (
                      <Tooltip.Root key={metric.label}>
                        <Tooltip.Trigger asChild>
                          <WorkspaceMetric
                            label={metric.label}
                            value={metric.value}
                            valueClassName={metric.color}
                          />
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
            <WorkspaceNavStrip
              items={navItems}
              activeValue={activeSection}
              onSelect={onSectionChange}
              ariaLabel="Agent workspace sections"
              className="mt-2 border-0 bg-transparent p-0 pb-0.5"
              buttonClassName="rounded-lg"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
          {children}
        </div>
      </section>
    </div>
  );
}
