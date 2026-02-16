import type { Portfolio } from '~/lib/types/portfolio';

export const mockPortfolios: Record<string, Portfolio> = {
  'bot-alpha-1': {
    botId: 'bot-alpha-1',
    totalValueUsd: 62250,
    cashBalance: 15000,
    positions: [
      {
        token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        symbol: 'WETH',
        amount: 12.5,
        valueUsd: 33775,
        entryPrice: 2550,
        currentPrice: 2702,
        pnlPercent: 5.96,
        weight: 54.3,
      },
      {
        token: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
        symbol: 'UNI',
        amount: 800,
        valueUsd: 7200,
        entryPrice: 8.2,
        currentPrice: 9.0,
        pnlPercent: 9.76,
        weight: 11.6,
      },
      {
        token: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
        symbol: 'AAVE',
        amount: 60,
        valueUsd: 6275,
        entryPrice: 95,
        currentPrice: 104.58,
        pnlPercent: 10.08,
        weight: 10.1,
      },
    ],
  },
  'bot-arb-3': {
    botId: 'bot-arb-3',
    totalValueUsd: 84100,
    cashBalance: 72000,
    positions: [
      {
        token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        symbol: 'WETH',
        amount: 4.48,
        valueUsd: 12105,
        entryPrice: 2698,
        currentPrice: 2702,
        pnlPercent: 0.15,
        weight: 14.4,
      },
    ],
  },
};
