export type BotStatus = 'active' | 'paused' | 'stopped';
export type StrategyType = 'momentum' | 'mean-reversion' | 'arbitrage' | 'trend-following' | 'market-making' | 'sentiment';

export interface Bot {
  id: string;
  serviceId: number;
  name: string;
  operatorAddress: string;
  vaultAddress: string;
  strategyType: StrategyType;
  status: BotStatus;
  createdAt: number;

  // Performance
  pnlPercent: number;
  pnlAbsolute: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  tvl: number;
  avgValidatorScore: number;

  // Sparkline data (30 data points for ~30 days)
  sparklineData: number[];
}
