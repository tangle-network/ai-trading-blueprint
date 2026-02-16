export interface Position {
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  weight: number;
}

export interface Portfolio {
  botId: string;
  totalValueUsd: number;
  cashBalance: number;
  positions: Position[];
}
