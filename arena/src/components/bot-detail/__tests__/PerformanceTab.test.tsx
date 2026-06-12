import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '~/test/mockBlueprintUi';
import '~/test/mockFramerMotion';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';
import type { FillCountEvidence } from '~/lib/tradeEvidence';
import { PerformanceTab } from '../PerformanceTab';

const lightweightChartMock = vi.hoisted(() => {
  const fitContent = vi.fn();
  const getVisibleLogicalRange = vi.fn(() => ({ from: 0, to: 40 }));
  const scrollPosition = vi.fn(() => 2);
  const scrollToPosition = vi.fn();
  const setVisibleRange = vi.fn();
  const timeToCoordinate = vi.fn((time: number) => {
    const base = Date.parse('2026-04-23T10:00:00.000Z') / 1000;
    return (time - base) * 2;
  });
  const subscribeVisibleLogicalRangeChange = vi.fn();
  const unsubscribeVisibleLogicalRangeChange = vi.fn();
  const timeScale = {
    fitContent,
    getVisibleLogicalRange,
    scrollPosition,
    scrollToPosition,
    setVisibleRange,
    subscribeVisibleLogicalRangeChange,
    timeToCoordinate,
    unsubscribeVisibleLogicalRangeChange,
  };
  const areaSeries = {
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(),
    removePriceLine: vi.fn(),
    setData: vi.fn(),
  };
  const candleSeries = {
    applyOptions: vi.fn(),
    priceToCoordinate: vi.fn((price: number) => price / 10),
    setData: vi.fn(),
  };
  const volumeSeries = {
    setData: vi.fn(),
  };
  const lineSeries = {
    applyOptions: vi.fn(),
    setData: vi.fn(),
  };
  const navPaneSeries = {
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(),
    removePriceLine: vi.fn(),
    setData: vi.fn(),
  };
  const priceScale = {
    applyOptions: vi.fn(),
  };
  const pane0 = {
    paneIndex: vi.fn(() => 0),
    setStretchFactor: vi.fn(),
  };
  const pane1 = {
    paneIndex: vi.fn(() => 1),
    setStretchFactor: vi.fn(),
  };
  const chart = {
    addPane: vi.fn(() => pane1),
    addSeries: vi.fn((seriesType: string, _options?: unknown, paneIndex?: number) => {
      if (seriesType === 'CandlestickSeries') return candleSeries;
      if (seriesType === 'HistogramSeries') return volumeSeries;
      if (seriesType === 'LineSeries') return lineSeries;
      if (paneIndex === 1) return navPaneSeries;
      return areaSeries;
    }),
    remove: vi.fn(),
    panes: vi.fn(() => [pane0, pane1]),
    priceScale: vi.fn(() => priceScale),
    subscribeCrosshairMove: vi.fn(),
    timeScale: vi.fn(() => timeScale),
    unsubscribeCrosshairMove: vi.fn(),
  };
  const markerApi = {
    detach: vi.fn(),
    markers: vi.fn(() => []),
    setMarkers: vi.fn(),
  };

  return {
    AreaSeries: 'AreaSeries',
    CandlestickSeries: 'CandlestickSeries',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Magnet: 1 },
    HistogramSeries: 'HistogramSeries',
    LastPriceAnimationMode: { OnDataUpdate: 2 },
    LineSeries: 'LineSeries',
    LineStyle: { Dashed: 2, Dotted: 1 },
    areaSeries,
    candleSeries,
    chart,
    createChart: vi.fn(() => chart),
    createSeriesMarkers: vi.fn(() => markerApi),
    fitContent,
    getVisibleLogicalRange,
    lineSeries,
    markerApi,
    navPaneSeries,
    pane0,
    pane1,
    priceScale,
    scrollPosition,
    scrollToPosition,
    setVisibleRange,
    subscribeVisibleLogicalRangeChange,
    timeScale,
    timeToCoordinate,
    unsubscribeVisibleLogicalRangeChange,
    volumeSeries,
  };
});
const operatorAuthMock = vi.hoisted(() => ({
  isAuthenticated: false,
  token: null as string | null,
}));
const useBotMarketCandlesMock = vi.hoisted(() => vi.fn(() => ({
  data: [] as typeof mockMarketCandles,
})));

vi.mock('../lightweightChartRuntime', () => ({
  loadLightweightCharts: vi.fn(async () => lightweightChartMock),
}));

vi.mock('../PerformanceCopilotPanel', () => ({
  PerformanceCopilotPanel: () => <div>Owner chart copilot</div>,
}));

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock('~/lib/contracts/chains', () => ({
  networks: {},
}));

let mockMetrics: Array<Record<string, unknown>> | undefined = [];
let mockMetricsSummary: Record<string, number> | undefined = {
  portfolio_value_usd: 10000,
  total_pnl: 0,
  trade_count: 0,
};
let mockPortfolio: Record<string, unknown> | undefined;
let mockTrades: Trade[] = [];
let mockLatestTrades: Trade[] | null = null;
let mockMarkerTrades: Trade[] | null = null;
let mockTradeTotal: number | null = null;
let mockTradeEvidence: FillCountEvidence | null = null;
let mockTradePageLoading = false;
let mockLatestTradePageLoading = false;
let mockMarkerTradePageLoading = false;
let mockChartStudies: Array<Record<string, unknown>> = [];
let mockMarketCandles: Array<{
  timestamp: number;
  token: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> = [];
let metricsIsLoading = false;
let metricsIsError = false;
let mockPerformanceSummary: {
  returnPct: number | null;
  benchmarkBuyHoldReturnPct: number | null;
  alphaPct: number | null;
  maxDrawdownPct: number | null;
  navLatestUsd: number | null;
  initialCapitalUsd: number | null;
  windowFromMs: number | null;
  windowToMs: number | null;
} | null = null;

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotMetrics: () => ({
    data: mockMetrics,
    isLoading: metricsIsLoading,
    isError: metricsIsError,
  }),
  useBotMetricsSummary: () => ({
    data: mockMetricsSummary,
  }),
  useBotPerformanceSummary: () => ({
    data: mockPerformanceSummary,
  }),
  useBotTrades: () => ({
    data: mockTrades,
  }),
  useBotTradePage: (_botId: string, _botName = '', limit = 50) => {
    const isLatestQuery = limit === 24;
    const trades = (isLatestQuery ? mockLatestTrades : mockMarkerTrades) ?? mockTrades;
    const loading = mockTradePageLoading
      || (isLatestQuery ? mockLatestTradePageLoading : mockMarkerTradePageLoading);

    return {
      data: loading
        ? undefined
        : {
            trades,
            total: mockTradeTotal,
            evidence: mockTradeEvidence,
            loaded: trades.length,
            limit: 100,
            offset: 0,
            hasTotal: mockTradeTotal != null,
            isCapped: mockTradeTotal != null ? trades.length < mockTradeTotal : false,
            legacyArray: mockTradeTotal == null,
          },
    };
  },
  useBotMarketCandles: useBotMarketCandlesMock,
  useBotChartStudies: () => ({
    data: mockChartStudies,
  }),
  useBotPortfolio: () => ({
    data: mockPortfolio,
    isLoading: false,
  }),
  useLatestAgentTrades: () => ({
    trades: [],
    isLoading: false,
    candidateCount: 1,
  }),
}));

