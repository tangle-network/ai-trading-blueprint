import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletButton } from '../WalletButton';

const hoisted = vi.hoisted(() => ({
  account: {
    address: '0x1111111111111111111111111111111111111111' as string | undefined,
    chainId: 84532,
    isConnected: true,
    status: 'connected',
  },
  dropdownOpen: false,
  toggle: vi.fn(),
  close: vi.fn(),
  disconnect: vi.fn(),
  switchChain: vi.fn(),
  showConnect: vi.fn(),
}));

vi.mock('connectkit', () => ({
  ConnectKitButton: {
    Custom: ({ children }: { children: (props: { show: () => void }) => unknown }) =>
      children({ show: hoisted.showConnect }),
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => hoisted.account,
  useDisconnect: () => ({ disconnect: hoisted.disconnect }),
  useSwitchChain: () => ({ switchChain: hoisted.switchChain }),
  useConnectorClient: () => ({ data: undefined }),
}));

vi.mock('@nanostores/react', () => ({
  useStore: (store: { get?: () => unknown }) => store.get?.() ?? 84532,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  publicClient: {
    getBalance: vi.fn(),
  },
  selectedChainIdStore: {
    get: () => 84532,
    set: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
  useWalletEthBalance: () => ({
    balance: '1.42',
    hasError: false,
  }),
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Identicon: ({ address, size }: { address: string; size: number }) => (
    <span data-size={size} data-testid="identicon">
      {address.slice(0, 6)}
    </span>
  ),
}));

vi.mock('@tangle-network/sandbox-ui/hooks', () => ({
  useDropdownMenu: () => ({
    open: hoisted.dropdownOpen,
    ref: { current: null },
    toggle: hoisted.toggle,
    close: hoisted.close,
  }),
}));

vi.mock('@tangle-network/sandbox-ui/utils', () => ({
  copyText: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('~/lib/contracts/chains', () => ({
  networks: {
    84532: {
      chain: {
        id: 84532,
        name: 'Base Sepolia',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: ['https://base-sepolia.example'] } },
      },
    },
  },
}));

describe('WalletButton', () => {
  beforeEach(() => {
    hoisted.account.address = '0x1111111111111111111111111111111111111111';
    hoisted.account.chainId = 84532;
    hoisted.account.isConnected = true;
    hoisted.account.status = 'connected';
    hoisted.dropdownOpen = false;
    hoisted.toggle.mockClear();
    hoisted.close.mockClear();
    hoisted.disconnect.mockClear();
    hoisted.switchChain.mockClear();
    hoisted.showConnect.mockClear();
  });

  it('shows the connected account address in expanded placements', () => {
    render(<WalletButton align="start" side="up" />);

    const accountButton = screen.getByRole('button', { name: /account menu 0x1111…1111/i });

    expect(screen.getByText('0x1111…1111')).toBeVisible();
    expect(accountButton).toHaveClass('w-full');
    expect(accountButton).not.toHaveClass('w-10');
  });

  it('keeps compact placements icon-only while preserving the account in the accessible label', () => {
    render(<WalletButton compact align="start" side="up" />);

    const accountButton = screen.getByRole('button', { name: /account menu 0x1111…1111/i });

    expect(screen.queryByText('0x1111…1111')).not.toBeInTheDocument();
    expect(accountButton).toHaveClass('w-10');
    expect(accountButton).toHaveAttribute('title', '0x1111…1111');
  });

  it('opens the account menu upward from the sidebar with viewport-clamped dimensions', () => {
    hoisted.dropdownOpen = true;

    render(<WalletButton align="start" side="up" />);

    const accountMenu = screen.getByRole('menu', { name: /account actions/i });

    expect(accountMenu).toHaveClass('left-0');
    expect(accountMenu).toHaveClass('bottom-full');
    expect(accountMenu).toHaveClass('mb-2');
    expect(accountMenu).toHaveClass('w-[min(18rem,calc(100vw-1rem))]');
    expect(accountMenu).toHaveClass('max-h-[min(28rem,calc(100vh-1rem))]');
  });
});
