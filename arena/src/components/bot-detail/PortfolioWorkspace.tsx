import { PositionsTab } from './PositionsTab';
import { TradeHistoryTab } from './TradeHistoryTab';
import { botStatusLabel } from '~/lib/format';
import type { BotOperatorKind, BotStatus, BotVerificationState } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import { useRef, type CSSProperties, type ReactNode } from 'react';
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePanePercent,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';

interface PortfolioWorkspaceProps {
  botId: string;
  botName: string;
  status: BotStatus;
  isLive: boolean;
  paperTrade?: boolean;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  assetMetadata?: TokenMetadata[];
}

interface RouteStateItem {
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'muted';
}

interface PortfolioLayout {
  positionsPercent: number;
  executionsCollapsed: boolean;
}

const PORTFOLIO_LAYOUT_KEY = 'arena:portfolio-workspace-layout';
const DEFAULT_PORTFOLIO_LAYOUT: PortfolioLayout = {
  positionsPercent: 62,
  executionsCollapsed: false,
};

function normalizePortfolioLayout(value: Partial<PortfolioLayout>): PortfolioLayout {
  return {
    positionsPercent: clampNumber(
      Number(value.positionsPercent) || DEFAULT_PORTFOLIO_LAYOUT.positionsPercent,
      44,
      78,
    ),
    executionsCollapsed: value.executionsCollapsed === true,
  };
}

function formatChainLabel(chainId?: number): string {
  if (chainId == null) return 'Unknown';
  if (chainId === 84532) return 'Base Sepolia';
  if (chainId === 8453) return 'Base';
  if (chainId === 31337) return 'Anvil';
  return `Chain ${chainId}`;
}

function formatOperatorKind(operatorKind?: BotOperatorKind): string {
  if (!operatorKind) return 'Unknown';
  if (operatorKind === 'tee') return 'TEE';
  if (operatorKind === 'cloud') return 'Cloud';
  return 'Instance';
}

function formatVerificationState(verificationState?: BotVerificationState): string {
  if (verificationState === 'authoritative') return 'Verified';
  if (verificationState === 'unverified') return 'Unverified';
  return 'Pending';
}

function routeToneClass(tone: RouteStateItem['tone'] = 'neutral'): string {
  if (tone === 'good') return 'text-[var(--arena-terminal-accent)]';
  if (tone === 'warn') return 'text-[var(--arena-terminal-warning)]';
  if (tone === 'muted') return 'text-[var(--arena-terminal-text-subtle)]';
  return 'text-[var(--arena-terminal-text)]';
}

