import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArenaAppShell } from '../ArenaAppShell';

const hoisted = vi.hoisted(() => ({
  account: {
    address: '0x1111111111111111111111111111111111111111' as string | undefined,
    isConnected: true,
  },
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
    bots: [],
    isLoading: false,
  }),
}));

vi.mock('../TxDropdown', () => ({
  TxDropdown: () => <button type="button">Transactions</button>,
}));

vi.mock('../WalletButton', () => ({
  WalletButton: () => <button type="button">Wallet</button>,
}));

function renderShell(path = '/dashboard') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ArenaAppShell />}>
          <Route path="/dashboard" element={<div>Dashboard body</div>} />
          <Route path="/" element={<div>Leaderboard body</div>} />
          <Route path="/activity" element={<div>Activity body</div>} />
          <Route path="/arena/bot/:id/:section" element={<div>Agent body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ArenaAppShell', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hoisted.account.address = '0x1111111111111111111111111111111111111111';
    hoisted.account.isConnected = true;
  });

  it('keeps the desktop sidebar focused on product navigation instead of live agent rosters', () => {
    renderShell();

    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');

    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
    expect(within(sidebar!).getByRole('link', { name: /activity/i })).toHaveAttribute('href', '/activity');
    expect(within(sidebar!).getByRole('link', { name: /my agents/i })).toHaveAttribute('href', '/dashboard');
    expect(within(sidebar!).getByRole('link', { name: /deploy/i })).toHaveAttribute('href', '/provision');
    expect(within(sidebar!).getByRole('link', { name: /create/i })).toHaveAttribute('href', '/create');
    expect(within(sidebar!).queryByText(/commandable/i)).not.toBeInTheDocument();
  });

  it('does not show public fleet agents as callable before a wallet is connected', () => {
    hoisted.account.address = undefined;
    hoisted.account.isConnected = false;

    renderShell();

    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');

    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).queryByText(/callable agents/i)).not.toBeInTheDocument();
    expect(within(sidebar!).getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
  });

  it('persists the collapsed desktop sidebar preference', async () => {
    renderShell();

    await userEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    expect(window.localStorage.getItem('arena:sidebar-collapsed')).toBe('true');
    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');
    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    expect(within(sidebar!).getByRole('button', { name: 'Chain' })).toBeInTheDocument();
    expect(within(sidebar!).getByRole('button', { name: 'Transactions' })).toBeInTheDocument();
    expect(within(sidebar!).getByRole('button', { name: 'Theme' })).toBeInTheDocument();
    expect(within(sidebar!).getByRole('button', { name: 'Wallet' })).toBeInTheDocument();
  });

  it('gives the expanded wallet action primary visual weight', () => {
    renderShell('/');

    const sidebar = screen.getByRole('navigation', { name: 'Arena navigation' }).closest('aside');
    const walletButton = within(sidebar!).getByRole('button', { name: 'Wallet' });
    const chainButton = within(sidebar!).getByRole('button', { name: 'Chain' });

    expect(walletButton.parentElement).toHaveClass('[&>button]:!bg-[#50d2c1]');
    expect(walletButton.parentElement).toHaveClass('[&>button]:!text-[#06100e]');
    expect(walletButton.compareDocumentPosition(chainButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    '/arena/bot/mine/performance',
    '/arena/bot/mine/portfolio',
    '/arena/bot/mine/operations',
    '/arena/bot/mine/chat',
    '/arena/bot/mine/runs',
  ])('keeps agent workspace routes free of global navigation chrome: %s', (path) => {
    renderShell(path);

    expect(screen.queryByRole('navigation', { name: 'Arena navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /base sepolia testnet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /transactions/i })).not.toBeInTheDocument();
    expect(screen.getByText('Agent body')).toBeInTheDocument();
  });
});
