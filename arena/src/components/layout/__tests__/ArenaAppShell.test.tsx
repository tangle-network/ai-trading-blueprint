import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import { ArenaAppShell } from '../ArenaAppShell';

const hoisted = vi.hoisted(() => ({
  account: {
    address: '0x1111111111111111111111111111111111111111' as string | undefined,
    isConnected: true,
  },
  bots: [] as Bot[],
}));

vi.mock('wagmi', () => ({
  useAccount: () => hoisted.account,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  ChainSwitcher: () => <button type="button">Chain</button>,
  Identicon: ({ address }: { address: string }) => <span>{address.slice(0, 6)}</span>,
  TangleLogo: ({ label }: { label?: string }) => <span>{label ?? 'Tangle'}</span>,
  ThemeToggle: () => <button type="button">Theme</button>,
}));

vi.mock('~/lib/hooks/useBots', () => ({
  useBots: () => ({
    bots: hoisted.bots,
    isLoading: false,
  }),
}));

vi.mock('../TxDropdown', () => ({
  TxDropdown: () => <button type="button">Transactions</button>,
}));

vi.mock('../WalletButton', () => ({
  WalletButton: () => <button type="button">Wallet</button>,
}));

function makeBot(overrides: Partial<Bot>): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'Agent One',
    operatorAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    vaultAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    strategyType: 'momentum',
    status: 'active',
    createdAt: Date.parse('2026-06-01T00:00:00Z'),
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [],
    verificationState: 'authoritative',
    paperTrade: true,
    ...overrides,
  };
}

function renderShell(path = '/dashboard') {
  render(
    <MemoryRouter initialEntries={[path]}>
	      <Routes>
	        <Route element={<ArenaAppShell />}>
	          <Route path="/dashboard" element={<div>Dashboard body</div>} />
	          <Route path="/" element={<div>Leaderboard body</div>} />
	          <Route path="/arena/bot/:id/:section" element={<div>Agent body</div>} />
	        </Route>
	      </Routes>
    </MemoryRouter>,
  );
}

describe('ArenaAppShell', () => {
  beforeEach(() => {
    hoisted.account.address = '0x1111111111111111111111111111111111111111';
    hoisted.account.isConnected = true;
    hoisted.bots = [];
  });

	  it('only pins agents submitted by the connected wallet in the command sidebar', () => {
    hoisted.bots = [
      makeBot({
        id: 'mine',
        name: 'Callable Agent',
        submitterAddress: '0x1111111111111111111111111111111111111111',
        source: 'operator',
        pnlPercent: 4.2,
      }),
      makeBot({
        id: 'fleet',
        name: 'Public Fleet Agent',
        submitterAddress: '0x2222222222222222222222222222222222222222',
        pnlPercent: 22,
        totalTrades: 10,
      }),
    ];

    renderShell();

    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');

    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).getByText('Callable Agent')).toBeInTheDocument();
    expect(within(sidebar!).queryByText('Public Fleet Agent')).not.toBeInTheDocument();
    expect(within(sidebar!).getAllByRole('link', { name: /arena/i }).some((link) => link.getAttribute('href') === '/')).toBe(true);
	  });

	  it('filters wallet relevance before slicing the sidebar roster', () => {
	    hoisted.bots = [
	      ...Array.from({ length: 8 }, (_, index) => makeBot({
	        id: `public-${index}`,
	        name: `Public Agent ${index + 1}`,
	        submitterAddress: '0x2222222222222222222222222222222222222222',
	        pnlPercent: 100 - index,
	        totalTrades: 20,
	      })),
	      makeBot({
	        id: 'mine-low-pnl',
	        name: 'My Low PnL Agent',
	        submitterAddress: '0x1111111111111111111111111111111111111111',
	        source: 'operator',
	        pnlPercent: -12,
	        totalTrades: 1,
	      }),
	    ];

	    renderShell();

	    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');

	    expect(sidebar).not.toBeNull();
	    expect(within(sidebar!).getByText('My Low PnL Agent')).toBeInTheDocument();
	    expect(within(sidebar!).queryByText('Public Agent 1')).not.toBeInTheDocument();
	  });

	  it('does not pin operator-owned agents when the wallet is not the permitted caller', () => {
	    hoisted.bots = [
	      makeBot({
	        id: 'operator-owned',
	        name: 'Operator Owned Agent',
	        operatorAddress: '0x1111111111111111111111111111111111111111',
	        submitterAddress: '0x2222222222222222222222222222222222222222',
	        source: 'operator',
	        totalTrades: 14,
	      }),
	      makeBot({
	        id: 'callable',
	        name: 'Callable Agent',
	        submitterAddress: '0x1111111111111111111111111111111111111111',
	        source: 'operator',
	        totalTrades: 1,
	      }),
	    ];

	    renderShell();

	    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');

	    expect(sidebar).not.toBeNull();
	    expect(within(sidebar!).getByText('Callable Agent')).toBeInTheDocument();
	    expect(within(sidebar!).queryByText('Operator Owned Agent')).not.toBeInTheDocument();
	  });

	  it('does not show public fleet agents as callable before a wallet is connected', () => {
    hoisted.account.address = undefined;
    hoisted.account.isConnected = false;
    hoisted.bots = [
      makeBot({
        id: 'fleet',
        name: 'Public Fleet Agent',
        submitterAddress: '0x2222222222222222222222222222222222222222',
        totalTrades: 10,
      }),
    ];

    renderShell();

    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');

    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).queryByText('Public Fleet Agent')).not.toBeInTheDocument();
	    expect(within(sidebar!).queryByText(/callable agents/i)).not.toBeInTheDocument();
	    expect(within(sidebar!).getByRole('link', { name: /arena/i })).toHaveAttribute('href', '/');
	  });

	  it('keeps focus workspaces free of global navigation chrome', () => {
	    hoisted.bots = [
	      makeBot({
	        id: 'mine',
	        name: 'Callable Agent',
	        submitterAddress: '0x1111111111111111111111111111111111111111',
	        source: 'operator',
	      }),
	    ];

	    renderShell('/arena/bot/mine/chat');

	    expect(screen.queryByRole('navigation', { name: 'Arena navigation' })).not.toBeInTheDocument();
	    expect(screen.queryByRole('button', { name: /base sepolia testnet/i })).not.toBeInTheDocument();
	    expect(screen.queryByRole('button', { name: /transactions/i })).not.toBeInTheDocument();
	    expect(screen.getByText('Agent body')).toBeInTheDocument();
	  });
	});
