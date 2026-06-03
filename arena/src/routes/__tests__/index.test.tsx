import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWrapper } from '~/test/mocks';

const hoisted = vi.hoisted(() => ({
  operatorAccessCardMock: vi.fn(({ title, description }: any) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  )),
  useTradingRouteAutoAuthMock: vi.fn(),
  latestAgentTradesProps: [] as any[],
  platformVolumeChartProps: [] as any[],
  topAgentsPanelProps: [] as any[],
}));

const accountState = {
  isConnected: true,
};

const botsState = {
  bots: [] as any[],
  isLoading: false,
  isOnChain: false,
  operatorDataState: 'locked' as 'locked' | 'ready',
};

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => accountState,
  useSignMessage: () => ({ signMessageAsync: async () => '0xsig' }),
}));

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
  Identicon: () => <div>identicon</div>,
}));

vi.mock('~/lib/hooks/useBots', () => ({
  useBots: () => botsState,
}));

vi.mock('~/lib/hooks/useBotEnrichment', () => ({
  useBotEnrichment: (bots: any[]) => bots,
}));

vi.mock('~/lib/hooks/useBotApi', () => ({
  useLatestAgentTrades: () => ({
    trades: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    candidateCount: 0,
  }),
  usePlatformVolumeSeries: () => ({
    series: {
      buckets: [],
      bucketMs: 86_400_000,
      summary: {
        totalUsd: 434_300,
        paperUsd: 434_300,
        liveUsd: 0,
        pricedTradeCount: 72,
        totalTradeCount: 72,
      },
    },
    isLoading: false,
    isFetching: false,
  }),
}));

vi.mock('~/components/arena/LatestAgentTrades', () => ({
  LatestAgentTrades: (props: any) => {
    hoisted.latestAgentTradesProps.push(props);
    return <div>latest trades</div>;
  },
}));

vi.mock('~/components/arena/PlatformVolumeChart', () => ({
  PlatformVolumeChart: (props: any) => {
    hoisted.platformVolumeChartProps.push(props);
    return <div>platform volume</div>;
  },
}));

vi.mock('~/components/arena/ArenaTopAgentsPanel', () => ({
  ArenaTopAgentsPanel: (props: any) => {
    hoisted.topAgentsPanelProps.push(props);
    return <div>top agents</div>;
  },
}));

vi.mock('~/components/arena/SparklineChart', () => ({
  SparklineChart: () => <div>sparkline</div>,
}));

vi.mock('~/components/ui/Skeleton', () => ({
  SkeletonCard: () => <div>skeleton</div>,
}));

vi.mock('~/lib/hooks/useTradingRouteAutoAuth', () => ({
  useTradingRouteAutoAuth: hoisted.useTradingRouteAutoAuthMock,
}));

vi.mock('~/lib/operator/meta', () => ({
  ALL_TRADING_OPERATOR_API_URLS: ['/tee-operator-api'],
  HAS_TRADING_OPERATOR_API: true,
}));

vi.mock('~/components/operator/OperatorAccessCard', () => ({
  OperatorAccessCard: (props: any) => hoisted.operatorAccessCardMock(props),
  OperatorSessionBanner: () => null,
}));

function makePublicBot(overrides: Record<string, any> = {}) {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'ETH Macro Scalper',
    operatorAddress: '0x1111111111111111111111111111111111111111',
    vaultAddress: '0x2222222222222222222222222222222222222222',
    strategyType: 'hyperliquid_perp',
    status: 'active',
    createdAt: Date.now(),
    pnlPercent: 12.4,
    pnlAbsolute: 1240,
    sharpeRatio: 1.7,
    maxDrawdown: 2.1,
    winRate: 58,
    totalTrades: 49,
    tvl: 10_000,
    avgValidatorScore: 91,
    sparklineData: [10_000, 10_200, 10_180, 10_450],
    verificationState: 'authoritative',
    operatorApiUrl: 'https://operator.test',
    ...overrides,
  };
}

describe('leaderboard auth-aware rendering', () => {
  beforeEach(() => {
    botsState.bots = [];
    botsState.isLoading = false;
    botsState.isOnChain = false;
    botsState.operatorDataState = 'locked';
    accountState.isConnected = true;
    hoisted.operatorAccessCardMock.mockClear();
    hoisted.useTradingRouteAutoAuthMock.mockClear();
    hoisted.latestAgentTradesProps.length = 0;
    hoisted.platformVolumeChartProps.length = 0;
    hoisted.topAgentsPanelProps.length = 0;
  });

  it('enables trading auto-auth and passes trading operator URLs to the fallback card', async () => {
    const { default: IndexPage } = await import('../_index');
    render(<IndexPage />, { wrapper: createWrapper() });

    expect(hoisted.useTradingRouteAutoAuthMock).toHaveBeenCalledWith({
      enabled: true,
      routeKey: 'leaderboard',
    });
    expect(hoisted.operatorAccessCardMock).toHaveBeenCalledWith(expect.objectContaining({
      apiUrls: ['/tee-operator-api'],
      title: 'Operator authentication required',
      description: 'Authenticate to load operator-managed agents and live leaderboard metrics.',
    }));
    expect(screen.getByText('Operator authentication required')).toBeInTheDocument();
  });

  it('keeps the homepage focused on market pulse, platform volume, full-height fills, and a wide agent dock', async () => {
    botsState.bots = [makePublicBot()];
    botsState.operatorDataState = 'ready';

    const { default: IndexPage } = await import('../_index');
    render(<IndexPage />, { wrapper: createWrapper() });

    expect(screen.getByRole('region', { name: /market pulse/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Execution trust')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /tangle fleet terminal/i })).toHaveClass(
      'flex-1',
      'min-h-0',
    );
    expect(hoisted.platformVolumeChartProps.at(-1)).toEqual(expect.objectContaining({
      variant: 'command',
      className: 'col-start-1 row-start-1 min-h-[320px] lg:min-h-0',
      headerControls: expect.anything(),
    }));
    expect(hoisted.latestAgentTradesProps.at(-1)).toEqual(expect.objectContaining({
      variant: 'panel',
      limit: 14,
      className: 'col-start-3 row-start-1 row-span-3 min-h-[280px] lg:min-h-0',
      headerControls: expect.anything(),
    }));
    expect(hoisted.topAgentsPanelProps.at(-1)).toEqual(expect.objectContaining({
      variant: 'table',
      metricMode: 'activity',
      activityStatsByBotId: expect.any(Map),
      limit: 7,
      className: 'col-start-1 row-start-3 min-h-[220px] lg:min-h-0',
      headerControls: expect.anything(),
    }));
    expect(screen.getByRole('button', { name: 'Resize volume and top agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize fills rail' })).toBeInTheDocument();
    expect(screen.getByText('top agents')).toBeInTheDocument();
  });
});
