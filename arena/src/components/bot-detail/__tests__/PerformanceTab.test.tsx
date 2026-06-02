import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';
import { PerformanceTab } from '../PerformanceTab';

mockBlueprintUi();
mockFramerMotion();

const lightweightChartMock = vi.hoisted(() => {
  const fitContent = vi.fn();
  const areaSeries = {
    createPriceLine: vi.fn(),
    setData: vi.fn(),
  };
  const candleSeries = {
    setData: vi.fn(),
  };
  const volumeSeries = {
    setData: vi.fn(),
  };
  const priceScale = {
    applyOptions: vi.fn(),
  };
  const chart = {
    addSeries: vi.fn((seriesType: string) => {
      if (seriesType === 'CandlestickSeries') return candleSeries;
      if (seriesType === 'HistogramSeries') return volumeSeries;
      return areaSeries;
    }),
    remove: vi.fn(),
    priceScale: vi.fn(() => priceScale),
    subscribeCrosshairMove: vi.fn(),
    timeScale: vi.fn(() => ({ fitContent })),
    unsubscribeCrosshairMove: vi.fn(),
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
    createSeriesMarkers: vi.fn(),
    fitContent,
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

let mockMetrics: Array<Record<string, unknown>> | undefined = [];
let mockMetricsSummary: Record<string, number> | undefined = {
  portfolio_value_usd: 10000,
  total_pnl: 0,
  trade_count: 0,
};
let mockPortfolio: Record<string, unknown> | undefined;
let mockTrades: Trade[] = [];
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
    mockMarketCandles = [];
    operatorAuthMock.isAuthenticated = false;
    operatorAuthMock.token = null;
    lightweightChartMock.areaSeries.createPriceLine.mockClear();
    lightweightChartMock.areaSeries.setData.mockClear();
    lightweightChartMock.candleSeries.setData.mockClear();
    lightweightChartMock.chart.addSeries.mockClear();
    lightweightChartMock.chart.remove.mockClear();
    lightweightChartMock.chart.priceScale.mockClear();
    lightweightChartMock.chart.subscribeCrosshairMove.mockClear();
    lightweightChartMock.chart.timeScale.mockClear();
    lightweightChartMock.chart.unsubscribeCrosshairMove.mockClear();
    lightweightChartMock.createChart.mockClear();
    lightweightChartMock.createSeriesMarkers.mockClear();
    lightweightChartMock.fitContent.mockClear();
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
    expect(lightweightChartMock.createSeriesMarkers).toHaveBeenCalledWith(
      lightweightChartMock.areaSeries,
      expect.arrayContaining([
        expect.objectContaining({ text: 'BUY', shape: 'arrowUp', position: 'belowBar' }),
        expect.objectContaining({ text: 'SELL', shape: 'arrowDown', position: 'aboveBar' }),
      ]),
      { autoScale: true },
    );
  });

  it('does not collapse dense trade history onto sparse metric checkpoints', async () => {
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

    await waitFor(() => expect(lightweightChartMock.createSeriesMarkers).toHaveBeenCalled());
    const markerCall = lightweightChartMock.createSeriesMarkers.mock.calls[0];
    const markers = markerCall[1] as Array<{ text?: string; time: number }>;
    expect(markers).toHaveLength(49);
    expect(new Set(markers.map((marker) => marker.time)).size).toBe(49);

    const seriesData = lightweightChartMock.areaSeries.setData.mock.calls[0][0] as Array<{ time: number; value: number }>;
    expect(seriesData.length).toBeGreaterThan(2);
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
        volume: 120,
      },
      {
        timestamp: Date.parse('2026-04-23T10:01:00.000Z'),
        token: 'ETH',
        open: 3315,
        high: 3332,
        low: 3310,
        close: 3324,
        volume: 165,
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

    expect(screen.getByRole('heading', { name: 'ETH' })).toBeInTheDocument();
    expect(screen.getByText('Market')).toBeInTheDocument();
    await waitFor(() => expect(lightweightChartMock.candleSeries.setData).toHaveBeenCalled());
    expect(lightweightChartMock.candleSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ open: 3300, high: 3320, low: 3294, close: 3315 }),
        expect.objectContaining({ open: 3315, high: 3332, low: 3310, close: 3324 }),
      ]),
    );
    expect(lightweightChartMock.volumeSeries.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 120 }),
        expect.objectContaining({ value: 165 }),
      ]),
    );
    expect(lightweightChartMock.createSeriesMarkers).toHaveBeenCalledWith(
      lightweightChartMock.candleSeries,
      expect.arrayContaining([
        expect.objectContaining({ text: 'BUY', shape: 'arrowUp', position: 'belowBar' }),
      ]),
      { autoScale: true },
    );
  });

  it('shows the owner copilot instead of the public trade tape when operator auth is active', async () => {
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

    render(<PerformanceTab bot={makeBot()} isLive canCommand />);

    expect(await screen.findByText('Owner chart copilot')).toBeInTheDocument();
    expect(screen.queryByText('Trade Tape')).not.toBeInTheDocument();
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
    expect(await screen.findByText('Trade Tape')).toBeInTheDocument();
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
