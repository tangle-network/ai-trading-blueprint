import type { TradingLifecyclePersona } from './lifecycle-types.js'

export const tradingLifecyclePersonas: TradingLifecyclePersona[] = [
  {
    id: 'polymarket-btc-mm-adaptive-user',
    role: 'Polymarket market-making operator',
    goal: 'Operate a BTC 5m market-making bot that can adapt risk and detect crowding over time.',
    strategyFocus: ['polymarket_clob', 'btc_5m', 'market_making', 'crowded_bot_flow'],
    maxTurns: 4,
    riskProfile: 'balanced',
    turns: [
      {
        day: 0,
        intent: 'initial_market_maker',
        message: 'Build me a conservative market maker for BTC 5m Polymarket markets. Start small and explain the risk controls.',
        expectedAgentBehavior: ['create bounded initial strategy', 'name data sources', 'define drawdown and inventory limits'],
      },
      {
        day: 1,
        intent: 'risk_adjustment',
        message: 'The bot is barely trading. Make it a little more aggressive but do not let daily drawdown exceed 3%.',
        expectedAgentBehavior: ['adjust sizing or thresholds', 'preserve drawdown cap', 'run out-of-sample backtest'],
      },
      {
        day: 3,
        intent: 'microstructure_review',
        message: 'Are other bots crowding this? Look for stop cascades or obvious breakout chasers and change the strategy only if the evidence is real.',
        expectedAgentBehavior: ['analyze bot-pattern evidence', 'avoid fake certainty', 'change strategy only with validation'],
      },
      {
        day: 7,
        intent: 'find_new_pairs',
        message: 'Find adjacent markets or pairs where this edge is less crowded. If there is no clean edge, say so.',
        expectedAgentBehavior: ['search adjacent markets', 'compare liquidity and edge decay', 'recommend or reject expansion'],
      },
    ],
  },
  {
    id: 'base-amm-rebalancer-risk-off-user',
    role: 'Base DeFi vault operator',
    goal: 'Run a Base AMM/rebalancer strategy that becomes more risk-off after adverse selection.',
    strategyFocus: ['base', 'uniswap_v3', 'amm_rebalancer_flow', 'risk_off'],
    maxTurns: 3,
    riskProfile: 'risk_off',
    turns: [
      {
        day: 0,
        intent: 'initial_market_maker',
        message: 'Set up a WETH/USDC Base strategy that watches AMM rebalancer flow. Keep gas and churn low.',
        expectedAgentBehavior: ['gas-aware strategy', 'low-churn controls', 'explicit no-bridge assumption'],
      },
      {
        day: 2,
        intent: 'risk_adjustment',
        message: 'We saw adverse selection. Make the bot more risk-off and reduce trade frequency.',
        expectedAgentBehavior: ['reduce sizing or raise thresholds', 'lower churn', 'validate against held-out flow'],
      },
      {
        day: 5,
        intent: 'microstructure_review',
        message: 'Tell me whether rebalancer flow is still exploitable or if bots have adapted.',
        expectedAgentBehavior: ['compare before/after flow', 'identify alpha decay', 'recommend no-change if edge is stale'],
      },
    ],
  },
]
