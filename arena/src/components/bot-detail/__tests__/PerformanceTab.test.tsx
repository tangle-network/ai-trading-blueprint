import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bot } from '~/lib/types/bot';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';
import { PerformanceTab } from '../PerformanceTab';

mockBlueprintUi();
mockFramerMotion();

let mockMetrics: Array<Record<string, unknown>> | undefined = [];
let mockMetricsSummary: Record<string, number> | undefined = {
  portfolio_value_usd: 10000,
  total_pnl: 0,
  trade_count: 0,
};
let mockPortfolio: Record<string, unknown> | undefined;
let metricsIsLoading = false;
let metricsIsError = false;

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotMetrics: () => ({
    data: mockMetrics,
    isLoading: metricsIsLoading,
    isError: metricsIsError,
  }),
  useBotMetricsSummary: () => ({
    data: mockMetricsSummary,
  }),
  useBotTrades: () => ({
    data: [],
  }),
  useBotPortfolio: () => ({
    data: mockPortfolio,
    isLoading: false,
  }),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    token: 'test-token',
    isAuthenticated: true,
    isAuthenticating: false,
    authenticate: vi.fn(),
    clearCachedToken: vi.fn(),
    error: null,
    getCachedToken: vi.fn(() => 'test-token'),
    getToken: vi.fn(async () => 'test-token'),
  }),
}));

vi.mock('~/lib/hooks/useChartTheme', () => ({
  useChartTheme: () => ({
    positive: '#0f0',
    negative: '#f00',
    positiveGradientStart: 'rgba(0, 255, 0, 0.2)',
    negativeGradientStart: 'rgba(255, 0, 0, 0.2)',
    gradientEnd: 'rgba(0, 0, 0, 0)',
    hoverBorderColor: '#fff',
    tooltipBg: '#000',
    tooltipBorder: '#333',
    tooltipTitleColor: '#fff',
    tooltipBodyColor: '#fff',
    tickColor: '#999',
    gridColor: '#222',
  }),
}));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'Cloud Bot',
    operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    vaultAddress: '0x0000000000000000000000000000000000000000',
    strategyType: 'dex',
    status: 'active',
    createdAt: Date.now(),
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [10000, 10000, 10000],
    verificationState: 'authoritative',
    operatorKind: 'cloud',
    operatorApiUrl: 'http://localhost:9201',
    ...overrides,
  };
}

describe('PerformanceTab', () => {
  beforeEach(() => {
    mockMetrics = [];
    mockMetricsSummary = {
      portfolio_value_usd: 10000,
      total_pnl: 0,
      trade_count: 0,
    };
    metricsIsLoading = false;
    metricsIsError = false;
    mockPortfolio = undefined;
  });

  it('shows an unavailable state when verified metrics fail to load', () => {
    mockMetrics = undefined;
    metricsIsError = true;

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(screen.getByText('Live performance unavailable')).toBeInTheDocument();
    expect(screen.getByText(/chart is hidden instead of showing synthetic history/i)).toBeInTheDocument();
  });

  it('does not fall back to stale sparkline history when no snapshots are available', () => {
    mockMetrics = undefined;

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(screen.getByText('No performance snapshots available yet.')).toBeInTheDocument();
    expect(screen.queryByText('Snapshot 1')).not.toBeInTheDocument();
  });

  it('calculates total return from configured initial capital when available', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:40:51.844085Z',
        account_value_usd: 9994.04,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-04-23T11:02:02.514536Z',
        account_value_usd: 9992.13,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({ strategyConfig: { initial_capital_usd: '10000' } })}
        isLive
      />,
    );

    expect(screen.getByText('$-7.87')).toBeInTheDocument();
  });

  it('labels live NAV separately when it is newer than the latest checkpoint', () => {
    mockMetrics = [
      {
        timestamp: '2026-05-27T10:05:11.000Z',
        account_value_usd: 10.93,
        realized_pnl: 0,
        unrealized_pnl: -0.1,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockPortfolio = {
      displayTotalValueUsd: 8.2,
      observedAt: '2026-05-27T10:07:12.000Z',
      stale: false,
    };

    render(
      <PerformanceTab
        bot={makeBot({ strategyType: 'hyperliquid_perp' })}
        isLive
      />,
    );

    expect(screen.getByText(/Last checkpoint: .*Live NAV:/)).toBeInTheDocument();
  });

  it('does not label live NAV when the latest checkpoint is already fresh', () => {
    mockMetrics = [
      {
        timestamp: '2026-05-27T10:05:11.000Z',
        account_value_usd: 10.93,
        realized_pnl: 0,
        unrealized_pnl: -0.1,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockPortfolio = {
      displayTotalValueUsd: 8.2,
      observedAt: '2026-05-27T10:05:41.000Z',
      stale: false,
    };

    render(
      <PerformanceTab
        bot={makeBot({ strategyType: 'hyperliquid_perp' })}
        isLive
      />,
    );

    expect(screen.getByText(/Last checkpoint:/)).toBeInTheDocument();
    expect(screen.queryByText(/Live NAV:/)).not.toBeInTheDocument();
  });
});
