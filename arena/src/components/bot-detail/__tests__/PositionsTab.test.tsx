import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '~/test/mockBlueprintUi';
import { PositionsTab } from '../PositionsTab';
import type { Portfolio } from '~/lib/types/portfolio';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';

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
        asset: resolveAssetDisplay('WETH'),
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
    expect(screen.getAllByText('$1,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('10.0%')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'PnL' })).not.toBeInTheDocument();
    expect(screen.queryByText('Balance')).not.toBeInTheDocument();
    expect(screen.getByRole('table').parentElement).not.toHaveClass('rounded-lg');
  });

  it('keeps read-only positions visible when operator verification is pending', () => {
    render(
      <PositionsTab
        botId="bot-1"
        status="active"
        operatorApiUrl="/operator-api"
        operatorKind="cloud"
        verificationState="unverified"
      />,
    );

    expect(screen.getByText('Operator verification pending')).toBeInTheDocument();
    expect(screen.getByText('$10,000')).toBeInTheDocument();
    expect(screen.getByText('WETH')).toBeInTheDocument();
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
          asset: resolveAssetDisplay('USDC'),
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
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('3,200')).toBeInTheDocument();
  });

  it('shows recovered value-only positions using current market value only', () => {
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
          asset: resolveAssetDisplay('WETH'),
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

    expect(screen.queryByText('Portfolio valuation partially available')).not.toBeInTheDocument();
    expect(screen.queryByText('Some positions only have current market value available.')).not.toBeInTheDocument();
    expect(screen.getByText('Value only')).toBeInTheDocument();
    expect(screen.getAllByText('$4,200').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('$2,100')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Entry price and PnL are unavailable for this position.')).not.toBeInTheDocument();
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
          asset: resolveAssetDisplay('WETH'),
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
    expect(screen.queryByText('Balance')).not.toBeInTheDocument();
    expect(screen.queryByText(/Live portfolio is unavailable while this bot is stopped/i)).not.toBeInTheDocument();
  });

  it('renders Hyperliquid perp positions with perp-specific labels', () => {
    mockPortfolio = makePortfolio({
      totalValueUsd: 8.187387,
      cashBalance: 0,
      displayTotalValueUsd: 8.187387,
      displayCashBalance: 0,
      hasValueOnlyPositions: true,
      positions: [
        {
          asset: resolveAssetDisplay('ETH'),
          token: 'ETH',
          symbol: 'WETH',
          amount: 0.026,
          valueUsd: 2.57049,
          entryPrice: 2084.22,
          currentPrice: null,
          pnlPercent: null,
          weight: 31.4,
          protocol: 'hyperliquid',
          positionType: 'long_perp',
          marginUsedUsd: 2.57049,
          notionalUsd: 51.4098,
          unrealizedPnlUsd: -2.77992,
          leverage: 20,
          liquidationPrice: 1696.3270408163,
          displayValueUsd: 2.57049,
          displayPnlPercent: null,
          displayWeight: 31.4,
          warnings: ['Current price is unavailable.'],
          valuationStatus: 'value_only',
        },
      ],
    });

    render(<PositionsTab botId="bot-1" status="active" operatorApiUrl="/operator-api" operatorKind="cloud" />);

    expect(screen.getByText('Equity')).toBeInTheDocument();
    expect(screen.getAllByText('Margin').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('columnheader', { name: 'Market' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Notional' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Margin' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Weight' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Price' })).not.toBeInTheDocument();
    expect(screen.getByText('ETH Perp')).toBeInTheDocument();
    expect(screen.getByText('Long')).toBeInTheDocument();
    expect(screen.getByText('0.026 ETH')).toBeInTheDocument();
    expect(screen.getByText('$51.41')).toBeInTheDocument();
    expect(screen.getAllByText('$2.57').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('31.4%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('20x')).toBeInTheDocument();
    expect(screen.getByText('-$2.78')).toBeInTheDocument();
    expect(screen.getByText('$1,696.33')).toBeInTheDocument();
    expect(screen.queryByText('Wrapped Ether')).not.toBeInTheDocument();
    expect(screen.queryByText('Value only')).not.toBeInTheDocument();
  });

  it('renders Hyperliquid exposure cards in workspace mode instead of the wide perp table', () => {
    mockPortfolio = makePortfolio({
      totalValueUsd: 26842.55,
      cashBalance: 21940.2,
      displayTotalValueUsd: 26842.55,
      displayCashBalance: 21940.2,
      hasValueOnlyPositions: true,
      positions: [
        {
          asset: resolveAssetDisplay('ETH'),
          token: 'ETH',
          symbol: 'ETH',
          amount: 1.42,
          valueUsd: 4986.64,
          entryPrice: 3510,
          currentPrice: 3521,
          pnlPercent: null,
          weight: 18.6,
          protocol: 'hyperliquid',
          positionType: 'long_perp',
          marginUsedUsd: 4986.64,
          notionalUsd: 99732.8,
          unrealizedPnlUsd: 31.24,
          leverage: 20,
          liquidationPrice: 3100,
          displayValueUsd: 4986.64,
          displayPnlPercent: null,
          displayWeight: 18.6,
          warnings: [],
          valuationStatus: 'priced',
        },
      ],
    });

    render(
      <PositionsTab
        botId="bot-1"
        status="active"
        operatorApiUrl="/operator-api"
        operatorKind="cloud"
        workspace
      />,
    );

    expect(screen.getByText('ETH Perp')).toBeInTheDocument();
    expect(screen.getByText('Hyperliquid · Long')).toBeInTheDocument();
    expect(screen.getByText('1.42 ETH')).toBeInTheDocument();
    expect(screen.getByText('$99,732.8')).toBeInTheDocument();
    expect(screen.getByText('$31.24')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Liquidation' })).not.toBeInTheDocument();
  });

  it('renders an account terminal strip and side pill in ledger workspace mode', () => {
    mockPortfolio = makePortfolio({
      totalValueUsd: 26842.55,
      cashBalance: 21940.2,
      displayTotalValueUsd: 26842.55,
      displayCashBalance: 21940.2,
      positions: [
        {
          asset: resolveAssetDisplay('ETH'),
          token: 'ETH',
          symbol: 'ETH',
          amount: 1.42,
          valueUsd: 4986.64,
          entryPrice: 3510,
          currentPrice: 3521,
          pnlPercent: null,
          weight: 18.6,
          protocol: 'hyperliquid',
          positionType: 'long_perp',
          marginUsedUsd: 498.66,
          notionalUsd: 4986.64,
          unrealizedPnlUsd: 104.39,
          leverage: 10,
          liquidationPrice: 3182.4,
          displayValueUsd: 4986.64,
          displayPnlPercent: null,
          displayWeight: 18.6,
          warnings: [],
          valuationStatus: 'priced',
        },
      ],
    });

    render(
      <PositionsTab
        botId="bot-1"
        status="active"
        operatorApiUrl="/operator-api"
        operatorKind="cloud"
        workspace
        workspaceLayout="ledger"
      />,
    );

    expect(screen.getByText('Equity')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getAllByText('Notional').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('uPNL')).toBeInTheDocument();
    expect(screen.getByText('$26,842.55')).toBeInTheDocument();
    expect(screen.getByText('$21,940.2')).toBeInTheDocument();
    expect(screen.getAllByText('$4,986.64').length).toBeGreaterThanOrEqual(2);
    screen.getAllByText('$104.39').forEach((node) => {
      expect(node).toHaveClass('text-[#50d2c1]');
    });
    expect(screen.getByText('Long')).toHaveClass('text-[#50d2c1]');
  });
});
