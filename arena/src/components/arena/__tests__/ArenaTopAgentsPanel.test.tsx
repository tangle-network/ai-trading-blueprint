import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import { ArenaTopAgentsPanel } from '../ArenaTopAgentsPanel';

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
    totalTrades: 49,
    tvl: 10_000,
    avgValidatorScore: 91,
    sparklineData: [10_000, 10_200, 10_180, 10_450],
    verificationState: 'authoritative',
    operatorApiUrl: 'https://operator.test',
    ...overrides,
  };
}

describe('ArenaTopAgentsPanel', () => {
  it('renders a bounded ranked terminal list that links into agent performance', () => {
    const weakerBot = makeBot({
      id: 'bot-2',
      name: 'Prediction Shock Bot',
      operatorAddress: '0x2222222222222222222222222222222222222222',
      strategyType: 'prediction',
      pnlPercent: 3.2,
      sharpeRatio: 0.8,
      totalTrades: 12,
    });
    const strongerBot = makeBot();

    render(
      <MemoryRouter>
        <ArenaTopAgentsPanel bots={[weakerBot, strongerBot]} limit={1} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('top-agents-panel')).toHaveClass('overflow-hidden', 'h-full', 'min-h-0');
    expect(screen.getByTestId('top-agents-panel')).not.toHaveClass('rounded-[6px]');
    expect(screen.getByRole('heading', { name: 'Top agents' })).toBeInTheDocument();
    // Rows use the shared leaderboard idiom: clickable row + named agent link.
    expect(screen.getByRole('button', { name: 'Open ETH Macro Scalper performance' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ETH Macro Scalper' })).toHaveAttribute(
      'href',
      '/arena/bot/bot-1/performance',
    );
    expect(screen.getByText('+12.4%')).toBeInTheDocument();
    expect(screen.getByText('1.7')).toBeInTheDocument();
    expect(screen.getByText('49')).toBeInTheDocument();
    expect(screen.queryByText('Prediction Shock Bot')).not.toBeInTheDocument();
  });

  it('renders a compact rail variant for the home terminal', () => {
    const bot = makeBot();

    render(
      <MemoryRouter>
        <ArenaTopAgentsPanel bots={[bot]} limit={1} variant="rail" />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('top-agents-panel')).toHaveClass('h-full', 'min-h-0');
    expect(screen.getByTestId('top-agents-panel')).not.toHaveClass('rounded-[6px]');
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByText('Sharpe')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open ETH Macro Scalper performance' })).toHaveAttribute(
      'href',
      '/arena/bot/bot-1/performance',
    );
    expect(screen.getByText('+12.4%')).toBeInTheDocument();
    expect(screen.getByText('49')).toBeInTheDocument();
  });

  it('renders activity metrics for the home command board', () => {
    const bot = makeBot({
      pnlPercent: 0,
      sharpeRatio: 0,
      totalTrades: 0,
    });
    const now = Date.now();

    render(
      <MemoryRouter>
        <ArenaTopAgentsPanel
          bots={[bot]}
          limit={1}
          metricMode="activity"
          activityStatsByBotId={new Map([
            [bot.id, {
              botId: bot.id,
              recentFills: 12,
              recentNotionalUsd: 13_820,
              totalVisibleFills: 12,
              totalVisibleNotionalUsd: 13_820,
              firstRecentTradeAt: now - 90 * 60_000,
              lastTradeAt: now - 19 * 60_000,
              lastAction: 'open_long',
              lastMarket: 'ETH-PERP',
              tradesPerHour: 6,
            }],
          ])}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('24H Vol')).toBeInTheDocument();
    expect(screen.getByText('24H')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$13.8K')).toBeInTheDocument();
    expect(screen.getAllByText('12').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Sharpe')).not.toBeInTheDocument();
  });

  it('bounds long agent names in table and rail variants', () => {
    const longName = 'ETH Macro Scalper With Excessively Long Volatility And Perp Routing Mandate';
    const bot = makeBot({ name: longName });

    const { rerender } = render(
      <MemoryRouter>
        <ArenaTopAgentsPanel bots={[bot]} limit={1} />
      </MemoryRouter>,
    );

    expect(screen.getByText(longName)).toHaveClass('truncate');

    rerender(
      <MemoryRouter>
        <ArenaTopAgentsPanel bots={[bot]} limit={1} variant="rail" />
      </MemoryRouter>,
    );

    expect(screen.getByText(longName)).toHaveClass('truncate');
  });
});
