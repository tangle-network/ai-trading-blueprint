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
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <section className="flex min-h-0 flex-[0.9] flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/48">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-arena-elements-dividerColor/55 px-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-arena-elements-textPrimary">
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

      <section className="flex min-h-0 flex-[1.25] flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/48">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-arena-elements-dividerColor/55 px-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-arena-elements-textPrimary">
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
