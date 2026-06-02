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
    expect(within(sidebar!).getByRole('link', { name: /fleet/i })).toHaveAttribute('href', '/');
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
    expect(within(sidebar!).getByText('Connect to pin callable agents.')).toBeInTheDocument();
  });
});
