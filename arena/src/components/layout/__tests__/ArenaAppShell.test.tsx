import { render, screen, waitFor, within } from '@testing-library/react';
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
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}));

vi.mock('@nanostores/react', () => ({
  useStore: (store: { get?: () => unknown }) => store.get?.() ?? 84532,
}));

vi.mock('@tangle-network/sandbox-ui/hooks', () => ({
  useDropdownMenu: () => ({
    open: false,
    ref: { current: null },
    toggle: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  selectedChainIdStore: {
    get: () => 84532,
    set: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Identicon: ({ address }: { address: string }) => <span>{address.slice(0, 6)}</span>,
  TangleLogo: ({ label }: { label?: string }) => <span>{label ?? 'Tangle'}</span>,
  ThemeToggle: () => <button type="button">Theme</button>,
}));

vi.mock('~/lib/contracts/chains', () => ({
  networks: {
    84532: { label: 'Base Sepolia', chain: { id: 84532, name: 'Base Sepolia' } },
    1: { label: 'Ethereum', chain: { id: 1, name: 'Ethereum' } },
  },
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
  WalletButton: ({ compact = false }: { compact?: boolean }) => (
    <button type="button" data-compact={compact ? 'true' : 'false'}>Wallet</button>
  ),
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
    document.documentElement.setAttribute('data-theme', 'dark');
    hoisted.account.address = '0x1111111111111111111111111111111111111111';
    hoisted.account.isConnected = true;
  });

  it('keeps the desktop sidebar focused on product navigation instead of live agent rosters', () => {
    renderShell();

    const sidebar = screen.getByRole('navigation', { name: 'Tangle navigation' }).closest('aside');

    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
    expect(within(sidebar!).getByRole('link', { name: /activity/i })).toHaveAttribute('href', '/activity');
    expect(within(sidebar!).getByRole('link', { name: /my agents/i })).toHaveAttribute('href', '/dashboard');
    expect(within(sidebar!).getByRole('link', { name: /deploy/i })).toHaveAttribute('href', '/provision');
    expect(within(sidebar!).getByRole('link', { name: /create/i })).toHaveAttribute('href', '/create');
    expect(within(sidebar!).queryByText(/commandable/i)).not.toBeInTheDocument();
  });

  it('uses the official theme-specific Tangle wordmark assets', async () => {
    renderShell();

    const brandLogo = screen.getByRole('link', { name: 'Tangle Trading' }).querySelector('img');
    expect(brandLogo).toHaveAttribute('src', '/tangle-logo-light.svg');

    document.documentElement.setAttribute('data-theme', 'light');

    await waitFor(() => {
      expect(brandLogo).toHaveAttribute('src', '/tangle-logo.svg');
    });
  });

  it('does not show public fleet agents as callable before a wallet is connected', () => {
    hoisted.account.address = undefined;
    hoisted.account.isConnected = false;

    renderShell();

    const sidebar = screen.getByRole('navigation', { name: 'Tangle navigation' }).closest('aside');

    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).queryByText(/callable agents/i)).not.toBeInTheDocument();
    expect(within(sidebar!).getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
  });

  it('persists the collapsed desktop sidebar preference', async () => {
    renderShell();

    await userEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    expect(window.localStorage.getItem('arena:sidebar-collapsed')).toBe('true');
    const sidebar = screen.getByRole('navigation', { name: 'Tangle navigation' }).closest('aside');
    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    expect(within(sidebar!).getByRole('button', { name: 'Network' })).toBeInTheDocument();
    expect(within(sidebar!).queryByRole('button', { name: 'Transactions' })).not.toBeInTheDocument();
    expect(within(sidebar!).queryByRole('button', { name: 'Theme' })).not.toBeInTheDocument();
    const walletButton = within(sidebar!).getByRole('button', { name: 'Wallet' });
    expect(walletButton).toHaveAttribute('data-compact', 'true');
    expect(walletButton.parentElement).not.toHaveClass('overflow-hidden');
  });

  it('keeps the expanded wallet action visually neutral with the network selector', () => {
    renderShell('/');

    const sidebar = screen.getByRole('navigation', { name: 'Tangle navigation' }).closest('aside');
    const walletButton = within(sidebar!).getByRole('button', { name: 'Wallet' });
    const chainButton = within(sidebar!).getByRole('button', { name: 'Network' });

    expect(walletButton.parentElement).toHaveClass('[&>button]:!bg-[var(--arena-terminal-panel)]');
    expect(walletButton.parentElement).toHaveClass('[&>button]:!text-[var(--arena-terminal-text-secondary)]');
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

    expect(screen.queryByRole('navigation', { name: 'Tangle navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /base sepolia testnet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /transactions/i })).not.toBeInTheDocument();
    expect(screen.getByText('Agent body')).toBeInTheDocument();
  });
});