function makeTrade(overrides: Partial<Trade>): Trade {
  return {
    id: 'trade-1',
    botId: 'bot-1',
    botName: 'Cloud Bot',
    action: 'buy',
    assetIn: {
      rawToken: 'USDC',
      symbol: 'USDC',
      name: 'USD Coin',
      primaryLabel: 'USDC',
      isKnown: true,
      accentClassName: 'bg-blue-100 text-blue-700',
      iconText: 'U',
    },
    assetOut: {
      rawToken: 'ETH',
      symbol: 'ETH',
      name: 'Ether',
      primaryLabel: 'ETH',
      isKnown: true,
      accentClassName: 'bg-sky-100 text-sky-700',
      iconText: 'E',
    },
    tokenIn: 'USDC',
    tokenOut: 'ETH',
    amountIn: 100,
    amountOut: 0.03,
    priceUsd: 3300,
    notionalUsd: 100,
    timestamp: Date.parse('2026-04-23T10:40:51.844Z'),
    status: 'paper',
    paperTrade: true,
    venue: 'paper',
    ...overrides,
  };
}

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    token: operatorAuthMock.token,
    isAuthenticated: operatorAuthMock.isAuthenticated,
    isAuthenticating: false,
    authenticate: vi.fn(),
    clearCachedToken: vi.fn(),
    error: null,
    getCachedToken: vi.fn(() => operatorAuthMock.token),
    getToken: vi.fn(async () => operatorAuthMock.token),
  }),
}));

