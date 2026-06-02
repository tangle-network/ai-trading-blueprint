import { Link } from 'react-router';
import { useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useBotLiveSummary } from '~/lib/hooks/useBotLiveSummary';
import { botStatusLabel, formatNumber, normalizeDisplayNumber } from '~/lib/format';
import { resolveBotDisplayName } from '~/lib/utils/botNames';
import { getBotStrategyChainId } from '~/lib/utils/botStrategy';
import { networks } from '~/lib/contracts/chains';
import {
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
  buildSectionHref: (value: AgentWorkspaceSection) => string;
  buildSectionState?: (value: AgentWorkspaceSection) => unknown;
  backHref?: string;
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
  buildSectionHref,
  buildSectionState,
  backHref,
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
  const focusNavItems = navItems.filter((item) => item.value === 'runs' || item.value === 'chat');
  const copyOperatorAddress = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(bot.operatorAddress).then(() => {
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1400);
    });
  };
  const metrics = [
    {
      label: 'Return',
      value: formatSignedPercent(summary.pnlPercent),
      color: summary.pnlPercent == null
        ? ''
        : summary.pnlPercent >= 0
          ? 'text-arena-elements-icon-success'
          : 'text-arena-elements-icon-error',
    },
    {
      label: 'Sharpe',
      value: formatDecimal(summary.sharpeRatio),
      color: '',
    },
    {
      label: 'Max DD',
      value: formatPercent(summary.maxDrawdown),
      color: summary.maxDrawdown == null ? '' : 'text-crimson-400',
    },
    {
      label: 'Trades',
      value: tradeCount > 0 ? tradeCount.toLocaleString() : '—',
      color: '',
    },
    {
      label: 'Account',
      value: formatPortfolioValue(summary.portfolioValue),
      color: '',
    },
  ];

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {focusMode && (
          <div className="shrink-0 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1">
            <div className="flex h-12 min-w-0 items-center gap-2 px-2">
              <Link
                to={backHref ?? `/arena/bot/${encodeURIComponent(bot.id)}/performance`}
                replace
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-display text-sm font-medium text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                aria-label="Back to agent"
                title="Back to agent"
              >
                <span className="i-ph:arrow-left text-base" aria-hidden="true" />
              </Link>
              {focusNavItems.length > 0 && (
                <WorkspaceNavStrip
                  items={focusNavItems}
                  activeValue={activeSection}
                  getHref={buildSectionHref}
                  getState={buildSectionState}
                  ariaLabel="Agent focus navigation"
                  className="min-w-0 border-0 bg-transparent p-0"
                  buttonClassName="h-9 rounded-lg px-2"
                  iconOnly
                />
              )}
              <div className="ml-auto hidden min-w-0 items-center gap-2 pr-2 sm:flex">
                <Identicon address={bot.operatorAddress as Address} size={22} />
                <span className="max-w-[280px] truncate font-display text-sm font-medium text-arena-elements-textSecondary">
                  {title}
                </span>
              </div>
            </div>
          </div>
        )}

        {!focusMode && (
          <div className="shrink-0 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1 px-3 py-2">
            <div className="mx-auto flex w-full max-w-[1500px] items-center gap-3">
              <Link
                to="/"
                className="hidden h-9 shrink-0 items-center gap-1.5 rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/58 px-2.5 font-display text-sm font-medium text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 lg:inline-flex"
                aria-label="Back to arena leaderboard"
                title="Back to arena leaderboard"
              >
                <span className="i-ph:arrow-left text-base" aria-hidden="true" />
                Arena
              </Link>
              <div className="flex min-w-[240px] max-w-[380px] items-center gap-3">
                <Identicon address={bot.operatorAddress as Address} size={34} />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h1 className="truncate font-display text-lg font-bold tracking-tight text-arena-elements-textPrimary">
                      {title}
                    </h1>
                    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-arena-elements-dividerColor/60 px-1.5 text-xs text-arena-elements-textSecondary">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                      {botStatusLabel(bot.status)}
                    </span>
                    <div className="hidden shrink-0 items-center overflow-hidden rounded-md border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 font-data text-[11px] text-arena-elements-textTertiary sm:inline-flex">
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
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-arena-elements-textTertiary">
                    <span className="truncate">{formatStrategyType(bot.strategyType)}</span>
                    <span aria-hidden="true">/</span>
                    <span>{bot.paperTrade ? 'Paper' : 'Live'}</span>
                    <span aria-hidden="true">/</span>
                    <span className="truncate">{targetNetwork}</span>
                    {bot.verificationState !== 'unverified' && (
                      <span
                        className="i-ph:seal-check-fill shrink-0 text-emerald-500"
                        aria-label="Verified operator"
                        title="Verified operator"
                      />
                    )}
                  </div>
                </div>
              </div>

              <WorkspaceNavStrip
                items={navItems}
                activeValue={activeSection}
                getHref={buildSectionHref}
                getState={buildSectionState}
                ariaLabel="Agent workspace sections"
                className="min-w-0 flex-1 border-0 bg-transparent p-0"
                buttonClassName="h-10 rounded-lg px-3"
                itemClassName="min-w-0 flex-1 justify-center"
              />

              <div className="hidden shrink-0 items-center gap-3 min-[1360px]:flex">
                {metrics.map((metric) => (
                  <div key={metric.label} className="min-w-[58px]">
                    <div className="truncate text-xs text-arena-elements-textTertiary">
                      {metric.label}
                    </div>
                    <div className={`mt-0.5 truncate font-data text-sm font-bold text-arena-elements-textPrimary ${metric.color}`}>
                      {metric.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className={focusMode ? 'min-h-0 flex-1 overflow-hidden p-0' : 'min-h-0 flex-1 overflow-hidden p-2 sm:p-3'}>
          <div className={focusMode ? 'h-full min-h-0' : 'mx-auto h-full min-h-0 w-full max-w-[1500px]'}>
            {children}
          </div>
        </div>
      </section>
    </div>
  );
}
