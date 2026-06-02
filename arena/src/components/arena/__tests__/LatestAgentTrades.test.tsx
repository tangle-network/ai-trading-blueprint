import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';
import { LatestAgentTrades } from '../LatestAgentTrades';

const hoisted = vi.hoisted(() => ({
  latestTrades: [] as Array<{
    trade: Trade;
    bot?: Bot;
    botId: string;
    botName: string;
  }>,
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Identicon: ({ address }: { address: string }) => <span>{address.slice(0, 6)}</span>,
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

vi.mock('~/lib/hooks/useBotApi', () => ({
  useLatestAgentTrades: () => ({
    trades: hoisted.latestTrades,
    isLoading: false,
    candidateCount: 1,
  }),
}));

function makeAsset(symbol: string) {
  return {
    rawToken: symbol,
    symbol,
    name: symbol,
    primaryLabel: symbol,
    isKnown: true,
    accentClassName: 'bg-blue-100 text-blue-700',
    iconText: symbol.slice(0, 1),
  };
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'Tape Bot',
    operatorAddress: '0x1111111111111111111111111111111111111111',
    vaultAddress: '0x2222222222222222222222222222222222222222',
    strategyType: 'hyperliquid_perp',
    status: 'active',
    createdAt: Date.now(),
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 24,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [],
    verificationState: 'authoritative',
    ...overrides,
  };
}

function makeTrade(index: number): Trade {
  return {
    id: `trade-${index}`,
    botId: 'bot-1',
    botName: 'Tape Bot',
    action: index % 2 === 0 ? 'open_long' : 'close_long',
    assetIn: makeAsset('USDC'),
    assetOut: makeAsset('ETH'),
    tokenIn: 'USDC',
    tokenOut: 'ETH',
    amountIn: 100 + index,
    amountOut: 0.03,
    priceUsd: 3300,
    notionalUsd: 100 + index,
    timestamp: Date.now() - index * 60_000,
    status: 'paper',
    paperTrade: true,
    targetProtocol: 'hyperliquid',
    venue: 'paper',
    hyperliquidMetadata: { asset: 'ETH', assetSize: `0.0${index}` },
  };
}

describe('LatestAgentTrades', () => {
  it('uses an internal scroll viewport in panel mode so the fill tape cannot resize its sibling panel', () => {
    const bot = makeBot();
    hoisted.latestTrades = Array.from({ length: 20 }, (_, index) => ({
      trade: makeTrade(index),
      bot,
      botId: bot.id,
      botName: bot.name,
    }));

    render(
      <MemoryRouter>
        <LatestAgentTrades
          bots={[bot]}
          variant="panel"
          limit={20}
          className="h-full min-h-0"
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('live-fill-tape')).toHaveClass('overflow-hidden', 'h-full', 'min-h-0');
    expect(screen.getByTestId('live-fill-tape-scroll')).toHaveClass('overflow-y-auto', 'min-h-0', 'flex-1');
    expect(screen.getByRole('heading', { name: 'Fills' })).toBeInTheDocument();
    expect(screen.queryByText('Last 20')).not.toBeInTheDocument();
  });
});
