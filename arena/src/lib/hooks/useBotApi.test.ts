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

  it('normalizes known token addresses into display symbols and decimal amounts', () => {
    const trade = mapApiTrade({
      id: 'trade-3',
      bot_id: 'bot-1',
      timestamp: '2026-04-07T00:00:00Z',
      action: 'sell',
      token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amount_in: '160757812500000013',
      amount_out: '1',
      min_amount_out: '1',
      target_protocol: 'uniswap_v3',
      paper_trade: false,
      valuation_status: 'unpriced',
    }, 'Bot');

    expect(trade.tokenIn).toBe('WETH');
    expect(trade.tokenOut).toBe('USDC');
    expect(trade.amountIn).toBeCloseTo(0.1607578125, 10);
    expect(trade.rawTokenIn).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
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
