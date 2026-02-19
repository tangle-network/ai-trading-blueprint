export type BotStatus = 'active' | 'paused' | 'stopped' | 'needs_config';
export type StrategyType =
  | 'prediction' | 'prediction_politics' | 'prediction_crypto'
  | 'prediction_war' | 'prediction_trending' | 'prediction_celebrity'
  | 'dex' | 'yield' | 'perp' | 'volatility' | 'mm' | 'multi';

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

  // Control panel fields (populated from operator API)
  sandboxId?: string;
  tradingActive?: boolean;
  workflowId?: number;
  maxLifetimeDays?: number;
  windDownStartedAt?: number;
  secretsConfigured?: boolean;
  submitterAddress?: string;
  strategyConfig?: Record<string, unknown>;
  riskParams?: Record<string, unknown>;
  paperTrade?: boolean;
}
