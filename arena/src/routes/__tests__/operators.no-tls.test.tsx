import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  resolveOperatorRpc: (value: string) => value,
  useOperators: () => ({
    operators: [
      {
        address: '0x1111111111111111111111111111111111111111',
        rpcAddress: 'https://operator-one.test',
      },
      {
        address: '0x2222222222222222222222222222222222222222',
        rpcAddress: 'http://no-tls-operator.test:9210',
      },
    ],
    operatorCount: 2n,
  }),
}));

// Simulates an https page: the http operator is discovered on-chain but the
// browser cannot fetch it (mixed content), so it must surface as "no TLS"
// instead of silently disappearing.
vi.mock('~/lib/operator/discovery', () => ({
  useOperatorDirectory: () => ({
    apiUrls: ['https://operator-one.test'],
    endpoints: [
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

describe('operators route — endpoints without TLS', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags http operators as unreachable from the browser instead of hiding them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      api_version: '1',
      deployment_kind: 'fleet',
      features: { chat: true, terminal: true },
      request_access: {
        mode: 'public',
        allowed_requester_count: 0,
        operator_address: '0x1111111111111111111111111111111111111111',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

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
  });
});
