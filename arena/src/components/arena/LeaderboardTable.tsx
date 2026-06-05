import { Link, useNavigate } from 'react-router';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import type { AgentActivityStats } from '~/lib/agentActivity';
import { botStatusLabel, formatCompactUsd, formatNumber, STRATEGY_SHORT, truncateAddress } from '~/lib/format';
import { rankLeaderboardBots } from '~/lib/leaderboardRanking';
import { formatTradeAge } from '~/lib/tradeDisplay';
import {
  fillCountEvidenceTitle,
  resolveFillCountEvidence,
} from '~/lib/tradeEvidence';

interface LeaderboardTableProps {
  bots: Bot[];
  selectedBotId?: string;
  onSelectBot?: (bot: Bot) => void;
  activityStatsByBotId?: Map<string, AgentActivityStats>;
}

function RankCell({ rank }: { rank: number }) {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] font-data text-xs font-semibold text-[var(--arena-terminal-text-muted)]">
      {formatNumber(rank, { maximumFractionDigits: 0 })}
    </span>
  );
}

function formatFlowUsd(value: number): string {
  return value > 0 ? formatCompactUsd(value) : '$0';
}

function modeLabel(bot: Bot): string {
  if (bot.paperTrade === true) return 'Paper';
  if (bot.paperTrade === false) return 'Live';
  return botStatusLabel(bot.status);
}

