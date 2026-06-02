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
    <div className={`flex h-full min-h-0 flex-col gap-2 ${terminalTableClass}`}>
      <section className="flex min-h-0 flex-[0.9] flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] shadow-[0_22px_80px_rgba(0,0,0,0.24)]">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#273035] bg-[#0b1418] px-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-[#f6fefd]">
            Portfolio
          </h2>
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

      <section className="flex min-h-0 flex-[1.25] flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] shadow-[0_22px_80px_rgba(0,0,0,0.24)]">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#273035] bg-[#0b1418] px-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-[#f6fefd]">
            Executions
          </h2>
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
  );
}
