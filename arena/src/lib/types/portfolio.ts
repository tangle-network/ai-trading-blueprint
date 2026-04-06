export interface Position {
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  weight: number;
  displayValueUsd: number | null;
  displayPnlPercent: number | null;
  displayWeight: number | null;
  warnings: string[];
  isSuspicious: boolean;
}

export interface Portfolio {
  botId: string;
  totalValueUsd: number;
  cashBalance: number;
  displayTotalValueUsd: number | null;
  displayCashBalance: number | null;
  warnings: string[];
  hasSuspiciousPositions: boolean;
  positions: Position[];
}
