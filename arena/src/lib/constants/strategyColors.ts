export type StrategyBadgeVariant = 'accent' | 'success' | 'amber' | 'default' | 'secondary';

export const strategyColors: Record<string, StrategyBadgeVariant> = {
  momentum: 'accent',
  'mean-reversion': 'success',
  arbitrage: 'amber',
  'trend-following': 'secondary',
  'market-making': 'default',
  sentiment: 'accent',
  dex: 'success',
  prediction: 'accent',
  prediction_politics: 'accent',
  prediction_crypto: 'accent',
  prediction_war: 'accent',
  prediction_trending: 'accent',
  prediction_celebrity: 'accent',
  yield: 'amber',
  perp: 'default',
  volatility: 'secondary',
  mm: 'default',
  multi: 'accent',
};
