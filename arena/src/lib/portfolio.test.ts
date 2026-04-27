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
    expect(portfolio.hasValueOnlyPositions).toBe(false);
    expect(portfolio.displayTotalValueUsd).toBeNull();
    expect(portfolio.displayCashBalance).toBeNull();
    expect(portfolio.warnings[0]).toContain('unavailable');
    expect(portfolio.positions[0]?.valuationStatus).toBe('unpriced');
    expect(portfolio.positions[0]?.displayValueUsd).toBeNull();
    expect(portfolio.positions[0]?.displayPnlPercent).toBeNull();
    expect(portfolio.positions[0]?.displayWeight).toBeNull();
  });

  it('keeps priced positions visible', () => {
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
    expect(portfolio.hasValueOnlyPositions).toBe(false);
    expect(portfolio.displayTotalValueUsd).toBe(10000);
    expect(portfolio.displayCashBalance).toBe(9000);
    expect(portfolio.positions[0]?.valuationStatus).toBe('priced');
    expect(portfolio.positions[0]?.displayValueUsd).toBe(1000);
    expect(portfolio.positions[0]?.displayPnlPercent).toBe(0);
    expect(portfolio.positions[0]?.displayWeight).toBe(10);
  });

  it('infers priced positions when the API omits valuation_status but pricing fields exist', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: 2220.1,
      cash_balance: 1,
      has_unpriced_positions: false,
      positions: [
        {
          token: 'WETH',
          symbol: 'WETH',
          amount: 1,
          value_usd: 2220.1,
          entry_price: null,
          current_price: 2220.1,
          pnl_percent: null,
          weight: 100,
        },
      ],
    }, 'bot-1');

    expect(portfolio.hasUnpricedPositions).toBe(false);
    expect(portfolio.hasValueOnlyPositions).toBe(false);
    expect(portfolio.positions[0]?.valuationStatus).toBe('priced');
    expect(portfolio.positions[0]?.displayValueUsd).toBe(2220.1);
    expect(portfolio.positions[0]?.currentPrice).toBe(2220.1);
    expect(portfolio.positions[0]?.displayWeight).toBe(100);
    expect(portfolio.warnings).toHaveLength(0);
  });

  it('keeps current value visible for value-only positions while hiding entry and pnl', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: 4200,
      cash_balance: 1000,
      has_unpriced_positions: false,
      has_value_only_positions: true,
      positions: [
        {
          token: 'WETH',
          symbol: 'WETH',
          amount: 2,
          value_usd: 4200,
          entry_price: null,
          current_price: 2100,
          pnl_percent: null,
          weight: null,
          valuation_status: 'value_only',
        },
      ],
    }, 'bot-1');

    expect(portfolio.hasUnpricedPositions).toBe(false);
    expect(portfolio.hasValueOnlyPositions).toBe(true);
    expect(portfolio.displayTotalValueUsd).toBe(4200);
    expect(portfolio.positions[0]?.valuationStatus).toBe('value_only');
    expect(portfolio.positions[0]?.displayValueUsd).toBe(4200);
    expect(portfolio.positions[0]?.currentPrice).toBe(2100);
    expect(portfolio.positions[0]?.entryPrice).toBeNull();
    expect(portfolio.positions[0]?.displayPnlPercent).toBeNull();
  });

  it('resolves position token addresses against the bot chain id', () => {
    const portfolio = mapApiPortfolioState({
      total_value_usd: 1000,
      cash_balance: 1000,
      has_unpriced_positions: false,
      positions: [
        {
          token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: 1000,
          value_usd: 1000,
          entry_price: 1,
          current_price: 1,
          pnl_percent: 0,
          weight: 100,
          valuation_status: 'priced',
        },
      ],
    }, 'bot-1', 84532);

    expect(portfolio.positions[0]?.asset.symbol).toBe('USDC');
    expect(portfolio.positions[0]?.asset.name).toBe('USD Coin');
    expect(portfolio.positions[0]?.symbol).toBe('USDC');
  });
});
