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
    <div className="grid h-full min-h-0 gap-2 xl:grid-cols-[minmax(380px,0.84fr)_minmax(560px,1.16fr)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/48">
        <div className="shrink-0 border-b border-arena-elements-dividerColor/55 px-3 py-2">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-arena-elements-textPrimary">
              Portfolio
            </h2>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
          <PositionsTab
            botId={botId}
            status={status}
            chainId={chainId}
            operatorApiUrl={operatorApiUrl}
            operatorKind={operatorKind}
            verificationState={verificationState}
            assetMetadata={assetMetadata}
            workspace
            workspaceLayout="rail"
          />
        </div>
      </section>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/48">
        <div className="shrink-0 border-b border-arena-elements-dividerColor/55 px-3 py-2">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-arena-elements-textPrimary">
              Executions
            </h2>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
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