function TerminalPane({
  title,
  meta,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] ${className}`}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3">
        <h3 className="font-data text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
          {title}
        </h3>
        {meta && (
          <div className="min-w-0 font-data text-xs tabular-nums text-[var(--arena-terminal-text-secondary)]">
            {meta}
          </div>
        )}
      </div>
      <div className={`min-h-0 flex-1 overflow-hidden ${bodyClassName}`}>
        {children}
      </div>
    </section>
  );
}

function RouteStateTicker({ items }: { items: RouteStateItem[] }) {
  return (
    <div className="hidden min-w-0 items-center gap-1.5 font-data text-xs tabular-nums min-[860px]:flex">
      {items.map((item, index) => (
        <span
          key={`${item.value}-${index}`}
          className={`min-w-0 max-w-[9.5rem] truncate rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-2 py-1 ${routeToneClass(item.tone)}`}
          title={item.value}
          translate="no"
        >
          {item.value}
        </span>
      ))}
    </div>
  );
}

export function PortfolioWorkspace({
  botId,
  botName,
  status,
  isLive,
  paperTrade,
  chainId,
  operatorApiUrl,
  operatorKind,
  verificationState,
  assetMetadata,
}: PortfolioWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    PORTFOLIO_LAYOUT_KEY,
    DEFAULT_PORTFOLIO_LAYOUT,
    normalizePortfolioLayout,
  );
  const modeLabel = paperTrade == null ? (isLive ? 'Live' : 'Offline') : paperTrade ? 'Paper' : 'Live';
  const routeStateItems: RouteStateItem[] = [
    {
      value: botStatusLabel(status),
      tone: status === 'active' ? 'good' : status === 'paused' || status === 'winding_down' ? 'warn' : 'muted',
    },
    {
      value: formatChainLabel(chainId),
      tone: chainId == null ? 'muted' : 'neutral',
    },
    {
      value: formatOperatorKind(operatorKind),
      tone: operatorKind ? 'neutral' : 'muted',
    },
    {
      value: operatorApiUrl ? 'Connected' : 'Unavailable',
      tone: operatorApiUrl ? 'good' : 'warn',
    },
    {
      value: formatVerificationState(verificationState),
      tone: verificationState === 'authoritative' ? 'good' : verificationState === 'unverified' ? 'warn' : 'muted',
    },
  ];
  const terminalTableClass = [
    'text-[var(--arena-terminal-text-secondary)]',
    '[&_.glass-card]:!border-[var(--arena-terminal-border)]',
    '[&_.glass-card]:!bg-[var(--arena-terminal-panel)]',
    '[&_.glass-card]:!text-[var(--arena-terminal-text-secondary)]',
    '[&_.glass-card]:!rounded-none',
    '[&_[data-slot=table-container]]:!rounded-none',
    '[&_[data-slot=table-container]]:!border-0',
    '[&_[data-slot=table-container]]:!bg-transparent',
    '[&_[data-slot=table-container]]:!shadow-none',
    '[&_.relative.overflow-auto]:!rounded-none',
    '[&_table]:!bg-[var(--arena-terminal-panel)]',
    '[&_table]:!rounded-none',
    '[&_thead]:!bg-[var(--arena-terminal-surface)]',
    '[&_thead]:!rounded-none',
    '[&_tbody]:!bg-[var(--arena-terminal-panel)]',
    '[&_tbody]:!rounded-none',
    '[&_tr]:!border-[var(--arena-terminal-border)]',
    '[&_tr]:!rounded-none',
    '[&_th]:!border-[var(--arena-terminal-border)]',
    '[&_th]:!bg-[var(--arena-terminal-surface)]',
    '[&_th]:!font-data',
    '[&_th]:!rounded-none',
    '[&_th]:!text-[var(--arena-terminal-text-muted)]',
    '[&_td]:!border-[var(--arena-terminal-border)]',
    '[&_td]:!bg-[var(--arena-terminal-panel)]',
    '[&_td]:!rounded-none',
    '[&_code]:!text-[var(--arena-terminal-text-secondary)]',
    '[&_.text-arena-elements-textPrimary]:!text-[var(--arena-terminal-text)]',
    '[&_.text-arena-elements-textSecondary]:!text-[var(--arena-terminal-text-secondary)]',
    '[&_.text-arena-elements-textTertiary]:!text-[var(--arena-terminal-text-muted)]',
  ].join(' ');
  const workspaceStyle = layout.executionsCollapsed
    ? {
        gridTemplateRows: 'minmax(0,1fr) 8px 44px',
      }
    : {
        gridTemplateRows: `minmax(240px, ${layout.positionsPercent}fr) 8px minmax(180px, ${100 - layout.positionsPercent}fr)`,
      };
  const startExecutionResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, executionsCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'row-resize',
      onMove: (moveEvent) => {
        const rawPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
        if (shouldCollapsePanePercent(100 - rawPercent)) {
          setLayout((current) => ({
            ...current,
            executionsCollapsed: true,
          }));
          return;
        }
        const nextPercent = clampNumber(rawPercent, 44, 78);
        setLayout((current) => ({
          ...current,
          positionsPercent: nextPercent,
          executionsCollapsed: false,
        }));
      },
    });
  };

  return (
    <section className={`flex h-full min-h-0 flex-col overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] shadow-[var(--arena-terminal-shadow-lg)] ${terminalTableClass}`}>
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="min-w-0 truncate font-display text-lg font-semibold tracking-tight text-[var(--arena-terminal-text)]">
            Account
          </h2>
          <div className="hidden min-w-0 items-center gap-2 font-data text-xs tabular-nums text-[var(--arena-terminal-text-subtle)] min-[640px]:flex">
            <span className="max-w-[16rem] truncate text-[var(--arena-terminal-text-secondary)]" translate="no">
              {botName}
            </span>
            <span aria-hidden="true">/</span>
            <span className={modeLabel === 'Live' ? 'text-[var(--arena-terminal-accent)]' : modeLabel === 'Paper' ? 'text-[var(--arena-terminal-warning)]' : 'text-[var(--arena-terminal-text-subtle)]'}>
              {modeLabel}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <RouteStateTicker items={routeStateItems} />
          <WorkspaceControlButton
            label={layout.executionsCollapsed ? 'Restore executions' : 'Minimize executions'}
            icon={layout.executionsCollapsed ? 'i-ph:arrows-out-line-vertical' : 'i-ph:minus-bold'}
            onClick={() => setLayout((current) => ({
              ...current,
              executionsCollapsed: !current.executionsCollapsed,
            }))}
          />
          <WorkspaceControlButton
            label="Reset workspace"
            icon="i-ph:arrow-counter-clockwise"
            onClick={() => setLayout(DEFAULT_PORTFOLIO_LAYOUT)}
          />
        </div>
      </div>

      <div
        ref={workspaceRef}
        className="grid min-h-0 flex-1 gap-0 overflow-hidden p-2"
        style={workspaceStyle as CSSProperties}
      >
        <TerminalPane
          title="Positions"
          className="row-start-1"
          bodyClassName="overflow-auto overscroll-contain p-2 [scrollbar-gutter:stable]"
        >
          <PositionsTab
            botId={botId}
            status={status}
            chainId={chainId}
            operatorApiUrl={operatorApiUrl}
            operatorKind={operatorKind}
            verificationState={verificationState}
            assetMetadata={assetMetadata}
            workspace
            workspaceLayout="ledger"
          />
        </TerminalPane>

        <WorkspaceResizeHandle
          orientation="horizontal"
          className="row-start-2"
          ariaLabel="Resize positions and executions"
          title="Drag to resize positions and executions"
          onPointerDown={startExecutionResize}
        />

        {layout.executionsCollapsed ? (
          <WorkspaceCollapsedPane
            label="Executions"
            icon="i-ph:list-bullets"
            className="row-start-3"
            onClick={() => setLayout((current) => ({ ...current, executionsCollapsed: false }))}
          />
        ) : (
          <TerminalPane
            title="Executions"
            className="row-start-3"
            bodyClassName="overflow-hidden p-2"
          >
            <TradeHistoryTab
              botId={botId}
              botName={botName}
              isLive={isLive}
              chainId={chainId}
              operatorApiUrl={operatorApiUrl}
              operatorKind={operatorKind}
              verificationState={verificationState}
              assetMetadata={assetMetadata}
              compact
            />
          </TerminalPane>
        )}
      </div>
    </section>
  );
}