vi.mock('~/lib/hooks/useChartTheme', () => ({
  useChartTheme: () => ({
    positive: '#0f0',
    negative: '#f00',
    positiveGradientStart: 'rgba(0, 255, 0, 0.2)',
    negativeGradientStart: 'rgba(255, 0, 0, 0.2)',
    gradientEnd: 'rgba(0, 0, 0, 0)',
    chartSurface: '#101820',
    hoverBorderColor: '#fff',
    tooltipBg: '#000',
    tooltipBorder: '#333',
    tooltipShadow: '0 18px 40px rgba(0, 0, 0, 0.32)',
    tooltipTitleColor: '#fff',
    tooltipBodyColor: '#fff',
    tickColor: '#999',
    crosshairColor: '#777',
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
    mockPerformanceSummary = null;
    mockPortfolio = undefined;
    mockTrades = [];
    mockLatestTrades = null;
    mockMarkerTrades = null;
    mockTradeTotal = null;
    mockTradeEvidence = null;
    mockTradePageLoading = false;
    mockLatestTradePageLoading = false;
    mockMarkerTradePageLoading = false;
    mockChartStudies = [];
    mockMarketCandles = [];
    useBotMarketCandlesMock.mockImplementation(() => ({
      data: mockMarketCandles,
    }));
    useBotMarketCandlesMock.mockClear();
    operatorAuthMock.isAuthenticated = false;
    operatorAuthMock.token = null;
    lightweightChartMock.areaSeries.createPriceLine.mockClear();
    lightweightChartMock.areaSeries.applyOptions.mockClear();
    lightweightChartMock.areaSeries.removePriceLine.mockClear();
    lightweightChartMock.areaSeries.setData.mockClear();
    lightweightChartMock.candleSeries.applyOptions.mockClear();
    lightweightChartMock.candleSeries.priceToCoordinate.mockClear();
    lightweightChartMock.candleSeries.setData.mockClear();
    lightweightChartMock.navPaneSeries.applyOptions.mockClear();
    lightweightChartMock.navPaneSeries.createPriceLine.mockClear();
    lightweightChartMock.navPaneSeries.removePriceLine.mockClear();
    lightweightChartMock.navPaneSeries.setData.mockClear();
    lightweightChartMock.chart.addPane.mockClear();
    lightweightChartMock.chart.addSeries.mockClear();
    lightweightChartMock.chart.remove.mockClear();
    lightweightChartMock.chart.panes.mockClear();
    lightweightChartMock.chart.priceScale.mockClear();
    lightweightChartMock.chart.subscribeCrosshairMove.mockClear();
    lightweightChartMock.chart.timeScale.mockClear();
    lightweightChartMock.chart.unsubscribeCrosshairMove.mockClear();
    lightweightChartMock.createChart.mockClear();
    lightweightChartMock.createSeriesMarkers.mockClear();
    lightweightChartMock.fitContent.mockClear();
    lightweightChartMock.getVisibleLogicalRange.mockClear();
    lightweightChartMock.scrollPosition.mockClear();
    lightweightChartMock.scrollToPosition.mockClear();
    lightweightChartMock.setVisibleRange.mockClear();
    lightweightChartMock.lineSeries.setData.mockClear();
    lightweightChartMock.markerApi.detach.mockClear();
    lightweightChartMock.markerApi.markers.mockClear();
    lightweightChartMock.markerApi.setMarkers.mockClear();
    lightweightChartMock.pane0.setStretchFactor.mockClear();
    lightweightChartMock.pane1.setStretchFactor.mockClear();
    lightweightChartMock.priceScale.applyOptions.mockClear();
    lightweightChartMock.subscribeVisibleLogicalRangeChange.mockClear();
    lightweightChartMock.timeToCoordinate.mockClear();
    lightweightChartMock.unsubscribeVisibleLogicalRangeChange.mockClear();
    lightweightChartMock.volumeSeries.setData.mockClear();
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

  it('keeps read-only performance visible when operator verification is pending', () => {
    mockMetrics = undefined;

    render(<PerformanceTab bot={makeBot({ verificationState: 'unverified' })} isLive />);

    expect(screen.getByText('Operator verification pending')).toBeInTheDocument();
    expect(screen.getByText('No performance snapshots available yet.')).toBeInTheDocument();
  });

  it('renders the benchmark strip when the operator reports performance vs buy-and-hold', () => {
    mockPerformanceSummary = {
      returnPct: 4.21,
      benchmarkBuyHoldReturnPct: 2.1,
      alphaPct: 2.11,
      maxDrawdownPct: 3.4,
      navLatestUsd: 10421,
      initialCapitalUsd: 10000,
      windowFromMs: Date.parse('2026-05-01T00:00:00.000Z'),
      windowToMs: Date.parse('2026-06-01T00:00:00.000Z'),
    };

    render(<PerformanceTab bot={makeBot()} isLive />);

    const strip = screen.getByRole('region', { name: /performance vs benchmark/i });
    expect(within(strip).getByText('+4.21%')).toBeInTheDocument();
    expect(within(strip).getByText('+2.11%')).toBeInTheDocument();
    expect(within(strip).getByText('B&H +2.10%')).toBeInTheDocument();
    expect(within(strip).getByText('-3.40%')).toBeInTheDocument();
  });

  it('hides the benchmark strip when the performance endpoint is absent', () => {
    mockPerformanceSummary = null;

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(
      screen.queryByRole('region', { name: /performance vs benchmark/i }),
    ).not.toBeInTheDocument();
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

    expect(screen.getAllByText('$-7.87').length).toBeGreaterThan(0);
  });

  it('renders the TradingView performance chart with buy and sell trade markers', async () => {
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
        account_value_usd: 10020.55,
        realized_pnl: 20.55,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 2,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'buy-1',
        action: 'buy',
        timestamp: Date.parse('2026-04-23T10:41:00.000Z'),
      }),
      makeTrade({
        id: 'sell-1',
        action: 'sell',
        timestamp: Date.parse('2026-04-23T11:02:00.000Z'),
      }),
    ];

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(screen.getByTestId('tradingview-performance-chart')).toBeInTheDocument();
    await waitFor(() => expect(lightweightChartMock.createChart).toHaveBeenCalled());
    expect(lightweightChartMock.areaSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 9994.04 }),
        expect.objectContaining({ value: 10020.55 }),
      ]),
    );
    expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ text: 'BUY', shape: 'arrowUp', position: 'belowBar' }),
        expect.objectContaining({ text: 'SELL', shape: 'arrowDown', position: 'aboveBar' }),
      ]),
    );
  });

  it('clusters dense trade markers without collapsing trade timing onto sparse metric checkpoints', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-04-23T11:00:00.000Z',
        account_value_usd: 10080,
        realized_pnl: 80,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 49,
      },
    ];
    mockTrades = Array.from({ length: 49 }, (_, index) => makeTrade({
      id: `trade-${index + 1}`,
      action: index % 2 === 0 ? 'buy' : 'sell',
      timestamp: Date.parse(`2026-04-23T10:${String(index + 5).padStart(2, '0')}:00.000Z`),
    }));

    render(<PerformanceTab bot={makeBot({ totalTrades: 49 })} isLive />);

    await waitFor(() => expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenCalled());
    const markerCall = lightweightChartMock.markerApi.setMarkers.mock.calls.at(-1);
    const markers = markerCall?.[0] as Array<{ text?: string; time: number }>;
    expect(markers.length).toBeGreaterThan(2);
    expect(markers.length).toBeLessThan(49);
    expect(markers.every((marker) => !/BUY|SELL/.test(marker.text ?? ''))).toBe(true);

    const seriesData = lightweightChartMock.areaSeries.setData.mock.calls[0][0] as Array<{ time: number; value: number }>;
    expect(seriesData.length).toBeGreaterThan(2);
    expect(seriesData.length).toBeLessThanOrEqual(2 + markers.length);
  });

  it('updates TradingView data in place on refresh without recreating the chart', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'buy-1',
        action: 'buy',
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
      }),
    ];

    const { rerender } = render(<PerformanceTab bot={makeBot()} isLive />);

    await waitFor(() => expect(lightweightChartMock.createChart).toHaveBeenCalledTimes(1));
    expect(lightweightChartMock.areaSeries.setData).toHaveBeenCalledTimes(1);

    mockMetrics = [
      ...(mockMetrics ?? []),
      {
        timestamp: '2026-04-23T10:05:00.000Z',
        account_value_usd: 10025,
        realized_pnl: 25,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 2,
      },
    ];
    mockTrades = [
      ...mockTrades,
      makeTrade({
        id: 'sell-1',
        action: 'sell',
        timestamp: Date.parse('2026-04-23T10:05:00.000Z'),
      }),
    ];

    rerender(<PerformanceTab bot={makeBot()} isLive />);

    await waitFor(() => expect(lightweightChartMock.areaSeries.setData).toHaveBeenCalledTimes(2));
    expect(lightweightChartMock.createChart).toHaveBeenCalledTimes(1);
    expect(lightweightChartMock.chart.remove).not.toHaveBeenCalled();
    expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ text: 'SELL', shape: 'arrowDown', position: 'aboveBar' }),
      ]),
    );
  });

  it('uses loaded trade rows when checkpoint trade count is stale', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockMetricsSummary = {
      portfolio_value_usd: 10000,
      total_pnl: 0,
      trade_count: 1,
    };
    mockTrades = Array.from({ length: 12 }, (_, index) => makeTrade({
      id: `trade-${index + 1}`,
      timestamp: Date.parse(`2026-04-23T10:${String(index + 5).padStart(2, '0')}:00.000Z`),
    }));

    render(<PerformanceTab bot={makeBot({ totalTrades: 1 })} isLive />);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getAllByText('Fills').length).toBeGreaterThan(0);
    expect(screen.getByText('12 / 12')).toBeInTheDocument();
    expect(screen.queryByText('Execution Tape')).not.toBeInTheDocument();
    expect(screen.queryByText('Fill Ledger')).not.toBeInTheDocument();
  });

  it('uses trade-page totals separately from loaded marker rows', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockMetricsSummary = {
      portfolio_value_usd: 10000,
      total_pnl: 0,
      trade_count: 1,
    };
    mockTrades = Array.from({ length: 6 }, (_, index) => makeTrade({
      id: `trade-${index + 1}`,
      timestamp: Date.parse(`2026-04-23T10:${String(index + 5).padStart(2, '0')}:00.000Z`),
    }));
    mockTradeTotal = 110;

    render(<PerformanceTab bot={makeBot({ totalTrades: 1 })} isLive />);

    expect(screen.getAllByText('Fills').length).toBeGreaterThan(0);
    expect(screen.getByText('110')).toBeInTheDocument();
    expect(screen.getByText('6 loaded')).toBeInTheDocument();
    expect(screen.getByText('6 / 110')).toBeInTheDocument();
  });

  it('renders recent fills while historical chart marker backfill is still loading', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 827,
      },
    ];
    mockMetricsSummary = {
      portfolio_value_usd: 10000,
      total_pnl: 0,
      trade_count: 827,
    };
    mockLatestTrades = [
      makeTrade({
        id: 'latest-fill',
        timestamp: Date.parse('2026-04-23T10:40:00.000Z'),
        notionalUsd: 123.45,
      }),
    ];
    mockMarkerTradePageLoading = true;
    mockTradeTotal = 827;

    render(<PerformanceTab bot={makeBot({ totalTrades: 827 })} isLive />);

    expect(screen.getAllByText('Fills').length).toBeGreaterThan(0);
    expect(screen.getByText('1 / 827')).toBeInTheDocument();
    expect(screen.getByText('$123.45')).toBeInTheDocument();
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
  });

  it('prefers exact backend trade-store evidence over stale roster and metrics counts', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockMetricsSummary = {
      portfolio_value_usd: 10000,
      total_pnl: 0,
      trade_count: 1,
    };
    mockTrades = Array.from({ length: 12 }, (_, index) => makeTrade({
      id: `trade-${index + 1}`,
      timestamp: Date.parse(`2026-04-23T10:${String(index + 5).padStart(2, '0')}:00.000Z`),
    }));
    mockTradeTotal = 12;
    mockTradeEvidence = {
      value: 49,
      source: 'trade-store',
      loaded: 12,
      total: 49,
      isExact: true,
      backendSource: 'trade_store',
      scope: 'bot',
      priced: 37,
      unpriced: 12,
      valuationCoverage: 37 / 49,
    };

    render(<PerformanceTab bot={makeBot({ totalTrades: 1 })} isLive />);

    expect(screen.getAllByText('49').length).toBeGreaterThan(0);
    expect(screen.getByText('12 loaded')).toBeInTheDocument();
    expect(screen.getByText('12 / 12')).toBeInTheDocument();
  });

  it('keeps fill stats aligned to inspectable ledger rows when checkpoint counts are higher', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 168,
      },
    ];
    mockMetricsSummary = {
      portfolio_value_usd: 10000,
      total_pnl: 0,
      trade_count: 168,
    };
    mockTrades = Array.from({ length: 100 }, (_, index) => makeTrade({
      id: `trade-${index + 1}`,
      timestamp: Date.parse(`2026-04-23T10:${String(index % 60).padStart(2, '0')}:00.000Z`),
    }));
    mockTradeTotal = null;

    render(<PerformanceTab bot={makeBot({ totalTrades: 100 })} isLive />);

    expect(screen.getAllByText('100').length).toBeGreaterThan(0);
    expect(screen.queryByText('168')).not.toBeInTheDocument();
    expect(screen.queryByText(/ledger rows/i)).not.toBeInTheDocument();
  });

  it('shows NAV as the active chart mode when market candles are unavailable', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Market' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Market' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'NAV' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('$10,000')[0]?.className).toContain('text-[#f6fefd]');
  });

  it('renders real market candles and volume when OHLCV exists for the traded venue', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'open-eth',
        action: 'open_long',
        targetProtocol: 'hyperliquid',
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
        venue: 'perp',
      }),
    ];
    mockMarketCandles = [
      {
        timestamp: Date.parse('2026-04-23T10:00:00.000Z'),
        token: 'ETH',
        open: 3300,
        high: 3320,
        low: 3294,
        close: 3315,
        volume: 120.5,
      },
      {
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 1650.25,
      },
    ];
    mockChartStudies = [
      {
        id: 'study-breakout',
        schemaVersion: 1,
        botId: 'bot-1',
        token: 'ETH',
        venue: 'hyperliquid',
        interval: '1m',
        title: 'Breakout guard',
        summary: 'Agent is tracking the invalidation level and VWAP reclaim.',
        author: 'agent',
        createdAtMs: Date.parse('2026-04-23T10:01:30.000Z'),
        validFromMs: Date.parse('2026-04-23T10:00:00.000Z'),
        validToMs: Date.parse('2026-04-23T10:01:00.000Z'),
        overlays: [
          {
            id: 'invalidation',
            kind: 'level',
            label: 'Invalidation',
            color: '#B788FF',
            value: 3308,
            points: [],
          },
          {
            id: 'reclaim',
            kind: 'line',
            label: 'VWAP reclaim',
            color: '#F2B84B',
            points: [
              { timestampMs: Date.parse('2026-04-23T10:00:00.000Z'), value: 3310 },
              { timestampMs: Date.parse('2026-04-23T10:01:00.000Z'), value: 3320 },
            ],
          },
        ],
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    expect(screen.getByRole('heading', { name: 'ETH-PERP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Market' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Price')).toBeInTheDocument();
    expect(screen.getByText('H / L')).toBeInTheDocument();
    expect(screen.getByText('Vol')).toBeInTheDocument();
    expect(screen.getAllByText('PnL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$3,324').length).toBeGreaterThan(0);
    await waitFor(() => expect(lightweightChartMock.candleSeries.setData).toHaveBeenCalled());
    expect(lightweightChartMock.candleSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ open: 3300, high: 3320, low: 3294, close: 3315 }),
        expect.objectContaining({ open: 3315, high: 3332, low: 3310, close: 3324 }),
      ]),
    );
    expect(lightweightChartMock.volumeSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 120.5 }),
        expect.objectContaining({ value: 1650.25 }),
      ]),
    );
    expect(lightweightChartMock.chart.addPane).toHaveBeenCalled();
    expect(lightweightChartMock.navPaneSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 10000 }),
      ]),
    );
    expect(screen.getAllByText('NAV').length).toBeGreaterThan(0);
    expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenLastCalledWith([]);
    expect(screen.getByTestId('chart-market-coverage')).toHaveTextContent('2/2 candles');
    expect(screen.getByTestId('chart-market-coverage')).toHaveTextContent('Hyperliquid 15m');
    expect(screen.getByRole('button', { name: 'VWAP' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'SMA 20' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'SMA 20' })).toHaveAttribute('aria-pressed', 'false');
    expect(lightweightChartMock.lineSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.any(Number) }),
      ]),
    );
    expect(screen.getByTestId('chart-agent-studies-chip')).toHaveTextContent('Invalidation +1');
    expect(screen.getByTestId('chart-agent-studies-chip')).toHaveAttribute(
      'title',
      expect.stringContaining('Breakout guard: Invalidation'),
    );
    expect(lightweightChartMock.lineSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 3308 }),
      ]),
    );
    expect(lightweightChartMock.lineSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 3320 }),
      ]),
    );
    await waitFor(() => expect(lightweightChartMock.candleSeries.priceToCoordinate).toHaveBeenCalled());
    expect(lightweightChartMock.candleSeries.priceToCoordinate).toHaveBeenCalledWith(3300);
    expect(await screen.findByLabelText(/LONG .*Apr 23/i)).toBeInTheDocument();
    expect(screen.getByText('1/1 fills')).toBeInTheDocument();
    expect(screen.getByTestId('chart-execution-coverage')).toHaveTextContent('2 candles');
  });

  it('requests venue backfill for inactive Hyperliquid bots so the chart still has market history', () => {
    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive={false}
      />,
    );

    expect(useBotMarketCandlesMock).toHaveBeenCalledWith(
      'bot-1',
      'ETH',
      30,
      expect.objectContaining({
        backfill: true,
        interval: '15m',
        limit: 8_640,
        refetchInterval: false,
        source: 'hyperliquid',
      }),
    );
  });

  it('requests Binance ETH backfill for WETH/USDC DEX bots instead of charting the stable quote leg', () => {
    mockTrades = [
      makeTrade({
        action: 'sell',
        tokenIn: 'WETH',
        tokenOut: 'USDC',
        assetIn: {
          rawToken: 'WETH',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          primaryLabel: 'WETH',
          isKnown: true,
          accentClassName: 'bg-sky-100 text-sky-700',
          iconText: 'W',
        },
        assetOut: {
          rawToken: 'USDC',
          symbol: 'USDC',
          name: 'USD Coin',
          primaryLabel: 'USDC',
          isKnown: true,
          accentClassName: 'bg-blue-100 text-blue-700',
          iconText: 'U',
        },
      }),
    ];

    render(<PerformanceTab bot={makeBot({ strategyType: 'dex' })} isLive={false} />);

    expect(useBotMarketCandlesMock).toHaveBeenCalledWith(
      'bot-1',
      'ETH',
      30,
      expect.objectContaining({
        backfill: true,
        interval: '15m',
        limit: 8_640,
        refetchInterval: false,
        source: 'binance',
      }),
    );
  });

  it('requests Binance ETH backfill for Base address-form DEX trades', () => {
    mockTrades = [
      makeTrade({
        action: 'swap',
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        rawTokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        rawTokenOut: '0x4200000000000000000000000000000000000006',
        assetIn: {
          rawToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          symbol: 'USDC',
          name: 'USD Coin',
          primaryLabel: 'USD Coin',
          secondaryLabel: 'USDC',
          isKnown: true,
          accentClassName: 'bg-blue-100 text-blue-700',
          iconText: 'U',
        },
        assetOut: {
          rawToken: '0x4200000000000000000000000000000000000006',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          primaryLabel: 'Wrapped Ether',
          secondaryLabel: 'WETH',
          isKnown: true,
          accentClassName: 'bg-sky-100 text-sky-700',
          iconText: 'W',
        },
      }),
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'multi',
          chainId: 84532,
          strategyConfig: {
            asset_token: '0x4200000000000000000000000000000000000006',
            cash_token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            protocol_chain_id: 8453,
          },
        })}
        isLive={false}
      />,
    );

    expect(useBotMarketCandlesMock).toHaveBeenCalledWith(
      'bot-1',
      'ETH',
      30,
      expect.objectContaining({
        backfill: true,
        interval: '15m',
        limit: 8_640,
        refetchInterval: false,
        source: 'binance',
      }),
    );
  });

  it('opens the market chart on the selected range while keeping older candles loaded for panning', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-30T00:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'latest-eth',
        action: 'open_long',
        timestamp: Date.parse('2026-04-30T00:00:00.000Z'),
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
        venue: 'perp',
      }),
    ];
    const firstLoadedMs = Date.parse('2026-03-25T00:00:00.000Z');
    mockMarketCandles = Array.from({ length: 37 }, (_, index) => {
      const open = 3200 + index * 4;
      return {
        timestamp: firstLoadedMs + index * 24 * 60 * 60 * 1000,
        token: 'ETH',
        open,
        high: open + 16,
        low: open - 12,
        close: open + 6,
        volume: 1000 + index,
      };
    });

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    const latestLoadedMs = Date.parse('2026-04-30T00:00:00.000Z');
    await waitFor(() => expect(lightweightChartMock.setVisibleRange).toHaveBeenCalled());
    expect(lightweightChartMock.setVisibleRange).toHaveBeenLastCalledWith({
      from: Math.floor((latestLoadedMs - 30 * 24 * 60 * 60 * 1000) / 1000),
      to: Math.ceil(latestLoadedMs / 1000),
    });
    expect(screen.getByTestId('chart-market-coverage')).toHaveTextContent('31/37 candles');
  });

  it('pans chart history on horizontal touchpad wheel without triggering browser navigation', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-30T00:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'latest-eth',
        action: 'open_long',
        timestamp: Date.parse('2026-04-30T00:00:00.000Z'),
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
        venue: 'perp',
      }),
    ];
    const firstLoadedMs = Date.parse('2026-03-25T00:00:00.000Z');
    mockMarketCandles = Array.from({ length: 37 }, (_, index) => {
      const open = 3200 + index * 4;
      return {
        timestamp: firstLoadedMs + index * 24 * 60 * 60 * 1000,
        token: 'ETH',
        open,
        high: open + 16,
        low: open - 12,
        close: open + 6,
        volume: 1000 + index,
      };
    });

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    await waitFor(() => expect(lightweightChartMock.createChart).toHaveBeenCalled());
    const chartShell = screen.getByTestId('tradingview-performance-chart');
    Object.defineProperty(chartShell, 'clientWidth', { configurable: true, value: 1000 });

    const horizontalWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 100,
      deltaY: 4,
    });
    const horizontalResult = chartShell.dispatchEvent(horizontalWheel);

    expect(horizontalResult).toBe(false);
    expect(horizontalWheel.defaultPrevented).toBe(true);
    expect(lightweightChartMock.scrollToPosition).toHaveBeenCalledWith(expect.any(Number), false);
    expect(lightweightChartMock.scrollToPosition.mock.calls.at(-1)?.[0]).toBeGreaterThan(2);

    const verticalWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 1,
      deltaY: 100,
    });
    const verticalResult = chartShell.dispatchEvent(verticalWheel);

    expect(verticalResult).toBe(true);
    expect(verticalWheel.defaultPrevented).toBe(false);
    expect(lightweightChartMock.scrollToPosition).toHaveBeenCalledTimes(1);
  });

  it('groups dense same-location market executions into one readable marker', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 20,
      },
    ];
    mockTrades = Array.from({ length: 20 }, (_, index) => makeTrade({
      id: `clustered-fill-${index + 1}`,
      action: 'buy',
      timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
      priceUsd: 3315,
      venue: 'perp',
      hyperliquidMetadata: {
        asset: 'ETH',
        assetSize: '0.03',
        orderType: 'market',
        reduceOnly: false,
      },
    }));
    mockMarketCandles = [
      {
        timestamp: Date.parse('2026-04-23T10:00:00.000Z'),
        token: 'ETH',
        open: 3300,
        high: 3320,
        low: 3294,
        close: 3315,
        volume: 120.5,
      },
      {
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 1650.25,
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    expect(await screen.findByLabelText(/BUY x20 .*Apr 23/i)).toBeInTheDocument();
    expect(screen.getByText('x20')).toBeInTheDocument();
    const coverage = screen.getByTestId('chart-execution-coverage');
    expect(coverage).toHaveTextContent('20/20 fills');
    expect(coverage).toHaveTextContent('1 groups');
  });

  it('surfaces Hyperliquid exposure risk from the live portfolio feed', () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockPortfolio = {
      displayTotalValueUsd: 10000,
      totalValueUsd: 10000,
      observedAt: '2026-04-23T10:02:00.000Z',
      stale: false,
      positions: [
        {
          token: 'ETH',
          symbol: 'ETH',
          amount: 2.5,
          currentPrice: 2000,
          liquidationPrice: 1800,
          marginUsedUsd: 1000,
          notionalUsd: 5000,
          unrealizedPnlUsd: -125.5,
          leverage: 5,
          protocol: 'hyperliquid',
          positionType: 'long',
          valueUsd: 1000,
          displayValueUsd: 1000,
          displayPnlPercent: -2.51,
          displayWeight: 10,
          warnings: [],
          valuationStatus: 'priced',
          asset: {
            rawToken: 'ETH',
            symbol: 'ETH',
            name: 'Ether',
            primaryLabel: 'ETH',
            isKnown: true,
            accentClassName: 'bg-sky-100 text-sky-700',
            iconText: 'E',
          },
        },
        {
          token: 'USDC',
          symbol: 'USDC',
          amount: 5000,
          currentPrice: 1,
          protocol: 'hyperliquid',
          positionType: 'cash',
          valueUsd: 5000,
          displayValueUsd: 5000,
          displayPnlPercent: null,
          displayWeight: 50,
          warnings: [],
          valuationStatus: 'value_only',
          asset: {
            rawToken: 'USDC',
            symbol: 'USDC',
            name: 'USD Coin',
            primaryLabel: 'USDC',
            isKnown: true,
            accentClassName: 'bg-blue-100 text-blue-700',
            iconText: 'U',
          },
        },
      ],
    };

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    expect(screen.getByLabelText('Hyperliquid exposure')).toBeInTheDocument();
    expect(screen.getByText('1 open position')).toBeInTheDocument();
    expect(screen.getByText('$5,000')).toBeInTheDocument();
    expect(screen.getByText('$1,000 margin')).toBeInTheDocument();
    expect(screen.getByText('10.0%')).toBeInTheDocument();
    expect(screen.getByText('5.00x')).toBeInTheDocument();
    expect(screen.getByText('$1,800')).toBeInTheDocument();
    expect(screen.getByText('10.0% away')).toBeInTheDocument();
    expect(screen.getByText(/\$-125/)).toBeInTheDocument();
    expect(screen.getByText('live account')).toBeInTheDocument();
  });

  it('uses compact dates on long-range market axis ticks', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-20T18:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'multi-day-fill',
        action: 'open_long',
        timestamp: Date.parse('2026-04-24T18:00:00.000Z'),
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
        venue: 'perp',
      }),
    ];
    mockMarketCandles = [
      {
        timestamp: Date.parse('2026-04-20T18:00:00.000Z'),
        token: 'ETH',
        open: 3300,
        high: 3320,
        low: 3294,
        close: 3315,
        volume: 120.5,
      },
      {
        timestamp: Date.parse('2026-04-20T18:20:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3322,
        low: 3308,
        close: 3318,
        volume: 98,
      },
      {
        timestamp: Date.parse('2026-04-24T18:00:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 1650.25,
      },
      {
        timestamp: Date.parse('2026-04-30T12:00:00.000Z'),
        token: 'ETH',
        open: 3324,
        high: 3340,
        low: 3312,
        close: 3338,
        volume: 1500,
      },
      {
        timestamp: Date.parse('2026-04-30T18:00:00.000Z'),
        token: 'ETH',
        open: 3338,
        high: 3350,
        low: 3320,
        close: 3342,
        volume: 1400,
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    await waitFor(() => expect(lightweightChartMock.createChart).toHaveBeenCalled());
    const createChartCalls = lightweightChartMock.createChart.mock.calls as unknown as Array<[
      unknown,
      { timeScale?: { tickMarkFormatter?: (time: number) => string } },
    ]>;
    const chartOptions = createChartCalls[0]?.[1];
    const formatter = chartOptions.timeScale?.tickMarkFormatter;
    if (!formatter) throw new Error('Expected market chart tick formatter');
    expect(formatter(Math.floor(Date.parse('2026-04-20T18:20:00.000Z') / 1000))).toBe('');
    const label = formatter(Math.floor(Date.parse('2026-04-24T18:00:00.000Z') / 1000));
    expect(label).toBe('Apr 24');
    expect(label).not.toBe('12:00 PM');
    const tailLabel = formatter(Math.floor(Date.parse('2026-04-30T12:00:00.000Z') / 1000));
    expect(tailLabel).toMatch(/\b(AM|PM)\b/);
    expect(tailLabel).not.toContain('Apr 30');
  });

  it('uses compact dates on long-range NAV axis ticks', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-20T18:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 0,
      },
      {
        timestamp: '2026-04-20T18:20:00.000Z',
        account_value_usd: 10010,
        realized_pnl: 10,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 0,
      },
      {
        timestamp: '2026-04-24T18:00:00.000Z',
        account_value_usd: 10042,
        realized_pnl: 42,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-04-30T12:00:00.000Z',
        account_value_usd: 10080,
        realized_pnl: 80,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-04-30T18:00:00.000Z',
        account_value_usd: 10090,
        realized_pnl: 90,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];

    render(<PerformanceTab bot={makeBot()} isLive />);

    await waitFor(() => expect(lightweightChartMock.createChart).toHaveBeenCalled());
    const createChartCalls = lightweightChartMock.createChart.mock.calls as unknown as Array<[
      unknown,
      { timeScale?: { tickMarkFormatter?: (time: number) => string } },
    ]>;
    const chartOptions = createChartCalls[0]?.[1];
    const formatter = chartOptions.timeScale?.tickMarkFormatter;
    if (!formatter) throw new Error('Expected NAV chart tick formatter');
    expect(formatter(Math.floor(Date.parse('2026-04-20T18:20:00.000Z') / 1000))).toBe('');
    const label = formatter(Math.floor(Date.parse('2026-04-24T18:00:00.000Z') / 1000));
    expect(label).toBe('Apr 24');
    expect(label).not.toBe('12:00 PM');
    const tailLabel = formatter(Math.floor(Date.parse('2026-04-30T12:00:00.000Z') / 1000));
    expect(tailLabel).toMatch(/\b(AM|PM)\b/);
    expect(tailLabel).not.toContain('Apr 30');
  });

  it('uses time-only intraday NAV ticks on multi-day ranges', async () => {
    mockMetrics = [
      {
        timestamp: '2026-05-29T06:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 0,
      },
      {
        timestamp: '2026-05-30T06:00:00.000Z',
        account_value_usd: 10008,
        realized_pnl: 8,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-05-30T12:00:00.000Z',
        account_value_usd: 10012,
        realized_pnl: 12,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-05-30T12:25:00.000Z',
        account_value_usd: 10014,
        realized_pnl: 14,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
      {
        timestamp: '2026-05-30T18:30:00.000Z',
        account_value_usd: 10018,
        realized_pnl: 18,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];

    render(<PerformanceTab bot={makeBot()} isLive />);

    await waitFor(() => expect(lightweightChartMock.createChart).toHaveBeenCalled());
    const createChartCalls = lightweightChartMock.createChart.mock.calls as unknown as Array<[
      unknown,
      { timeScale?: { tickMarkFormatter?: (time: number) => string } },
    ]>;
    const chartOptions = createChartCalls[0]?.[1];
    const formatter = chartOptions.timeScale?.tickMarkFormatter;
    if (!formatter) throw new Error('Expected NAV chart tick formatter');

    expect(formatter(Math.floor(Date.parse('2026-05-30T06:00:00.000Z') / 1000))).toBe('May 30');
    const sixAmLabel = formatter(Math.floor(Date.parse('2026-05-30T12:00:00.000Z') / 1000));
    const sixTwentyFiveLabel = formatter(Math.floor(Date.parse('2026-05-30T12:25:00.000Z') / 1000));
    expect(sixAmLabel).toBe('6:00 AM');
    expect(sixTwentyFiveLabel).toBe('6:25 AM');
    expect(sixAmLabel).not.toContain('May 30');
    expect(sixTwentyFiveLabel).not.toContain('May 30');
  });

  it('does not pin off-window fills to the first or last market candle', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'late-fill',
        action: 'open_long',
        timestamp: Date.parse('2026-04-23T10:12:00.000Z'),
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
        venue: 'perp',
      }),
    ];
    mockMarketCandles = [
      {
        timestamp: Date.parse('2026-04-23T10:00:00.000Z'),
        token: 'ETH',
        open: 3300,
        high: 3320,
        low: 3294,
        close: 3315,
        volume: 120.5,
      },
      {
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 1650.25,
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    await waitFor(() => expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenCalled());
    expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenLastCalledWith([]);
    expect(screen.queryByLabelText(/LONG .*Apr 23/i)).not.toBeInTheDocument();
    expect(screen.getByText('0/1 fills')).toBeInTheDocument();
  });

  it('surfaces chart fill coverage when ledger totals exceed visible market markers', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 49,
      },
    ];
    mockTradeEvidence = {
      value: 49,
      source: 'trade-store',
      loaded: 2,
      total: 49,
      isExact: true,
      backendSource: 'trade_store',
      scope: 'bot',
      outsidePage: 47,
      priced: 37,
      unpriced: 12,
      valuationCoverage: 37 / 49,
    };
    mockTrades = [
      makeTrade({
        id: 'visible-fill',
        action: 'open_long',
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        priceUsd: 3300,
        venue: 'perp',
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
      }),
      makeTrade({
        id: 'outside-candle-fill',
        action: 'close_long',
        timestamp: Date.parse('2026-04-23T10:12:00.000Z'),
        priceUsd: 3318,
        venue: 'perp',
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: true,
        },
      }),
    ];
    mockMarketCandles = [
      {
        timestamp: Date.parse('2026-04-23T10:00:00.000Z'),
        token: 'ETH',
        open: 3300,
        high: 3320,
        low: 3294,
        close: 3315,
        volume: 120.5,
      },
      {
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 1650.25,
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    const coverage = await screen.findByTestId('chart-execution-coverage');
    expect(coverage).toHaveTextContent('1/49 fills');
    expect(coverage).toHaveTextContent('1 off-window');
    expect(coverage).toHaveTextContent('47 outside page');
    expect(coverage).toHaveTextContent('12 unpriced');
    expect(coverage).toHaveTextContent('2 candles');
  });

  it('pins a clicked market execution in the chart ticket', async () => {
    const user = userEvent.setup();
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 2,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'sell-eth',
        action: 'sell',
        targetProtocol: 'hyperliquid',
        timestamp: Date.parse('2026-04-23T10:00:00.000Z'),
        priceUsd: 3300,
        notionalUsd: 100,
        venue: 'perp',
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: true,
        },
      }),
      makeTrade({
        id: 'long-eth',
        action: 'open_long',
        targetProtocol: 'hyperliquid',
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        priceUsd: 3324,
        notionalUsd: 99.72,
        venue: 'perp',
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.03',
          orderType: 'market',
          reduceOnly: false,
        },
      }),
    ];
    mockMarketCandles = [
      {
        timestamp: Date.parse('2026-04-23T10:00:00.000Z'),
        token: 'ETH',
        open: 3300,
        high: 3320,
        low: 3294,
        close: 3315,
        volume: 120.5,
      },
      {
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 1650.25,
      },
    ];

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    const ticket = await screen.findByTestId('chart-featured-execution');
    expect(within(ticket).getByText('LONG')).toBeInTheDocument();
    expect(ticket).toHaveTextContent('$3,324');
    expect(ticket).toHaveTextContent('Hyperliquid');
    expect(ticket).toHaveTextContent('ETH-PERP');
    expect(ticket).toHaveTextContent('0.03 ETH');
    expect(ticket).toHaveTextContent('$99.72 notional');

    await user.click(await screen.findByLabelText(/Sell .*Apr 23/i));

    const pinnedTicket = screen.getByTestId('chart-featured-execution');
    expect(within(pinnedTicket).getByText('SELL')).toBeInTheDocument();
    expect(pinnedTicket).toHaveTextContent('$3,300');
    expect(pinnedTicket).toHaveTextContent('Hyperliquid');
    expect(pinnedTicket).toHaveTextContent('$100 notional');
    const markerTooltip = screen.getByTestId('chart-execution-tooltip');
    expect(markerTooltip).toHaveTextContent('SELL');
    expect(markerTooltip).toHaveTextContent('Hyperliquid');
    expect(markerTooltip).toHaveTextContent('ETH-PERP');
  });

  it('keeps execution evidence visible while showing the owner copilot', async () => {
    operatorAuthMock.isAuthenticated = true;
    operatorAuthMock.token = 'test-token';
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [makeTrade({ id: 'owner-trade' })];

    render(<PerformanceTab bot={makeBot()} isLive canCommand />);

    expect(await screen.findByText('Owner chart copilot')).toBeInTheDocument();
    expect(screen.getAllByText('Fills').length).toBeGreaterThan(0);
  });

  it('keeps authenticated non-commandable viewers on the public trade tape', async () => {
    operatorAuthMock.isAuthenticated = true;
    operatorAuthMock.token = 'test-token';
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTrades = [makeTrade({ id: 'trade-public' })];

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(screen.queryByText('Owner chart copilot')).not.toBeInTheDocument();
    expect((await screen.findAllByText('Fills')).length).toBeGreaterThan(0);
  });

  it('keeps the agent recent-trades rail stable while the trade ledger loads', async () => {
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 1,
      },
    ];
    mockTradePageLoading = true;

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect((await screen.findAllByText('Fills')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Latest Trades')).not.toBeInTheDocument();
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('lets public viewers inspect the selected chart trade decision', async () => {
    const user = userEvent.setup();
    mockMetrics = [
      {
        timestamp: '2026-04-23T10:00:00.000Z',
        account_value_usd: 10000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        trade_count: 2,
      },
    ];
    mockTrades = [
      makeTrade({
        id: 'trade-latest',
        action: 'sell',
        agentReasoning: 'Latest sell decision rationale.',
        timestamp: Date.parse('2026-04-23T10:07:00.000Z'),
      }),
      makeTrade({
        id: 'trade-older',
        action: 'buy',
        agentReasoning: 'Older buy decision rationale.',
        timestamp: Date.parse('2026-04-23T10:05:00.000Z'),
      }),
    ];

    render(<PerformanceTab bot={makeBot()} isLive />);

    expect(screen.getByRole('complementary', { name: /decision inspector/i })).toBeInTheDocument();
    expect(screen.getAllByText('Latest sell decision rationale.').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /BUY/i }));

    expect(screen.getAllByText('Older buy decision rationale.').length).toBeGreaterThan(0);
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

    expect(screen.getByText(/May 27, 4:05 AM.*live May 27, 4:07 AM/)).toBeInTheDocument();
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

    expect(screen.getByText('May 27, 4:05 AM')).toBeInTheDocument();
    expect(screen.queryByText(/live May 27/)).not.toBeInTheDocument();
  });
});
