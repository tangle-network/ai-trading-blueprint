import { PositionsTab } from './PositionsTab';
import { TradeHistoryTab } from './TradeHistoryTab';
import type { BotOperatorKind, BotStatus, BotVerificationState } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';

interface PortfolioWorkspaceProps {
  botId: string;
  botName: string;
  status: BotStatus;
  isLive: boolean;
  chainId?: number;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
  assetMetadata?: TokenMetadata[];
}

export function PortfolioWorkspace({
  botId,
  botName,
  status,
  isLive,
  chainId,
  operatorApiUrl,
  operatorKind,
  verificationState,
  assetMetadata,
}: PortfolioWorkspaceProps) {
  const terminalTableClass = [
    'text-[#d2dad7]',
    '[&_.glass-card]:!border-[#273035]',
    '[&_.glass-card]:!bg-[#0f1a1f]',
    '[&_.glass-card]:!text-[#d2dad7]',
    '[&_table]:!bg-[#0f1a1f]',
    '[&_thead]:!bg-[#0b1418]',
    '[&_tbody]:!bg-[#0f1a1f]',
    '[&_tr]:!border-[#273035]',
    '[&_th]:!border-[#273035]',
    '[&_th]:!bg-[#0b1418]',
    '[&_th]:!font-data',
    '[&_th]:!text-[#949e9c]',
    '[&_td]:!border-[#273035]',
    '[&_td]:!bg-[#0f1a1f]',
    '[&_td]:!text-[#d2dad7]',
    '[&_code]:!text-[#d2dad7]',
    '[&_.text-arena-elements-textPrimary]:!text-[#f6fefd]',
    '[&_.text-arena-elements-textSecondary]:!text-[#d2dad7]',
    '[&_.text-arena-elements-textTertiary]:!text-[#697371]',
  ].join(' ');

  return (
    <section className={`flex h-full min-h-0 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] shadow-[0_22px_80px_rgba(0,0,0,0.24)] ${terminalTableClass}`}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#273035] bg-[#0b1418] px-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold tracking-tight text-[#f6fefd]">
            Portfolio
          </h2>
        </div>
        <div className="hidden items-center gap-2 font-data text-xs text-[#697371] min-[980px]:flex">
          <span className="text-[#d2dad7]">{botName}</span>
          <span aria-hidden="true">/</span>
          <span>{isLive ? 'Live' : 'Paper'}</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(142px,0.36fr)_minmax(0,1fr)] overflow-hidden min-[1620px]:grid-cols-[minmax(380px,0.38fr)_minmax(0,1fr)] min-[1620px]:grid-rows-none">
        <section className="flex min-h-0 flex-col overflow-hidden border-b border-[#273035] bg-[#0f1a1f] min-[1620px]:border-b-0 min-[1620px]:border-r">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#273035] bg-[#0d171b] px-3">
            <h3 className="font-data text-xs font-semibold uppercase text-[#949e9c]">
              Positions
            </h3>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]">
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
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden bg-[#0f1a1f]">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#273035] bg-[#0d171b] px-3">
            <h3 className="font-data text-xs font-semibold uppercase text-[#949e9c]">
              Executions
            </h3>
          </div>
          <div className="min-h-0 flex-1 p-2">
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
          </div>
        </section>
      </div>
    </section>
  );
}
