import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';
import type { Trade } from '~/lib/types/trade';
import { TradeInstrumentDisplay } from '../AssetDisplay';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    botId: 'bot-1',
    botName: 'Agent',
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

describe('TradeInstrumentDisplay', () => {
  it('renders DEX pairs with token logo assets', () => {
    const { container } = render(<TradeInstrumentDisplay trade={makeTrade()} />);

    expect(screen.getByText('USDC/WETH')).toBeInTheDocument();
    expect(container.querySelector('img[src="/token-icons/usdc.svg"]')).not.toBeNull();
    expect(container.querySelector('img[src="/token-icons/weth.svg"]')).not.toBeNull();
  });

  it('renders Hyperliquid perps with market and size labels', () => {
    render(
      <TradeInstrumentDisplay
        trade={makeTrade({
          targetProtocol: 'hyperliquid',
          venue: 'perp',
          paperTrade: false,
          status: 'executed',
          hyperliquidMetadata: { asset: 'eth', assetSize: '0.04' },
        })}
      />,
    );

    expect(screen.getByText('ETH-PERP')).toBeInTheDocument();
    expect(screen.getByText('0.04 ETH')).toBeInTheDocument();
  });

  it('renders prediction market question and outcome labels', () => {
    render(
      <TradeInstrumentDisplay
        trade={makeTrade({
          targetProtocol: 'polymarket_clob',
          venue: 'clob',
          predictionMetadata: {
            marketQuestion: 'Will ETH be above $4,000 on June 30?',
            outcomeLabel: 'YES',
            marketSlug: 'eth-above-4000-june-30',
          },
        })}
      />,
    );

    expect(screen.getByText('Will ETH be above $4,000 on June 30? - YES')).toBeInTheDocument();
    expect(screen.getByText('YES · eth-above-4000-june-30')).toBeInTheDocument();
  });
});
