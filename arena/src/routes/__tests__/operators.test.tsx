import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  operators: [
    {
      address: '0x1111111111111111111111111111111111111111',
      rpcAddress: 'https://operator-one.test',
    },
  ],
  operatorCount: 1n,
}));

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('@tangle-network/blueprint-ui', () => ({
  resolveOperatorRpc: (value: string) => value,
  useOperators: () => ({
    operators: hoisted.operators,
    operatorCount: hoisted.operatorCount,
  }),
}));

vi.mock('~/lib/operator/meta', () => ({
  ALL_TRADING_OPERATOR_API_URLS: [
    'https://operator-one.test',
    'https://fallback-operator.test',
  ],
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
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('operators route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows registered blueprint operators with API access metadata', async () => {
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

    expect(screen.getByRole('heading', { name: 'Operators' })).toBeInTheDocument();
    expect(screen.getByText('1 registered on-chain for blueprint #44.')).toBeInTheDocument();
    expect(screen.getByText('0x1111111111111111111111111111111111111111')).toBeInTheDocument();
    expect(screen.getAllByText('https://operator-one.test').length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getAllByText('Public').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Shared endpoint').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('https://fallback-operator.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Allowlist').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Request' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('link', { name: 'Request' })[0]).toHaveAttribute(
      'href',
      '/provision?blueprint=trading-instance&operator=0x1111111111111111111111111111111111111111',
    );
  });
});
