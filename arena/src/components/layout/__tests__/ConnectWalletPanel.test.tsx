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
          title="Deploy Agent"
          description="Wallet signs service ownership, operator quotes, funding, and activation."
          bullets={['Blueprint', 'Quote', 'Service', 'Activation']}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Deploy Agent' })).toBeInTheDocument();
    expect(screen.getByText('Launch Check')).toBeInTheDocument();
    expect(screen.getByText('Launch Path')).toBeInTheDocument();
    expect(screen.getByText('Owner Wallet')).toBeInTheDocument();
    expect(screen.getByText('Compile mandate')).toBeInTheDocument();
    expect(screen.getByText('Watch fills and runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /create strategy/i })).toHaveAttribute('href', '/create');
    expect(screen.getByRole('link', { name: /deploy agent/i })).toHaveAttribute('href', '/provision');
    expect(screen.getByRole('link', { name: /live activity/i })).toHaveAttribute('href', '/activity');
    expect(screen.getAllByText('Ready')).toHaveLength(4);
  });
});
