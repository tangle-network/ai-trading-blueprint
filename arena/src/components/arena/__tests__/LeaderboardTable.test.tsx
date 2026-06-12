import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import { LeaderboardTable } from '../LeaderboardTable';

vi.mock('@tangle-network/blueprint-ui/components', () => import('~/test/stubs/blueprint-ui-components'));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'ETH Macro Scalper',
    operatorAddress: '0x1111111111111111111111111111111111111111',
    vaultAddress: '0x2222222222222222222222222222222222222222',
    strategyType: 'hyperliquid_perp',
    status: 'active',
    createdAt: Date.now(),
    pnlPercent: 12.4,
    pnlAbsolute: 1240,
    sharpeRatio: 1.7,
    maxDrawdown: 2.1,
    winRate: 58,
    totalTrades: 1,
    tvl: 10_000,
    avgValidatorScore: 91,
    sparklineData: [10_000, 10_200, 10_180, 10_450],
    verificationState: 'authoritative',
    operatorApiUrl: 'https://operator.test',
    ...overrides,
  };
}

describe('LeaderboardTable', () => {
  it('separates recent activity from total fills and refuses stale under-counts', () => {
    const bot = makeBot();

    const { container } = render(
      <MemoryRouter>
        <LeaderboardTable
          bots={[bot]}
          activityStatsByBotId={new Map([
            [bot.id, {
              botId: bot.id,
              recentFills: 12,
              recentNotionalUsd: 13_820,
              totalVisibleFills: 12,
              totalVisibleNotionalUsd: 13_820,
              firstRecentTradeAt: Date.now() - 90 * 60_000,
              lastTradeAt: Date.now() - 10 * 60_000,
              lastAction: 'open_long',
              lastMarket: 'ETH-PERP',
              tradesPerHour: 6,
            }],
          ])}
        />
      </MemoryRouter>,
    );

    const table = screen.getByRole('table');
    expect(table).toHaveClass('rounded-none');
    expect(table.parentElement).toHaveClass('rounded-none');
    expect(container.querySelector('tr[role="button"]')).toHaveClass('[contain-intrinsic-size:58px]');
    expect(within(table).getByText('24H')).toBeInTheDocument();
    expect(within(table).getByText('Total')).toBeInTheDocument();
    expect(within(table).getByTitle('Visible fills from the latest fetched trade ledger.')).toHaveTextContent('12');
  });

  it('keeps long agent names bounded inside the agent column', () => {
    const longName = 'ETH Macro Scalper With Excessively Long Volatility And Perp Routing Mandate';

    render(
      <MemoryRouter>
        <LeaderboardTable bots={[makeBot({ name: longName })]} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: longName })).toHaveClass('truncate');
  });

  it('renders flat return as a numeric state instead of onboarding copy', () => {
    render(
      <MemoryRouter>
        <LeaderboardTable bots={[makeBot({ pnlPercent: 0 })]} />
      </MemoryRouter>,
    );

    expect(within(screen.getByRole('table')).getByText('0.0%')).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });
});
