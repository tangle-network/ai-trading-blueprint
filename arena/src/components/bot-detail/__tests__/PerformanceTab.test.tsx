import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';
import { PerformanceTab } from '../PerformanceTab';

mockBlueprintUi();
mockFramerMotion();

const lightweightChartMock = vi.hoisted(() => {
  const fitContent = vi.fn();
  const areaSeries = {
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(),
    removePriceLine: vi.fn(),
    setData: vi.fn(),
  };
  const candleSeries = {
    applyOptions: vi.fn(),
    setData: vi.fn(),
  };
  const volumeSeries = {
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
      if (paneIndex === 1) return navPaneSeries;
      return areaSeries;
    }),
    remove: vi.fn(),
    panes: vi.fn(() => [pane0, pane1]),
    priceScale: vi.fn(() => priceScale),
    subscribeCrosshairMove: vi.fn(),
    timeScale: vi.fn(() => ({ fitContent })),
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
    LineStyle: { Dashed: 2, Dotted: 1 },
    areaSeries,
    candleSeries,
    chart,
    createChart: vi.fn(() => chart),
    createSeriesMarkers: vi.fn(() => markerApi),
    fitContent,
    markerApi,
    navPaneSeries,
    pane0,
    pane1,
    priceScale,
    volumeSeries,
  };
});
const operatorAuthMock = vi.hoisted(() => ({
  isAuthenticated: false,
  token: null as string | null,
}));

vi.mock('../lightweightChartRuntime', () => ({
  loadLightweightCharts: vi.fn(async () => lightweightChartMock),
}));

vi.mock('../PerformanceCopilotPanel', () => ({
  PerformanceCopilotPanel: () => <div>Owner chart copilot</div>,
}));

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
}));

let mockMetrics: Array<Record<string, unknown>> | undefined = [];
let mockMetricsSummary: Record<string, number> | undefined = {
  portfolio_value_usd: 10000,
  total_pnl: 0,
  trade_count: 0,
};
let mockPortfolio: Record<string, unknown> | undefined;
let mockTrades: Trade[] = [];
let mockTradeTotal: number | null = null;
let mockTradePageLoading = false;
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
    data: mockTrades,
  }),
  useBotTradePage: () => ({
    data: mockTradePageLoading
      ? undefined
      : {
          trades: mockTrades,
          total: mockTradeTotal,
          loaded: mockTrades.length,
          limit: 100,
          offset: 0,
          hasTotal: mockTradeTotal != null,
          isCapped: mockTradeTotal != null ? mockTrades.length < mockTradeTotal : false,
          legacyArray: mockTradeTotal == null,
        },
  }),
  useBotMarketCandles: () => ({
    data: mockMarketCandles,
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
    mockTrades = [];
    mockTradeTotal = null;
    mockTradePageLoading = false;
    mockMarketCandles = [];
    operatorAuthMock.isAuthenticated = false;
    operatorAuthMock.token = null;
    lightweightChartMock.areaSeries.createPriceLine.mockClear();
    lightweightChartMock.areaSeries.applyOptions.mockClear();
    lightweightChartMock.areaSeries.removePriceLine.mockClear();
    lightweightChartMock.areaSeries.setData.mockClear();
    lightweightChartMock.candleSeries.applyOptions.mockClear();
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
    lightweightChartMock.markerApi.detach.mockClear();
    lightweightChartMock.markerApi.markers.mockClear();
    lightweightChartMock.markerApi.setMarkers.mockClear();
    lightweightChartMock.pane0.setStretchFactor.mockClear();
    lightweightChartMock.pane1.setStretchFactor.mockClear();
    lightweightChartMock.priceScale.applyOptions.mockClear();
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
    expect(screen.getByText('Loaded Trades')).toBeInTheDocument();
    expect(screen.getByText('Execution Tape')).toBeInTheDocument();
    expect(screen.getByText('6 / 12')).toBeInTheDocument();
    expect(screen.getByText('Fill Ledger')).toBeInTheDocument();
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

    expect(screen.getByText('Total Trades')).toBeInTheDocument();
    expect(screen.getByText('110')).toBeInTheDocument();
    expect(screen.getByText('6 loaded')).toBeInTheDocument();
    expect(screen.getByText('6 / 110')).toBeInTheDocument();
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

    render(
      <PerformanceTab
        bot={makeBot({
          strategyType: 'hyperliquid_perp',
          strategyConfig: { asset: 'ETH' },
        })}
        isLive
      />,
    );

    expect(screen.getByRole('heading', { name: 'ETH Price' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Market' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Last Price')).toBeInTheDocument();
    expect(screen.getByText('30D High / Low')).toBeInTheDocument();
    expect(screen.getByText('Volume')).toBeInTheDocument();
    expect(screen.getByText('Range PnL')).toBeInTheDocument();
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
    expect(screen.getByText('Account NAV / PnL')).toBeInTheDocument();
    expect(lightweightChartMock.markerApi.setMarkers).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ text: '', shape: 'arrowUp', position: 'belowBar' }),
      ]),
    );
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
    expect(screen.getByText('Execution Tape')).toBeInTheDocument();
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
    expect(await screen.findByText('Execution Tape')).toBeInTheDocument();
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

    expect(await screen.findByText('Execution Tape')).toBeInTheDocument();
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
