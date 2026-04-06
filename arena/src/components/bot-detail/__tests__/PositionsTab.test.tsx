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
    hasSuspiciousPositions: false,
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
        isSuspicious: false,
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

  it('warns and masks suspicious portfolio values', () => {
    mockPortfolio = makePortfolio({
      displayTotalValueUsd: null,
      displayCashBalance: null,
      warnings: ['Some portfolio metrics were hidden because the operator returned values that failed sanity checks.'],
      hasSuspiciousPositions: true,
      positions: [
        {
          token: 'USDC',
          symbol: 'USDC',
          amount: 3200,
          valueUsd: 32,
          entryPrice: 0.000390625,
          currentPrice: 0.01,
          pnlPercent: 2460,
          weight: 0.3,
          displayValueUsd: null,
          displayPnlPercent: null,
          displayWeight: null,
          warnings: ['Stablecoin value is inconsistent with its reported amount.'],
          isSuspicious: true,
        },
      ],
    });

    render(<PositionsTab botId="bot-1" status="active" operatorApiUrl="/operator-api" operatorKind="cloud" />);

    expect(screen.getByText('Portfolio metrics partially hidden')).toBeInTheDocument();
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('3,200')).toBeInTheDocument();
  });
});
