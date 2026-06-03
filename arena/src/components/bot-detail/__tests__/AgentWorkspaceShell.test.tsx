import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import { AgentWorkspaceShell, type AgentWorkspaceNavItem } from '../AgentWorkspaceShell';

const hoisted = vi.hoisted(() => ({
  detailName: 'ETH Macro Scalper',
  liveSummary: {
    pnlPercent: 4.5,
    pnlAbsolute: 1129,
    sharpeRatio: 3.87,
    maxDrawdown: 2.5,
    tradeCount: 12,
    winRate: 58,
    portfolioValue: 26_842.55,
    avgValidatorScore: 91,
    isLoading: false,
  },
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Identicon: ({ address, size }: { address: string; size: number }) => (
    <span data-testid="identicon" data-size={size}>{address.slice(0, 6)}</span>
  ),
}));

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: {
      name: hoisted.detailName,
      strategy_type: 'hyperliquid_perp',
    },
  }),
}));

vi.mock('~/lib/hooks/useBotLiveSummary', () => ({
  useBotLiveSummary: () => hoisted.liveSummary,
}));

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
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 8,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [],
    verificationState: 'authoritative',
    paperTrade: true,
    chainId: 84532,
    ...overrides,
  };
}

const navItems: AgentWorkspaceNavItem[] = [
  { value: 'performance', label: 'Performance', icon: 'i-ph:chart-line-up' },
  { value: 'portfolio', label: 'Portfolio', icon: 'i-ph:wallet' },
  { value: 'runs', label: 'Runs', icon: 'i-ph:list-checks' },
  { value: 'chat', label: 'Chat', icon: 'i-ph:chat-circle' },
  { value: 'operations', label: 'Operations', icon: 'i-ph:sliders' },
];

describe('AgentWorkspaceShell', () => {
  beforeEach(() => {
    hoisted.detailName = 'ETH Macro Scalper';
    hoisted.liveSummary = {
      pnlPercent: 4.5,
      pnlAbsolute: 1129,
      sharpeRatio: 3.87,
      maxDrawdown: 2.5,
      tradeCount: 12,
      winRate: 58,
      portfolioValue: 26_842.55,
      avgValidatorScore: 91,
      isLoading: false,
    };
  });

  it('renders a command rail with account state as the dominant persistent agent metric', () => {
    render(
      <MemoryRouter>
        <AgentWorkspaceShell
          bot={makeBot()}
          displayName="ETH Macro Scalper"
          activeSection="performance"
          navItems={navItems}
          buildSectionHref={(section) => `/arena/bot/bot-1/${section}`}
        >
          <div>Workspace body</div>
        </AgentWorkspaceShell>
      </MemoryRouter>,
    );

    const accountState = screen.getByTestId('agent-account-state');

    expect(within(accountState).getByText('Account')).toBeInTheDocument();
    expect(within(accountState).getByText('$26.8K')).toBeInTheDocument();
    expect(within(accountState).getByText('Return')).toBeInTheDocument();
    expect(within(accountState).getByText('+4.5%')).toBeInTheDocument();
    expect(within(accountState).getByText('Sharpe')).toBeInTheDocument();
    expect(within(accountState).getByText('3.87')).toBeInTheDocument();
    expect(within(accountState).getByText('DD')).toBeInTheDocument();
    expect(within(accountState).getByText('2.5%')).toBeInTheDocument();
    expect(within(accountState).getByText('Fills')).toBeInTheDocument();
    expect(within(accountState).getByText('12')).toBeInTheDocument();
    expect(screen.queryByText('Max DD')).not.toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Agent workspace sections' })).toHaveLength(2);
    for (const link of screen.getAllByRole('link', { name: /performance/i })) {
      expect(link).toHaveAttribute('href', '/arena/bot/bot-1/performance');
    }
  });

  it('bounds long names in both desktop rail and mobile header', () => {
    hoisted.detailName = 'ETH Macro Scalper With Excessively Long Volatility And Perp Routing Mandate';

    render(
      <MemoryRouter>
        <AgentWorkspaceShell
          bot={makeBot()}
          displayName="fallback"
          activeSection="performance"
          navItems={navItems}
          buildSectionHref={(section) => `/arena/bot/bot-1/${section}`}
        >
          <div>Workspace body</div>
        </AgentWorkspaceShell>
      </MemoryRouter>,
    );

    const titles = screen.getAllByRole('heading', { name: hoisted.detailName });
    expect(titles).toHaveLength(2);
    expect(titles.some((title) => title.classList.contains('line-clamp-2'))).toBe(true);
    expect(titles.some((title) => title.classList.contains('truncate'))).toBe(true);
  });
});
