import { describe, expect, it } from 'vitest';
import { mapApiPortfolioState } from './portfolio';

describe('mapApiPortfolioState', () => {
  it('flags the captured stablecoin regression payload as suspicious', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: 10032,
      cash_balance: 10000,
      positions: [
        {
          token: 'USDC',
          symbol: 'USDC',
          amount: 3200,
          value_usd: 32,
          entry_price: 0.000390625,
          current_price: 0.01,
          pnl_percent: 2460,
          weight: 0.3,
        },
      ],
    }, 'bot-1');

    expect(portfolio.hasSuspiciousPositions).toBe(true);
    expect(portfolio.displayTotalValueUsd).toBeNull();
    expect(portfolio.displayCashBalance).toBeNull();
    expect(portfolio.warnings[0]).toContain('hidden');
    expect(portfolio.positions[0]?.isSuspicious).toBe(true);
    expect(portfolio.positions[0]?.displayValueUsd).toBeNull();
    expect(portfolio.positions[0]?.displayPnlPercent).toBeNull();
    expect(portfolio.positions[0]?.displayWeight).toBeNull();
  });

  it('keeps coherent positions visible without warnings', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: 10000,
      cash_balance: 9000,
      positions: [
        {
          token: 'WETH',
          symbol: 'WETH',
          amount: 0.5,
          value_usd: 1000,
          entry_price: 2000,
          current_price: 2000,
          pnl_percent: 0,
          weight: 10,
        },
      ],
    }, 'bot-1');

    expect(portfolio.hasSuspiciousPositions).toBe(false);
    expect(portfolio.displayTotalValueUsd).toBe(10000);
    expect(portfolio.displayCashBalance).toBe(9000);
    expect(portfolio.positions[0]?.displayValueUsd).toBe(1000);
    expect(portfolio.positions[0]?.displayPnlPercent).toBe(0);
    expect(portfolio.positions[0]?.displayWeight).toBe(10);
  });
});
