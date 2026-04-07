import { describe, expect, it } from 'vitest';
import { mapApiPortfolioState } from './portfolio';

describe('mapApiPortfolioState', () => {
  it('hides totals and position values when the backend marks positions unpriced', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: null,
      cash_balance: null,
      warnings: ['Some portfolio values are unavailable because trade valuation data is missing.'],
      has_unpriced_positions: true,
      positions: [
        {
          token: 'WBTC',
          symbol: 'WBTC',
          amount: 0.05,
          value_usd: null,
          entry_price: null,
          current_price: null,
          pnl_percent: null,
          weight: null,
          valuation_status: 'unpriced',
        },
      ],
    }, 'bot-1');

    expect(portfolio.hasUnpricedPositions).toBe(true);
    expect(portfolio.displayTotalValueUsd).toBeNull();
    expect(portfolio.displayCashBalance).toBeNull();
    expect(portfolio.warnings[0]).toContain('unavailable');
    expect(portfolio.positions[0]?.valuationStatus).toBe('unpriced');
    expect(portfolio.positions[0]?.displayValueUsd).toBeNull();
    expect(portfolio.positions[0]?.displayPnlPercent).toBeNull();
    expect(portfolio.positions[0]?.displayWeight).toBeNull();
  });

  it('keeps priced positions visible without adding local heuristics', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: 10000,
      cash_balance: 9000,
      has_unpriced_positions: false,
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
          valuation_status: 'priced',
        },
      ],
    }, 'bot-1');

    expect(portfolio.hasUnpricedPositions).toBe(false);
    expect(portfolio.displayTotalValueUsd).toBe(10000);
    expect(portfolio.displayCashBalance).toBe(9000);
    expect(portfolio.positions[0]?.valuationStatus).toBe('priced');
    expect(portfolio.positions[0]?.displayValueUsd).toBe(1000);
    expect(portfolio.positions[0]?.displayPnlPercent).toBe(0);
    expect(portfolio.positions[0]?.displayWeight).toBe(10);
  });
});
