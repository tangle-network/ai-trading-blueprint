import { describe, expect, it } from 'vitest';
import { deriveTradeAmountOut, deriveTradePriceUsd, getTradeStatus } from './useBotApi';

describe('useBotApi trade mapping helpers', () => {
  it('derives USD price from a stablecoin output leg', () => {
    expect(deriveTradePriceUsd({
      token_in: 'WETH',
      token_out: 'USDC',
      amount_in: '1.25',
      min_amount_out: '3200',
    })).toBe(2560);
  });

  it('derives USD price from a stablecoin input leg', () => {
    expect(deriveTradePriceUsd({
      token_in: 'DAI',
      token_out: 'WETH',
      amount_in: '2500',
      min_amount_out: '0.8',
    })).toBe(3125);
  });

  it('returns null when no USD leg exists', () => {
    expect(deriveTradePriceUsd({
      token_in: 'WETH',
      token_out: 'WBTC',
      amount_in: '2',
      min_amount_out: '0.05',
    })).toBeNull();
  });

  it('prefers simulation output over the minimum output when present', () => {
    expect(deriveTradeAmountOut({
      min_amount_out: '3200',
      validation: {
        simulation: {
          output_amount: '3210.5',
        },
      },
    })).toBe(3210.5);
  });

  it('marks failed paper simulations as failed instead of generic paper', () => {
    expect(getTradeStatus({
      paper_trade: true,
      validation: {
        approved: true,
        simulation: {
          success: false,
        },
      },
    })).toBe('failed');
  });
});
