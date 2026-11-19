import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConnectTradingRoute, {
  parseTradingDeskRequest,
  resolveDeskOperatorOrigin,
} from '../connect.trading';

let mockSearchParams = new URLSearchParams();

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
      <a href={to} {...props}>{children}</a>
    ),
    useSearchParams: () => [mockSearchParams, vi.fn()],
  };
});

vi.mock('connectkit', () => ({
  ConnectKitButton: { Custom: () => null },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    isAuthenticated: false,
    isAuthenticating: false,
    error: null,
    authenticate: vi.fn(),
  }),
}));

const VALID_PARAMS = new URLSearchParams({
  response_type: 'code',
  client_id: 'tangle-trading',
  network: 'test',
  state: 'opaque-state',
  code_challenge: 'a'.repeat(43),
});

describe('parseTradingDeskRequest', () => {
  it('accepts a valid request with only the fixed-callback contract', () => {
    const request = parseTradingDeskRequest(VALID_PARAMS);
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.network).toBe('test');
      expect(request.state).toBe('opaque-state');
      expect(request.codeChallenge).toBe('a'.repeat(43));
    }
  });

  it('accepts a redirect_uri only when it is exactly the fixed callback', () => {
    const withFixed = new URLSearchParams(VALID_PARAMS);
    withFixed.set('redirect_uri', 'https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback');
    expect(parseTradingDeskRequest(withFixed).ok).toBe(true);

    const withOther = new URLSearchParams(VALID_PARAMS);
    withOther.set('redirect_uri', 'https://evil.example/callback');
    const request = parseTradingDeskRequest(withOther);
    expect(request.ok).toBe(false);
    if (!request.ok) {
      expect(request.problems.join(' ')).toMatch(/redirect_uri/);
    }
  });

  it('rejects each missing or malformed input', () => {
    const cases: Array<[string, string]> = [
      ['response_type', 'token'],
      ['client_id', 'someone-else'],
      ['network', 'mainnet'],
      ['state', ''],
      ['code_challenge', 'short'],
      ['code_challenge', 'a'.repeat(43).replace(/a/, '!')],
    ];
    for (const [key, value] of cases) {
      const params = new URLSearchParams(VALID_PARAMS);
      params.set(key, value);
      expect(parseTradingDeskRequest(params).ok).toBe(false);
    }
    const empty = new URLSearchParams();
    expect(parseTradingDeskRequest(empty).ok).toBe(false);
  });
});

describe('resolveDeskOperatorOrigin', () => {
  it('accepts an exact https origin and rejects paths, credentials, query and hash', () => {
    expect(resolveDeskOperatorOrigin('https://operator.example.com')).toEqual({
      status: 'ok',
      origin: 'https://operator.example.com',
    });
    expect(resolveDeskOperatorOrigin('https://operator.example.com/')).toEqual({
      status: 'ok',
      origin: 'https://operator.example.com',
    });
    expect(resolveDeskOperatorOrigin('https://operator.example.com/api').status).toBe('invalid');
    expect(resolveDeskOperatorOrigin('https://user@operator.example.com').status).toBe('invalid');
    expect(resolveDeskOperatorOrigin('https://operator.example.com?x=1').status).toBe('invalid');
    expect(resolveDeskOperatorOrigin('https://operator.example.com#x').status).toBe('invalid');
  });

  it('allows http only on loopback hosts', () => {
    expect(resolveDeskOperatorOrigin('http://localhost:9210')).toEqual({
      status: 'ok',
      origin: 'http://localhost:9210',
    });
    expect(resolveDeskOperatorOrigin('http://127.0.0.1:9210').status).toBe('ok');
    expect(resolveDeskOperatorOrigin('http://operator.example.com').status).toBe('invalid');
  });

  it('reports a missing enrollment distinctly from a malformed one', () => {
    expect(resolveDeskOperatorOrigin(undefined).status).toBe('missing');
    expect(resolveDeskOperatorOrigin('   ').status).toBe('missing');
    expect(resolveDeskOperatorOrigin('not a url').status).toBe('invalid');
  });
});

describe('ConnectTradingRoute', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the honest setup state with zero network requests when no operator is enrolled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Vitest exposes no VITE_TRADING_DESK_OPERATOR_ORIGIN_* here, so the
    // enrollment is missing by construction.
    mockSearchParams = new URLSearchParams(VALID_PARAMS);
    render(<ConnectTradingRoute />);
    expect(await screen.findByText(/No operator is enrolled for the test network/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect wallet/i)).toBeNull();
  });

  it('renders a return-to-desk action for an invalid request without fetching', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockSearchParams = new URLSearchParams({ response_type: 'token' });
    render(<ConnectTradingRoute />);
    expect(screen.getByText(/connection request is invalid/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
