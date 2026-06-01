import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  operatorAccessCardMock: vi.fn(({ title, description }: any) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  )),
  useTradingRouteAutoAuthMock: vi.fn(),
}));

const accountState = {
  isConnected: true,
};

const botsState = {
  bots: [] as any[],
  isLoading: false,
  isOnChain: false,
  operatorDataState: 'locked' as const,
};

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
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

vi.mock('~/components/arena/FilterBar', () => ({
  FilterBar: () => <div>filters</div>,
}));

vi.mock('~/components/arena/LeaderboardTable', () => ({
  LeaderboardTable: () => <div>table</div>,
}));

vi.mock('~/components/arena/LatestAgentTrades', () => ({
  LatestAgentTrades: () => <div>latest trades</div>,
}));

vi.mock('~/components/arena/PlatformVolumeChart', () => ({
  PlatformVolumeChart: () => <div>platform volume</div>,
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

describe('leaderboard auth-aware rendering', () => {
  beforeEach(() => {
    botsState.bots = [];
    botsState.isLoading = false;
    botsState.isOnChain = false;
    botsState.operatorDataState = 'locked';
    accountState.isConnected = true;
    hoisted.operatorAccessCardMock.mockClear();
    hoisted.useTradingRouteAutoAuthMock.mockClear();
  });

  it('enables trading auto-auth and passes trading operator URLs to the fallback card', async () => {
    const { default: IndexPage } = await import('../_index');
    render(<IndexPage />);

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
});
