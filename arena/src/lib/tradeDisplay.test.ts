import { describe, expect, it } from 'vitest';
import type { Trade } from '~/lib/types/trade';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';
import {
  formatTradeActionLabel,
  formatTradeModeLabel,
  formatTradeUsd,
  getHyperliquidMarketLabel,
  getTerminalTradeActionPillClass,
  getTradeActionToneClass,
  getTradeActionBadgeVariant,
  getTradeMarketLabel,
} from './tradeDisplay';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    botId: 'bot-1',
    botName: 'Bot',
    action: 'buy',
    assetIn: resolveAssetDisplay('USDC', 84532),
    assetOut: resolveAssetDisplay('WETH', 84532),
    tokenIn: 'USDC',
    tokenOut: 'WETH',
    amountIn: 100,
    amountOut: 0.03,
    priceUsd: 3300,
    notionalUsd: 100,
    timestamp: Date.parse('2026-04-23T10:40:51.844Z'),
    status: 'paper',
    paperTrade: true,
    venue: 'paper',
    targetProtocol: 'uniswap_v3',
    ...overrides,
  };
}

describe('trade display helpers', () => {
  it('normalizes action labels and tones', () => {
    expect(formatTradeActionLabel('open_long')).toBe('LONG');
    expect(formatTradeActionLabel('close_short')).toBe('CLOSE SHORT');
    expect(getTradeActionBadgeVariant('open_short')).toBe('destructive');
    expect(getTradeActionBadgeVariant('close_short')).toBe('success');
    expect(getTradeActionToneClass('open_long')).toBe('text-[#50d2c1]');
    expect(getTradeActionToneClass('close_short')).toBe('text-[#50d2c1]');
    expect(getTerminalTradeActionPillClass('open_long')).toBe('arena-trade-pill-buy');
    expect(getTerminalTradeActionPillClass('open_short')).toBe('arena-trade-pill-sell');
    expect(getTerminalTradeActionPillClass('swap')).toBe('arena-trade-pill-neutral');
  });

  it('formats Hyperliquid markets from metadata', () => {
    const trade = makeTrade({
      action: 'open_long',
      targetProtocol: 'hyperliquid',
      status: 'executed',
      paperTrade: false,
      hyperliquidMetadata: { asset: 'eth', assetSize: '0.04' },
    });

    expect(getHyperliquidMarketLabel(trade)).toBe('ETH-PERP');
    expect(getTradeMarketLabel(trade)).toBe('ETH-PERP');
    expect(formatTradeModeLabel(trade)).toBe('Live');
  });

  it('uses Polymarket question and outcome labels when available', () => {
    const trade = makeTrade({
      targetProtocol: 'polymarket_clob',
      predictionMetadata: {
        marketQuestion: 'Will ETH be above $4,000 on June 30?',
        outcomeLabel: 'YES',
      },
    });

    expect(getTradeMarketLabel(trade)).toBe('Will ETH be above $4,000 on June 30? - YES');
  });

  it('keeps DEX pairs compact and formats missing notional honestly', () => {
    expect(getTradeMarketLabel(makeTrade())).toBe('USDC/WETH');
    expect(formatTradeUsd(999.123)).toBe('$999.12');
    expect(formatTradeUsd(null)).toBe('—');
  });
});