export function LeaderboardTable({
  bots,
  selectedBotId,
  onSelectBot,
  activityStatsByBotId,
}: LeaderboardTableProps) {
  const navigate = useNavigate();
  const sorted = rankLeaderboardBots(bots);

  return (
    <>
      <div className="md:hidden">
        {sorted.map((bot, index) => {
          const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
          const stats = activityStatsByBotId?.get(bot.id);
          const lastTradeAt = stats?.lastTradeAt ?? null;
          const returnValue = bot.pnlPercent === 0 ? '0.0%' : `${bot.pnlPercent > 0 ? '+' : ''}${formatNumber(bot.pnlPercent, { maximumFractionDigits: 1 })}%`;
          const selected = bot.id === selectedBotId;
          const openRow = () => {
            if (onSelectBot) {
              onSelectBot(bot);
            } else {
              navigate(href);
            }
          };

          return (
            <article
              key={bot.id}
              className={`grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2.5 transition-colors ${
                selected ? 'bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]' : 'bg-[var(--arena-terminal-panel)]'
              }`}
            >
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] font-data text-sm font-semibold text-[var(--arena-terminal-text-muted)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label={onSelectBot ? `Inspect ${bot.name}` : `Open ${bot.name} performance`}
                aria-current={selected ? 'true' : undefined}
                onClick={openRow}
              >
                {formatNumber(index + 1, { maximumFractionDigits: 0 })}
              </button>
              <button
                type="button"
                className="flex min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label={onSelectBot ? `Inspect ${bot.name}` : `Open ${bot.name} performance`}
                onClick={openRow}
              >
                <Identicon address={bot.operatorAddress as Address} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-base font-semibold leading-tight text-[var(--arena-terminal-text)]">
                    {bot.name}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-2 font-data text-xs">
                    <span className="truncate text-[var(--arena-terminal-text-muted)]">
                      {STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}
                    </span>
                    <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--arena-terminal-text-subtle)]" aria-hidden="true" />
                    <span className={bot.status === 'active' ? 'truncate text-[var(--arena-terminal-success)]' : 'truncate text-[var(--arena-terminal-text-muted)]'}>
                      {botStatusLabel(bot.status)}
                    </span>
                  </span>
                </span>
              </button>
              <Link
                to={href}
                className="inline-flex h-9 w-9 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-text-muted)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label={`Open ${bot.name} performance`}
                title="Open performance"
              >
                <span className="i-ph:arrow-square-out text-sm" aria-hidden="true" />
              </Link>
              <dl className="col-span-3 grid min-w-0 grid-cols-4 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
                <div className="min-w-0 border-r border-[var(--arena-terminal-border)] px-2 py-2">
                  <dt className="truncate font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">Vol</dt>
                  <dd className="mt-1 truncate font-data text-sm font-semibold tabular-nums text-[var(--arena-terminal-text)]">
                    {formatFlowUsd(stats?.recentNotionalUsd ?? 0)}
                  </dd>
                </div>
                <div className="min-w-0 border-r border-[var(--arena-terminal-border)] px-2 py-2">
                  <dt className="truncate font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">Fills</dt>
                  <dd className="mt-1 truncate font-data text-sm font-semibold tabular-nums text-[var(--arena-terminal-text)]">
                    {formatNumber(stats?.recentFills ?? 0, { maximumFractionDigits: 0 })}
                  </dd>
                </div>
                <div className="min-w-0 border-r border-[var(--arena-terminal-border)] px-2 py-2">
                  <dt className="truncate font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">Last</dt>
                  <dd className="mt-1 truncate font-data text-sm tabular-nums text-[var(--arena-terminal-text-secondary)]">
                    {lastTradeAt != null ? formatTradeAge(lastTradeAt) : 'No fills'}
                  </dd>
                </div>
                <div className="min-w-0 px-2 py-2 text-right">
                  <dt className="truncate font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">PnL</dt>
                  <dd className="mt-1 truncate font-data text-sm font-semibold tabular-nums">
                    {bot.pnlPercent === 0 ? (
                      <span className="text-[var(--arena-terminal-text-subtle)]">{returnValue}</span>
                    ) : bot.pnlPercent > 0 ? (
                      <span className="text-[var(--arena-terminal-success)]">{returnValue}</span>
                    ) : (
                      <span className="text-[var(--arena-terminal-danger)]">{returnValue}</span>
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
      <div className="hidden rounded-none md:block [&_[data-slot=table-container]]:!rounded-none [&_[data-slot=table-container]]:!border-0 [&_[data-slot=table-container]]:!bg-transparent [&_[data-slot=table-container]]:!shadow-none [&_.relative.overflow-auto]:!rounded-none [&_table]:!rounded-none [&_tbody]:!rounded-none [&_td]:!rounded-none [&_th]:!rounded-none [&_thead]:!rounded-none [&_tr]:!rounded-none">
    <Table className="w-full min-w-[760px] table-fixed rounded-none bg-[var(--arena-terminal-panel)] [&_td]:rounded-none [&_th]:rounded-none [&_thead]:rounded-none [&_tr]:rounded-none">
      <TableHeader>
        <TableRow className="rounded-none border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] hover:bg-[var(--arena-terminal-surface)]">
          <TableHead className="w-12 rounded-none py-2 font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">#</TableHead>
          <TableHead className="w-[29%] rounded-none py-2 font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">Agent</TableHead>
          <TableHead className="hidden w-[13%] rounded-none py-2 font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)] min-[1460px]:table-cell">Operator</TableHead>
          <TableHead className="w-[11%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">24H Vol</TableHead>
          <TableHead className="w-[7%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">24H</TableHead>
          <TableHead className="w-[8%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">Total</TableHead>
          <TableHead className="w-[10%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">Last</TableHead>
          <TableHead className="hidden w-[8%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)] min-[1320px]:table-cell">Mode</TableHead>
          <TableHead className="w-[10%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">Return</TableHead>
          <TableHead className="w-[6%] rounded-none py-2 text-right font-data text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((bot, index) => {
          const href = `/arena/bot/${encodeURIComponent(bot.id)}/performance`;
          const stats = activityStatsByBotId?.get(bot.id);
          const lastTradeAt = stats?.lastTradeAt ?? null;
          const totalFillEvidence = resolveFillCountEvidence({
            visibleTradeCount: stats?.totalVisibleFills,
            rosterTradeCount: bot.totalTrades,
          });
          const returnValue = bot.pnlPercent === 0 ? '0.0%' : `${bot.pnlPercent > 0 ? '+' : ''}${formatNumber(bot.pnlPercent, { maximumFractionDigits: 1 })}%`;
          const selected = bot.id === selectedBotId;
          const openRow = () => {
            if (onSelectBot) {
              onSelectBot(bot);
            } else {
              navigate(href);
            }
          };
          return (
          <TableRow
            key={bot.id}
            className={`group cursor-pointer border-b border-[var(--arena-terminal-border)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] [content-visibility:auto] [contain-intrinsic-size:54px] ${
              selected ? 'bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]' : 'bg-[var(--arena-terminal-panel)]'
            }`}
            role="button"
            tabIndex={0}
            aria-label={onSelectBot ? `Inspect ${bot.name}` : `Open ${bot.name} performance`}
            aria-current={selected ? 'true' : undefined}
            onClick={openRow}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openRow();
              }
            }}
          >
            <TableCell className="py-2 align-middle">
              <RankCell rank={index + 1} />
            </TableCell>
            <TableCell className="min-w-0 py-2 align-middle">
              <div className="flex min-w-0 items-center gap-2.5">
                <Identicon address={bot.operatorAddress as Address} size={32} />
                <div className="min-w-0 flex-1">
                  <Link
                    to={href}
                    className="block truncate font-display text-base font-semibold leading-tight text-[var(--arena-terminal-text)] transition-colors duration-200 hover:text-[var(--arena-terminal-accent)]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {bot.name}
                  </Link>
                  <div className="mt-0.5 flex min-w-0 items-center gap-2 font-data text-xs">
                    <span className="truncate text-[var(--arena-terminal-text-muted)]">
                      {STRATEGY_SHORT[bot.strategyType] ?? bot.strategyType}
                    </span>
                    <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--arena-terminal-text-subtle)]" aria-hidden="true" />
                    <span className={bot.status === 'active' ? 'truncate text-[var(--arena-terminal-success)]' : 'truncate text-[var(--arena-terminal-text-muted)]'}>
                      {botStatusLabel(bot.status)}
                    </span>
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell className="hidden min-w-0 py-2 align-middle min-[1460px]:table-cell">
              <div className="flex min-w-0 items-center gap-2 font-data text-sm text-[var(--arena-terminal-text-secondary)]">
                <Identicon address={bot.operatorAddress as Address} size={20} />
                <span className="truncate">{truncateAddress(bot.operatorAddress)}</span>
              </div>
            </TableCell>
            <TableCell className="py-2 text-right align-middle font-data text-sm text-[var(--arena-terminal-text)]">
              {formatFlowUsd(stats?.recentNotionalUsd ?? 0)}
            </TableCell>
            <TableCell className="py-2 text-right align-middle font-data text-sm font-bold text-[var(--arena-terminal-text)]">
              {formatNumber(stats?.recentFills ?? 0, { maximumFractionDigits: 0 })}
            </TableCell>
            <TableCell
              className="py-2 text-right align-middle font-data text-sm text-[var(--arena-terminal-text)]"
              title={fillCountEvidenceTitle(totalFillEvidence)}
            >
              {totalFillEvidence.value > 0
                ? formatNumber(totalFillEvidence.value, { maximumFractionDigits: 0 })
                : '—'}
            </TableCell>
            <TableCell className="py-2 text-right align-middle font-data text-sm text-[var(--arena-terminal-text-secondary)]">
              {lastTradeAt != null ? formatTradeAge(lastTradeAt) : 'No fills'}
            </TableCell>
            <TableCell className="hidden py-2 text-right align-middle font-data text-sm text-[var(--arena-terminal-text-secondary)] min-[1320px]:table-cell">
              {modeLabel(bot)}
            </TableCell>
            <TableCell className="py-2 text-right align-middle font-data text-sm font-bold">
              {bot.pnlPercent === 0 ? (
                <span className="text-[var(--arena-terminal-text-subtle)]">{returnValue}</span>
              ) : bot.pnlPercent > 0 ? (
                <span className="text-[var(--arena-terminal-success)]">{returnValue}</span>
              ) : (
                <span className="text-[var(--arena-terminal-danger)]">{returnValue}</span>
              )}
            </TableCell>
            <TableCell className="py-2 text-right align-middle">
              <Link
                to={href}
                className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-text-muted)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                aria-label={`Open ${bot.name} performance`}
                title="Open performance"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="i-ph:arrow-square-out text-sm" aria-hidden="true" />
              </Link>
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
    </div>
    </>
  );
}
