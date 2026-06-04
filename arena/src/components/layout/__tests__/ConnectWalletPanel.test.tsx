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
  it('renders a full-height launch access console', () => {
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
    expect(screen.getByText('Launch Check')).toBeInTheDocument();
    expect(screen.getByText('Launch Path')).toBeInTheDocument();
    expect(screen.getByText('Owner Wallet')).toBeInTheDocument();
    expect(screen.getByText('Create paper agent')).toBeInTheDocument();
    expect(screen.getByText('Watch fills and runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new agent/i })).toHaveAttribute('href', '/create');
    expect(screen.getByRole('link', { name: /activate agent/i })).toHaveAttribute('href', '/provision');
    expect(screen.getByRole('link', { name: /live activity/i })).toHaveAttribute('href', '/activity');
    expect(screen.getAllByText('Ready')).toHaveLength(4);
  });
});
