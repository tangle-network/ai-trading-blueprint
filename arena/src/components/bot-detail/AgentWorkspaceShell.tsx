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
import {
  fillCountEvidenceTitle,
  resolveFillCountEvidence,
} from '~/lib/tradeEvidence';

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
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
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

  const fillCountEvidence = resolveFillCountEvidence({
    metricTradeCount: summary.tradeCount,
    rosterTradeCount: bot.totalTrades,
  });
  const tradeCount = fillCountEvidence.value;
  const copyOperatorAddress = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(bot.operatorAddress).then(() => {
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1400);
    });
  };
  const accountValue = formatPortfolioValue(summary.portfolioValue);
  const returnValue = formatSignedPercent(summary.pnlPercent);
  const returnTone = summary.pnlPercent == null
    ? 'text-[#949e9c]'
    : summary.pnlPercent >= 0
      ? 'text-[#00d395]'
      : 'text-[#ff4d6d]';
  const compactStats = [
    { label: 'Sharpe', value: formatDecimal(summary.sharpeRatio), tone: 'text-[#f6fefd]' },
    { label: 'DD', value: formatPercent(summary.maxDrawdown), tone: summary.maxDrawdown == null ? 'text-[#f6fefd]' : 'text-[#ff4d6d]' },
    {
      label: 'Fills',
      value: tradeCount > 0 ? tradeCount.toLocaleString() : '—',
      tone: 'text-[#f6fefd]',
      title: fillCountEvidenceTitle(fillCountEvidence),
    },
  ];

  const mobileHeader = (
    <div className="shrink-0 border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1 px-2 py-2 lg:hidden">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/leaderboard"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
          aria-label="Back to agents"
          title="Back to agents"
        >
          <span className="i-ph:arrow-left text-base" aria-hidden="true" />
        </Link>
        <Identicon address={bot.operatorAddress as Address} size={30} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-base font-semibold text-arena-elements-textPrimary">
            {title}
          </h1>
          <div className="truncate font-data text-xs text-arena-elements-textTertiary">
            {formatStrategyType(bot.strategyType)} / {bot.paperTrade ? 'Paper' : 'Live'} / {targetNetwork}
          </div>
        </div>
      </div>
      <WorkspaceNavStrip
        items={navItems}
        activeValue={activeSection}
        getHref={buildSectionHref}
        getState={buildSectionState}
        ariaLabel="Agent workspace sections"
        className="mt-2 border-0 bg-transparent p-0"
        buttonClassName="h-9 rounded-lg px-2.5"
      />
    </div>
  );

  const agentRail = (
    <aside className="hidden w-[244px] shrink-0 flex-col border-r border-[#273035] bg-[#0b1418] lg:flex xl:w-[264px]">
      <div className="border-b border-[#273035] p-3">
        <Link
          to="/leaderboard"
          className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2 font-data text-xs text-[#949e9c] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
        >
          <span className="i-ph:arrow-left text-sm" aria-hidden="true" />
          Agents
        </Link>

        <div className="flex min-w-0 items-start gap-3">
          <Identicon address={bot.operatorAddress as Address} size={40} />
          <div className="min-w-0 flex-1">
            <h1 className="line-clamp-2 font-display text-lg font-semibold leading-tight text-[#f6fefd]">
              {title}
            </h1>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 font-data text-[11px] text-[#949e9c]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#50d2c1]" aria-hidden="true" />
              <span className="truncate">{botStatusLabel(bot.status)}</span>
              <span className="text-[#575e62]" aria-hidden="true">/</span>
              <span className="truncate">{bot.paperTrade ? 'Paper' : 'Live'}</span>
            </div>
          </div>
        </div>

        <section
          className="mt-4 rounded-[6px] border border-[#273035] bg-[#081013] p-3"
          aria-label="Agent account state"
          data-testid="agent-account-state"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-data text-[10px] uppercase tracking-[0.14em] text-[#697371]">
                Account
              </div>
              <div className="mt-1 truncate font-data text-2xl font-semibold leading-none text-[#f6fefd] tabular-nums">
                {accountValue}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="font-data text-[10px] uppercase tracking-[0.14em] text-[#697371]">
                Return
              </div>
              <div className={`mt-1 font-data text-base font-semibold leading-none tabular-nums ${returnTone}`}>
                {returnValue}
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 divide-x divide-[#273035] border-t border-[#273035] pt-3">
            {compactStats.map((stat) => (
              <div key={stat.label} className="min-w-0 px-2 first:pl-0 last:pr-0" title={stat.title}>
                <div className="truncate font-data text-[10px] uppercase tracking-[0.08em] text-[#697371]">
                  {stat.label}
                </div>
                <div className={`mt-1 truncate font-data text-sm font-semibold tabular-nums ${stat.tone}`}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-3 overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f]">
          <div className="flex min-w-0 items-center">
            <code className="min-w-0 flex-1 truncate px-2.5 py-2 font-data text-xs text-[#d2dad7]" title={bot.operatorAddress}>
              {formatCompactAddress(bot.operatorAddress)}
            </code>
            <button
              type="button"
              onClick={copyOperatorAddress}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-l border-[#273035] text-[#949e9c] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
              aria-label={addressCopied ? 'Operator address copied' : 'Copy operator address'}
              title={addressCopied ? 'Copied' : 'Copy operator address'}
            >
              <span className={addressCopied ? 'i-ph:check text-sm text-[#50d2c1]' : 'i-ph:copy text-sm'} aria-hidden="true" />
            </button>
            {explorerAddress && (
              <a
                href={explorerAddress.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-l border-[#273035] text-[#949e9c] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label={`View operator address on ${explorerAddress.label}`}
                title={`View on ${explorerAddress.label}`}
              >
                <span className="i-ph:arrow-square-out text-sm" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5" aria-label="Agent workspace sections">
        {navItems.map((item) => {
          const selected = item.value === activeSection;
          return (
            <Link
              key={item.value}
              to={buildSectionHref(item.value)}
              state={buildSectionState?.(item.value)}
              aria-current={selected ? 'page' : undefined}
              className={`group flex h-10 min-w-0 items-center gap-2 rounded-[5px] px-2.5 font-display text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
                selected
                  ? 'bg-[#143c38] text-[#f6fefd] shadow-[inset_3px_0_0_rgba(80,210,193,0.9)]'
                  : 'text-[#949e9c] hover:bg-[#16242a] hover:text-[#f6fefd]'
              }`}
            >
              <span
                className={`${item.icon} shrink-0 text-base ${
                  selected ? 'text-[#50d2c1]' : 'text-[#949e9c] group-hover:text-[#d2dad7]'
                }`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[#273035] p-3">
        <div className="grid gap-1.5 font-data text-[11px] text-[#949e9c]">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-[#697371]">Strategy</span>
            <span className="truncate text-[#d2dad7]">{formatStrategyType(bot.strategyType)}</span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-[#697371]">Network</span>
            <span className="truncate text-[#d2dad7]">{targetNetwork}</span>
          </div>
          {bot.verificationState !== 'unverified' && (
            <div className="flex items-center justify-between gap-2 text-[#50d2c1]">
              <span>Verified Operator</span>
              <span className="i-ph:seal-check-fill text-sm" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
    </aside>
  );

  return (
    <div className="arena-trace-terminal flex h-full min-h-0 overflow-hidden bg-[var(--arena-terminal-bg)]">
      {focusMode ? (
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="arena-trace-terminal shrink-0 border-b border-[#273035] bg-[#081013] text-[#f6fefd]">
            <div className="flex h-11 min-w-0 items-center gap-2 px-2">
              <Link
                to={backHref ?? `/arena/bot/${encodeURIComponent(bot.id)}/performance`}
                replace
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[5px] font-display text-sm font-medium text-[#949e9c] transition-colors hover:bg-[#16242a] hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label="Back to agent"
                title="Back to agent"
              >
                <span className="i-ph:arrow-left text-base" aria-hidden="true" />
              </Link>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-sm font-semibold text-[#f6fefd]">
                  {activeSection === 'chat' ? 'Chat' : activeSection === 'runs' ? 'Runs' : title}
                </div>
              </div>
              <div className="ml-auto hidden min-w-0 items-center gap-2 pr-2 sm:flex">
                <Identicon address={bot.operatorAddress as Address} size={22} />
                <span className="max-w-[280px] truncate font-display text-sm font-medium text-[#d2dad7]">
                  {title}
                </span>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-0">
            <div className="h-full min-h-0">
              {children}
            </div>
          </div>
        </section>
      ) : (
        <>
          {agentRail}
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {mobileHeader}
            <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
              <div className="h-full min-h-0 w-full">
                {children}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
