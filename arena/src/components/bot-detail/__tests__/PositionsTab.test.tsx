import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PositionsTab } from '../PositionsTab';
import { mockBlueprintUi } from '~/test/mocks';
import type { Portfolio } from '~/lib/types/portfolio';

mockBlueprintUi();

let mockPortfolio: Portfolio | null = null;
let isLoading = false;

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotPortfolio: () => ({ data: mockPortfolio, isLoading }),
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

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    botId: 'bot-1',
    totalValueUsd: 10000,
    cashBalance: 9000,
    displayTotalValueUsd: 10000,
    displayCashBalance: 9000,
    warnings: [],
    hasUnpricedPositions: false,
    hasValueOnlyPositions: false,
    positions: [
      {
        token: 'WETH',
        symbol: 'WETH',
        amount: 0.5,
        valueUsd: 1000,
        entryPrice: 2000,
        currentPrice: 2000,
        pnlPercent: 0,
        weight: 10,
        displayValueUsd: 1000,
        displayPnlPercent: 0,
        displayWeight: 10,
        warnings: [],
        valuationStatus: 'priced',
      },
    ],
    ...overrides,
  };
}

describe('PositionsTab', () => {
  beforeEach(() => {
    mockPortfolio = makePortfolio();
    isLoading = false;
  });

  it('renders coherent portfolio values normally', () => {
    render(<PositionsTab botId="bot-1" status="active" operatorApiUrl="/operator-api" operatorKind="cloud" />);

    expect(screen.getByText('$10,000')).toBeInTheDocument();
    expect(screen.getByText('$9,000')).toBeInTheDocument();
    expect(screen.getByText('$1,000')).toBeInTheDocument();
    expect(screen.getByText('+0.00%')).toBeInTheDocument();
    expect(screen.getByText('10.0%')).toBeInTheDocument();
  });

  it('warns and masks unpriced portfolio values', () => {
    mockPortfolio = makePortfolio({
      totalValueUsd: null,
      cashBalance: null,
      displayTotalValueUsd: null,
      displayCashBalance: null,
      warnings: ['Some portfolio values are unavailable because trade valuation data is missing.'],
      hasUnpricedPositions: true,
      hasValueOnlyPositions: false,
      positions: [
        {
          token: 'USDC',
          symbol: 'USDC',
          amount: 3200,
          valueUsd: null,
          entryPrice: null,
          currentPrice: null,
          pnlPercent: null,
          weight: null,
          displayValueUsd: null,
          displayPnlPercent: null,
          displayWeight: null,
          warnings: ['Valuation data is unavailable for this position.'],
          valuationStatus: 'unpriced',
        },
      ],
    });

    render(<PositionsTab botId="bot-1" status="active" operatorApiUrl="/operator-api" operatorKind="cloud" />);

    expect(screen.getByText('Portfolio valuation unavailable')).toBeInTheDocument();
    expect(screen.getByText('Unpriced')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('3,200')).toBeInTheDocument();
  });

  it('shows recovered value-only positions without inventing entry or pnl', () => {
    mockPortfolio = makePortfolio({
      totalValueUsd: 4200,
      cashBalance: 1000,
      displayTotalValueUsd: 4200,
      displayCashBalance: 1000,
      warnings: ['Some positions have current market value, but entry price or PnL are unavailable.'],
      hasUnpricedPositions: false,
      hasValueOnlyPositions: true,
      positions: [
        {
          token: 'WETH',
          symbol: 'WETH',
          amount: 2,
          valueUsd: 4200,
          entryPrice: null,
          currentPrice: 2100,
          pnlPercent: null,
          weight: null,
          displayValueUsd: 4200,
          displayPnlPercent: null,
          displayWeight: null,
          warnings: ['Entry price and PnL are unavailable for this position.'],
          valuationStatus: 'value_only',
        },
      ],
    });

    render(<PositionsTab botId="bot-1" status="active" operatorApiUrl="/operator-api" operatorKind="cloud" />);

    expect(screen.getByText('Portfolio valuation partially available')).toBeInTheDocument();
    expect(screen.getByText('Value only')).toBeInTheDocument();
    expect(screen.getAllByText('$4,200').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('$2,100')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2);
  });

  it('still renders the last known portfolio when the bot is stopped', () => {
    mockPortfolio = makePortfolio({
      totalValueUsd: 1042.68,
      cashBalance: 0.4822734375,
      displayTotalValueUsd: 1042.68,
      displayCashBalance: 0.4822734375,
      hasValueOnlyPositions: false,
      positions: [
        {
          token: 'WETH',
          symbol: 'WETH',
          amount: 0.4822734375,
          valueUsd: 1042.68,
          entryPrice: null,
          currentPrice: 2162.02,
          pnlPercent: null,
          weight: 100,
          displayValueUsd: 1042.68,
          displayPnlPercent: null,
          displayWeight: 100,
          warnings: [],
          valuationStatus: 'priced',
        },
      ],
    });

    render(<PositionsTab botId="bot-1" status="stopped" operatorApiUrl="/operator-api" operatorKind="cloud" />);

    expect(screen.getAllByText('$1,042.68').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('$2,162.02')).toBeInTheDocument();
    expect(screen.getByText('0.4823 WETH')).toBeInTheDocument();
    expect(screen.queryByText(/Live portfolio is unavailable while this bot is stopped/i)).not.toBeInTheDocument();
  });
});
