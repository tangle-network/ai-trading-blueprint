import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TxDropdown } from '../TxDropdown';

const hoisted = vi.hoisted(() => ({
  open: false,
  toggle: vi.fn(),
  close: vi.fn(),
  clearTxs: vi.fn(),
  txs: [] as Array<{
    hash: `0x${string}`;
    label: string;
    status: 'pending' | 'confirmed' | 'failed';
    timestamp: number;
    chainId: number;
  }>,
  pending: 0,
}));

vi.mock('@nanostores/react', () => ({
  useStore: (store: { get: () => unknown }) => store.get(),
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  txListStore: {
    get: () => hoisted.txs,
  },
  pendingCount: {
    get: () => hoisted.pending,
  },
  clearTxs: hoisted.clearTxs,
}));

vi.mock('~/lib/contracts/chains', () => ({
  networks: {
    84532: {
      chain: {
        blockExplorers: {
          default: { name: 'BaseScan Sepolia', url: 'https://sepolia.basescan.org/' },
        },
      },
    },
  },
}));

vi.mock('@tangle-network/sandbox-ui/hooks', () => ({
  useDropdownMenu: () => ({
    open: hoisted.open,
    ref: { current: null },
    toggle: hoisted.toggle,
    close: hoisted.close,
  }),
}));

vi.mock('@tangle-network/sandbox-ui/utils', () => ({
  copyText: vi.fn(),
  timeAgo: () => 'just now',
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock('~/lib/hooks/useTxWatcher', () => ({
  useTxWatcher: vi.fn(),
}));

vi.mock('~/lib/hooks/useProvisionWatcher', () => ({
  useProvisionWatcher: vi.fn(),
}));

describe('TxDropdown', () => {
  beforeEach(() => {
    hoisted.open = false;
    hoisted.pending = 0;
    hoisted.txs = [];
    hoisted.toggle.mockClear();
    hoisted.close.mockClear();
    hoisted.clearTxs.mockClear();
  });

  it('renders a centered square trigger that toggles the transaction menu', async () => {
    const user = userEvent.setup();
    render(<TxDropdown />);

    const trigger = screen.getByRole('button', { name: /transaction history/i });

    expect(trigger).toHaveClass('inline-flex');
    expect(trigger).toHaveClass('h-9');
    expect(trigger).toHaveClass('w-9');
    expect(trigger).toHaveClass('items-center');
    expect(trigger).toHaveClass('justify-center');
    expect(trigger).toHaveClass('p-0');

    await user.click(trigger);

    expect(hoisted.toggle).toHaveBeenCalledTimes(1);
  });

  it('opens the transaction history panel from the same trigger', () => {
    hoisted.open = true;
    hoisted.txs = [{
      hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      label: 'Create service',
      status: 'confirmed',
      timestamp: Date.now(),
      chainId: 84532,
    }];

    render(<TxDropdown />);

    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Create service')).toBeInTheDocument();
  });

  it('links expanded transaction hashes to the chain explorer', async () => {
    const user = userEvent.setup();
    const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    hoisted.open = true;
    hoisted.txs = [{
      hash,
      label: 'Create service',
      status: 'confirmed',
      timestamp: Date.now(),
      chainId: 84532,
    }];

    render(<TxDropdown />);

    await user.click(screen.getByRole('button', { name: /create service/i }));

    expect(screen.getByRole('link', { name: /view transaction on basescan sepolia/i })).toHaveAttribute(
      'href',
      `https://sepolia.basescan.org/tx/${hash}`,
    );
  });
});
