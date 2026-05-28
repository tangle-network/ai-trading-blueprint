import type { ResolvedAssetDisplay } from '~/lib/tradeTokenMetadata';

export interface Position {
  asset: ResolvedAssetDisplay;
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  pnlPercent: number | null;
  weight: number | null;
  protocol?: string;
  positionType?: string;
  marginUsedUsd?: number | null;
  notionalUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  leverage?: number | null;
  liquidationPrice?: number | null;
  displayValueUsd: number | null;
  displayPnlPercent: number | null;
  displayWeight: number | null;
  warnings: string[];
  valuationStatus: 'priced' | 'value_only' | 'unpriced';
}

export interface Portfolio {
  botId: string;
  totalValueUsd: number | null;
  cashBalance: number | null;
  displayTotalValueUsd: number | null;
  displayCashBalance: number | null;
  source?: string | null;
  observedAt?: string | null;
  stale?: boolean;
  warnings: string[];
  hasUnpricedPositions: boolean;
  hasValueOnlyPositions: boolean;
  positions: Position[];
}
