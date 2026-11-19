import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

// Simulates an https page: the http operator is discovered on-chain but the
// browser cannot fetch it (mixed content), so it must surface as "no TLS"
// instead of silently disappearing.
vi.mock('~/lib/operator/discovery', () => ({
  useOperatorDirectory: () => ({
    registryConfigured: true,
    registry: {
      counts: { 44: '2' },
      entries: [
        { address: '0x1111111111111111111111111111111111111111', rpcAddress: 'https://operator-one.test', apiUrl: 'https://operator-one.test', blueprintIds: [44] },
        { address: '0x2222222222222222222222222222222222222222', rpcAddress: 'http://no-tls-operator.test:9210', apiUrl: 'http://no-tls-operator.test:9210', blueprintIds: [44] },
      ],
    },
    apiUrls: ['https://operator-one.test', 'https://fallback-operator.test'],
    endpoints: [
      { apiUrl: 'https://fallback-operator.test', sources: ['env'], blueprintIds: [], browserReachable: true },
      {
        apiUrl: 'https://operator-one.test',
        sources: ['env', 'chain'],
        blueprintIds: [44],
        browserReachable: true,
      },
      {
        apiUrl: 'http://no-tls-operator.test:9210',
        sources: ['chain'],
        blueprintIds: [44],
        browserReachable: false,
        unreachableReason: 'mixed-content',
      },
    ],
    isDiscovering: false,
    discoveryError: null,
  }),
  isMixedContentBlocked: (url: string) => url.startsWith('http://'),
}));

vi.mock('~/lib/blueprints', () => ({
  TRADING_BLUEPRINTS: [
    {
      id: 'trading-instance',
      name: 'Trading Instance',
      description: 'Dedicated trading service',
      icon: 'i-ph:hard-drives',
      color: 'teal',
      blueprintId: '44',
      isFleet: false,
      isTee: false,
      defaults: { cpuCores: 2n, memoryMb: 4096n, maxLifetimeDays: 30n },
      strategyPacks: [],
      encodeProvision: vi.fn(),
    },
  ],
}));

function renderOperatorsPage(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('operator directory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows registrations, access and a request link for each reachable operator', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://operator-one.test')) {
        return new Response(JSON.stringify({
          api_version: '1',
          deployment_kind: 'fleet',
          features: { chat: true, terminal: true },
          request_access: {
            mode: 'public',
            allowed_requester_count: 0,
            operator_address: '0x1111111111111111111111111111111111111111',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        api_version: '1',
        deployment_kind: 'instance',
        features: { chat: true, terminal: false },
        request_access: {
          mode: 'allowlist',
          allowed_requester_count: 2,
          operator_address: '0x2222222222222222222222222222222222222222',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { default: OperatorsPage } = await import('../operators');
    renderOperatorsPage(<OperatorsPage />);

    // The no-TLS operator stays listed with its registration...
    expect(screen.getAllByText('http://no-tls-operator.test:9210').length).toBeGreaterThan(0);

    // ...and is badged as unreachable from the browser rather than probed.
    const badges = await screen.findAllByText(/no tls/i);
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]).toHaveAttribute(
      'title',
      expect.stringContaining('Unreachable from browser (no TLS)'),
    );

    // The https operator is still probed and reported healthy.
    await waitFor(() => {
      expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
    });
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const probedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(probedUrls.some((url) => url.startsWith('http://no-tls-operator.test'))).toBe(false);
    expect(screen.getByText('2 registered on-chain for blueprint #44.')).toBeInTheDocument();
    expect(screen.getAllByText('https://fallback-operator.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Allowlist').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Request' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('link', { name: 'Request' })[0]).toHaveAttribute(
      'href',
      '/provision?blueprint=trading-instance&operator=0x1111111111111111111111111111111111111111',
    );
  });
});
