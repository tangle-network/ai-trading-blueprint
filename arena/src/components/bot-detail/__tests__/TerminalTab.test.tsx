import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalTab } from '../TerminalTab';

const authState: {
  token: string | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  authenticate: ReturnType<typeof vi.fn>;
  error: string | null;
} = {
  token: 'test-token',
  isAuthenticated: true,
  isAuthenticating: false,
  authenticate: vi.fn(),
  error: null as string | null,
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true }),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => authState,
}));

vi.mock('~/components/operator/OperatorTerminalView', () => ({
  OperatorTerminalView: ({
    apiUrl,
    resourcePath,
    token,
    title,
  }: {
    apiUrl: string;
    resourcePath: string;
    token: string;
    title?: string;
  }) => (
    <div data-testid="operator-terminal-view">
      <span>{apiUrl}</span>
      <span>{resourcePath}</span>
      <span>{token}</span>
      <span>{title}</span>
    </div>
  ),
}));

vi.mock('~/components/operator/OperatorAccessCard', () => ({
  OperatorAccessCard: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  ),
}));

describe('TerminalTab', () => {
  beforeEach(() => {
    authState.token = 'test-token';
    authState.isAuthenticated = true;
    authState.isAuthenticating = false;
    authState.error = null;
    authState.authenticate.mockReset();
  });

  it('shows the verification gate for unverified bots', () => {
    render(
      <TerminalTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="unverified"
      />,
    );

    expect(screen.getByText('Terminal unavailable')).toBeInTheDocument();
    expect(screen.getByText(/freshly verified against the operator/i)).toBeInTheDocument();
  });

  it('shows the owner-only gate before operator auth is established', () => {
    authState.isAuthenticated = false;
    authState.token = null;

    render(
      <TerminalTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
    );

    expect(screen.getByText('Owner-only terminal')).toBeInTheDocument();
    expect(screen.getByText(/live shell is hidden/i)).toBeInTheDocument();
  });

  it('uses fleet bot-scoped terminal paths for cloud operators', () => {
    render(
      <TerminalTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
    );

    expect(screen.getByTestId('operator-terminal-view')).toHaveTextContent('http://localhost:9201');
    expect(screen.getByTestId('operator-terminal-view')).toHaveTextContent('/api/bots/bot-1');
  });

  it('uses singleton terminal paths for instance operators', () => {
    render(
      <TerminalTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9301"
        operatorKind="instance"
        verificationState="authoritative"
      />,
    );

    expect(screen.getByTestId('operator-terminal-view')).toHaveTextContent('http://localhost:9301');
    expect(screen.getByTestId('operator-terminal-view')).toHaveTextContent('/api/bot');
  });
});
