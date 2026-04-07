import { describe, expect, it } from 'vitest';
import { deriveTradeAmountOut, getTradeStatus, mapApiTrade } from './useBotApi';

describe('useBotApi trade mapping helpers', () => {
  it('uses backend execution valuation when the trade is priced', () => {
    const trade = mapApiTrade({
      id: 'trade-1',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: 'USDC',
      token_out: 'WETH',
      amount_in: '1000',
      amount_out: '0.5',
      min_amount_out: '0.49',
      target_protocol: 'uniswap_v3',
      paper_trade: true,
      entry_price_usd: '2000',
      valuation_status: 'priced',
    }, 'Bot');

    expect(trade.amountOut).toBe(0.5);
    expect(trade.priceUsd).toBe(2000);
  });

  it('returns null for trade USD price when valuation is unavailable', () => {
    const trade = mapApiTrade({
      id: 'trade-2',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'buy',
      token_in: 'WETH',
      token_out: 'WBTC',
      amount_in: '2',
      amount_out: '0.05',
      min_amount_out: '0.05',
      target_protocol: 'uniswap_v3',
      paper_trade: true,
      valuation_status: 'unpriced',
    }, 'Bot');

    expect(trade.priceUsd).toBeNull();
  });

  it('prefers persisted amount_out over simulation output and minimum output', () => {
    expect(deriveTradeAmountOut({
      amount_out: '3211',
      min_amount_out: '3200',
      validation: {
        simulation: {
          output_amount: '3210.5',
        },
      },
    })).toBe(3211);
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
