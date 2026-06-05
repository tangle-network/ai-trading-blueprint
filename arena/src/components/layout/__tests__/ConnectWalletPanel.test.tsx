import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ConnectWalletPanel } from '../ConnectWalletPanel';

vi.mock('connectkit', () => ({
  ConnectKitButton: {
    Custom: ({ children }: { children: (props: { show: () => void; isConnecting: boolean }) => unknown }) =>
      children({ show: vi.fn(), isConnecting: false }),
  },
}));

describe('ConnectWalletPanel', () => {
  it('renders a compact wallet access rail without launch chrome', () => {
    render(
      <MemoryRouter>
        <ConnectWalletPanel
          title="Activate Agent"
          description="Wallet signs service ownership, operator quotes, funding, and activation."
          bullets={['Mandate', 'Quote', 'Service', 'Activation']}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Activate Agent' })).toBeInTheDocument();
    expect(screen.getByText('Wallet signs service ownership, operator quotes, funding, and activation.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /agents/i })).toHaveAttribute('href', '/leaderboard');
    expect(screen.getByRole('link', { name: /activity/i })).toHaveAttribute('href', '/activity');
    expect(screen.getByRole('link', { name: /new agent/i })).toHaveAttribute('href', '/create');
    expect(screen.queryByText('Launch Check')).not.toBeInTheDocument();
    expect(screen.queryByText('Launch Path')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner Wallet')).not.toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });
});
