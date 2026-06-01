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
    <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(360px,0.86fr)_minmax(520px,1.14fr)]">
      <section className="min-h-0 overflow-y-auto rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/54 p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
              Exposure
            </h2>
            <p className="text-sm text-arena-elements-textSecondary">
              Current equity, cash, margin, and open risk.
            </p>
          </div>
        </div>
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
      </section>

      <section className="min-h-0 overflow-y-auto rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/54 p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
              Execution Ledger
            </h2>
            <p className="text-sm text-arena-elements-textSecondary">
              Executions, paper fills, validator evidence, and exchange references.
            </p>
          </div>
        </div>
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
      </section>
    </div>
  );
}
