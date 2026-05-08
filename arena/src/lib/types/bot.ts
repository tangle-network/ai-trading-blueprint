export type BotLifecycleStatus = 'unknown' | 'awaiting_secrets' | 'active' | 'stopped' | 'winding_down' | 'archived';
export type BotStatus = 'active' | 'paused' | 'stopped' | 'needs_config' | 'winding_down' | 'archived' | 'unknown';
export type BotVerificationState = 'authoritative' | 'unverified';
export type BotOperatorKind = 'cloud' | 'instance' | 'tee' | null;
/**
 * Validation trust level — mirrors `trading_runtime::ValidationTrust` (snake-case
 * variants: `per_trade`, `envelope`, `self_operated`). Set at provision time.
 */
export type ValidationTrust = 'per_trade' | 'envelope' | 'self_operated';
export type StrategyType =
  | 'prediction' | 'prediction_politics' | 'prediction_crypto'
  | 'prediction_war' | 'prediction_trending' | 'prediction_celebrity'
  | 'dex' | 'yield' | 'perp' | 'volatility' | 'mm' | 'multi'
  | 'momentum' | 'mean-reversion' | 'arbitrage' | 'trend-following'
  | 'market-making' | 'sentiment';

export interface Bot {
  id: string;
  serviceId: number;
  name: string;
  operatorAddress: string;
  vaultAddress: string;
  strategyType: StrategyType;
  status: BotStatus;
  createdAt: number;
  chainId?: number;

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
  sandboxState?: string | null;
  lifecycleStatus?: BotLifecycleStatus;
  archived?: boolean;
  controlAvailable?: boolean;
  tradingActive?: boolean;
  workflowId?: string;
  maxLifetimeDays?: number;
  windDownStartedAt?: number;
  secretsConfigured?: boolean;
  submitterAddress?: string;
  strategyConfig?: Record<string, unknown>;
  riskParams?: Record<string, unknown>;
  paperTrade?: boolean;

  // On-chain provision tracking
  callId?: number;

  // Internal UI source tracking
  source?: 'on_chain' | 'operator' | 'provision';
  verificationState?: BotVerificationState;
  operatorKind?: BotOperatorKind;
  operatorApiUrl?: string | null;
  lastVerifiedAt?: number | null;
  isUnverified?: boolean;

  /**
   * Trust mode the bot was provisioned with. When `envelope`, the bot's trade
   * authorization comes from a signed envelope (see EnvelopeTab); when absent
   * or `per_trade`, every trade requires fresh validator signatures.
   */
  validationTrust?: ValidationTrust;
}
