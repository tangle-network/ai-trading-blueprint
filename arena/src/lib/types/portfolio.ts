export interface Position {
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  pnlPercent: number | null;
  weight: number | null;
  displayValueUsd: number | null;
  displayPnlPercent: number | null;
  displayWeight: number | null;
  warnings: string[];
  valuationStatus: 'priced' | 'unpriced';
}

export interface Portfolio {
  botId: string;
  totalValueUsd: number | null;
  cashBalance: number | null;
  displayTotalValueUsd: number | null;
  displayCashBalance: number | null;
  warnings: string[];
  hasUnpricedPositions: boolean;
  positions: Position[];
}
