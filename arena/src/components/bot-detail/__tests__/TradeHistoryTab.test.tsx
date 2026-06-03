import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '~/test/mockBlueprintUi';
import '~/test/mockFramerMotion';
import { TradeHistoryTab } from '../TradeHistoryTab';
import type { Trade } from '~/lib/types/trade';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';

// ── Hook mocks ────────────────────────────────────────────────────────

const mockTrades: Trade[] = [];
let mockTradeTotal: number | null = null;
let mockTradesIsError = false;
let mockTradesError: unknown = null;

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotTrades: () => ({
    data: mockTrades,
    isLoading: false,
    isError: mockTradesIsError,
    error: mockTradesError,
  }),
  useBotTradePage: (_botId: string, _botName: string, limit = 50, options: { offset?: number } = {}) => ({
    data: {
      trades: mockTrades,
      total: mockTradeTotal,
      loaded: mockTrades.length,
      limit,
      offset: options.offset ?? 0,
      hasTotal: mockTradeTotal != null,
      isCapped: mockTradeTotal != null ? (options.offset ?? 0) + mockTrades.length < mockTradeTotal : false,
      legacyArray: mockTradeTotal == null,
    },
    isLoading: false,
    isError: mockTradesIsError,
    error: mockTradesError,
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

function setTrades(trades: Trade[]) {
  mockTrades.length = 0;
  mockTrades.push(...trades);
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const trade = {
    id: 'trade-1',
    botId: 'bot-1',
    botName: 'Test Bot',
    action: 'buy',
    tokenIn: 'USDC',
    tokenOut: 'WETH',
    amountIn: 1000,
    amountOut: 0.5,
    priceUsd: 2000,
    timestamp: Date.now(),
    status: 'executed',
    venue: 'dex',
    ...overrides,
  };

  return {
    ...trade,
    assetIn: overrides.assetIn ?? resolveAssetDisplay(trade.rawTokenIn ?? trade.tokenIn),
    assetOut: overrides.assetOut ?? resolveAssetDisplay(trade.rawTokenOut ?? trade.tokenOut),
  } as Trade;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TradeHistoryTab', () => {
  beforeEach(() => {
    setTrades([]);
    mockTradeTotal = null;
    mockTradesIsError = false;
    mockTradesError = null;
  });

  it('renders empty state when no trades', () => {
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('No executions recorded for this agent.')).toBeInTheDocument();
  });

  it('shows an unavailable state when trade history fails to load', () => {
    mockTradesIsError = true;
    mockTradesError = new Error('operator request failed');

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('Trade history unavailable')).toBeInTheDocument();
    expect(screen.getByText('operator request failed')).toBeInTheDocument();
    expect(screen.queryByText('No executions recorded for this agent.')).not.toBeInTheDocument();
  });

  it('renders trade rows with correct data', () => {
    setTrades([
      makeTrade({
        id: 'trade-1',
        action: 'buy',
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        status: 'executed',
      }),
    ]);
    const { container } = render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('USDC/WETH')).toBeInTheDocument();
    expect(container.querySelector('img[src="/token-icons/usdc.svg"]')).toBeInTheDocument();
    expect(container.querySelector('img[src="/token-icons/weth.svg"]')).toBeInTheDocument();
    expect(screen.getByText('executed')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
    expect(screen.getAllByText('USDC').length).toBeGreaterThan(0);
    expect(screen.queryByText('Price')).not.toBeInTheDocument();
    expect(screen.queryByText('$2,000')).not.toBeInTheDocument();
  });

  it('paginates loaded rows against the trade ledger total when available', () => {
    setTrades([
      makeTrade({ id: 'trade-1' }),
      makeTrade({ id: 'trade-2', action: 'sell' }),
    ]);
    mockTradeTotal = 12;

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('1-2 / 12')).toBeInTheDocument();
  });

  it('shows a page range for legacy array responses without loaded copy', () => {
    setTrades([
      makeTrade({ id: 'trade-1' }),
      makeTrade({ id: 'trade-2', action: 'sell' }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('1-2')).toBeInTheDocument();
    expect(screen.queryByText(/loaded/i)).not.toBeInTheDocument();
  });

  it('keeps read-only trades visible when operator verification is pending', () => {
    setTrades([
      makeTrade({
        id: 'trade-1',
        action: 'buy',
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        status: 'executed',
      }),
    ]);

    render(
      <TradeHistoryTab
        botId="bot-1"
        botName="Test Bot"
        verificationState="unverified"
      />,
    );

    expect(screen.getByText('Operator verification pending')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('USDC/WETH')).toBeInTheDocument();
  });

  it('does not show simulation in the compact table', () => {
    setTrades([
      makeTrade({
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xabc',
          responses: [],
          simulation: {
            success: true,
            gasUsed: 21000,
            riskScore: 25,
            warnings: [],
            outputAmount: '500',
          },
        },
      }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    expect(screen.queryByText('Sim')).not.toBeInTheDocument();
    expect(screen.queryByText('25')).not.toBeInTheDocument();
  });

  it('shows dash when no simulation data', () => {
    setTrades([makeTrade()]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('expands row on click to show validator details', async () => {
    const user = userEvent.setup();
    setTrades([
      makeTrade({
        validatorScore: 85,
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xabcdef1234567890abcdef1234567890',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 85,
              reasoning: 'Solid trade rationale',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
        },
      }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    // Click the row to expand (row is clickable because hasValidation is true)
    const row = screen.getByText('BUY').closest('tr')!;
    await user.click(row);

    // Expanded view shows the APPROVED badge and validator details
    expect(screen.getAllByText('APPROVED').length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByText('0x1234...5678').closest('button')!);
    expect(screen.getAllByText('Solid trade rationale').length).toBeGreaterThan(0);
  });

  it('collapses an expanded trade when the expanded body is clicked', async () => {
    const user = userEvent.setup();
    setTrades([
      makeTrade({
        validatorScore: 85,
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xabcdef1234567890abcdef1234567890',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 85,
              reasoning: 'Solid trade rationale',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
        },
      }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    const row = screen.getByText('BUY').closest('tr')!;
    await user.click(row);
    expect(screen.getByText('Notional')).toBeInTheDocument();

    await user.click(screen.getByText('Route').closest('div')!);
    expect(screen.queryByText('Notional')).not.toBeInTheDocument();
  });

  it('expands trades without validator data to show the agent reason', async () => {
    const user = userEvent.setup();
    setTrades([
      makeTrade({
        validatorScore: undefined,
        validation: undefined,
        agentReasoning: 'No validator detail, but the agent reason is present.',
      }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    const row = screen.getByText('BUY').closest('tr')!;
    await user.click(row);

    expect(screen.queryByRole('complementary', { name: /decision inspector/i })).not.toBeInTheDocument();
    expect(screen.getAllByText('No validator detail, but the agent reason is present.').length).toBeGreaterThan(0);
  });

  it('renders contradictory historical paper approvals as unsigned instead of approved', async () => {
    const user = userEvent.setup();
    setTrades([
      makeTrade({
        paperTrade: true,
        status: 'paper',
        venue: 'paper',
        validatorScore: 85,
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xunsigned',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 90,
              reasoning: 'Score passed; signature error: invalid vault_address',
              signature: '0x' + '00'.repeat(65),
            },
            {
              validator: '0xabcdef1234567890abcdef1234567890abcdef12',
              score: 80,
              reasoning: 'Score passed; signature error: invalid vault_address',
              signature: '0x' + '00'.repeat(65),
            },
          ],
        },
      }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    const row = screen.getByText('BUY').closest('tr')!;
    await user.click(row);

    expect(screen.getAllByText('UNSIGNED').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText('Validator scoring passed, but no usable signatures were produced.'),
    ).toBeInTheDocument();
  });

  it('shows simulation detail in expanded view', async () => {
    const user = userEvent.setup();
    setTrades([
      makeTrade({
        validatorScore: 70,
        validation: {
          approved: true,
          aggregateScore: 70,
          intentHash: '0xabc',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 70,
              reasoning: 'OK trade',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
          simulation: {
            success: true,
            gasUsed: 150000,
            riskScore: 20,
            warnings: ['SlippageHigh'],
            outputAmount: '1000',
          },
        },
      }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    // Expand
    const row = screen.getByText('BUY').closest('tr')!;
    await user.click(row);

    // SimulationDetail renders PASS and the warning
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getByText('SlippageHigh')).toBeInTheDocument();
  });

  it('renders multiple trades', () => {
    setTrades([
      makeTrade({ id: 'trade-1', action: 'buy', tokenOut: 'WETH' }),
      makeTrade({ id: 'trade-2', action: 'sell', tokenOut: 'USDC' }),
    ]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('SELL')).toBeInTheDocument();
  });

  it('keeps the compact executions ledger and action column square', () => {
    setTrades([
      makeTrade({ id: 'trade-1', action: 'buy', tokenOut: 'WETH' }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" compact />);

    expect(screen.getByRole('table').parentElement).not.toHaveClass('rounded-[5px]');
    expect(screen.getByText('BUY')).toHaveClass('rounded-none');
    expect(screen.getByText('BUY')).not.toHaveClass('rounded-[3px]');
  });

  it('shows the input-side amount in the compact row', () => {
    setTrades([
      makeTrade({
        action: 'buy',
        tokenIn: 'WETH',
        tokenOut: 'USDC',
        amountIn: 1.25,
        amountOut: 3200,
        priceUsd: 2560,
        paperTrade: true,
        status: 'paper',
        venue: 'paper',
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('1.25')).toBeInTheDocument();
    expect(screen.getAllByText('WETH').length).toBeGreaterThan(0);
    expect(screen.queryByText('$2,560')).not.toBeInTheDocument();
    expect(screen.queryByText('3,200 USDC')).not.toBeInTheDocument();
  });

  it('renders prediction trades with a human-readable market label in the compact row', () => {
    const pairLabel = 'Will ETH be above $4,000 on June 30? - YES';

    setTrades([
      makeTrade({
        tokenIn: 'USDC',
        tokenOut: '48328953829',
        targetProtocol: 'polymarket_clob',
        venue: 'clob',
        predictionMetadata: {
          marketQuestion: 'Will ETH be above $4,000 on June 30?',
          outcomeLabel: 'YES',
        },
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText(pairLabel)).toBeInTheDocument();
    expect(screen.getByTitle(pairLabel)).toBeInTheDocument();
    expect(screen.queryByText('USDC/48328953829')).not.toBeInTheDocument();
  });

  it('does not show requested execution price in the compact prediction row', () => {
    setTrades([
      makeTrade({
        tokenIn: 'USDC',
        tokenOut: '48328953829',
        targetProtocol: 'polymarket_clob',
        venue: 'paper',
        paperTrade: true,
        status: 'paper',
        priceUsd: null,
        execution: {
          status: 'paper',
          requestedPriceUsd: 0.585,
        },
        predictionMetadata: {
          marketQuestion: 'Will ETH be above $4,000 on June 30?',
          outcomeLabel: 'YES',
        },
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.queryByText('$0.585')).not.toBeInTheDocument();
    expect(screen.queryByText('No USD leg')).not.toBeInTheDocument();
  });

  it('surfaces failed paper simulations in the compact status column', () => {
    setTrades([
      makeTrade({
        action: 'buy',
        tokenIn: 'DAI',
        tokenOut: 'WETH',
        amountIn: 2500,
        amountOut: 0.8,
        priceUsd: 3125,
        paperTrade: true,
        status: 'failed',
        venue: 'paper',
        validation: {
          approved: true,
          aggregateScore: 64,
          intentHash: '0xabc',
          responses: [],
          simulation: {
            success: false,
            gasUsed: 99000,
            riskScore: 55,
            warnings: ['slippage estimate high'],
            outputAmount: '0.8',
          },
        },
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('sim failed')).toBeInTheDocument();
    expect(screen.queryByText('$3,125')).not.toBeInTheDocument();
  });

  it('does not show paper-trade price fallback in the compact row', () => {
    setTrades([
      makeTrade({
        tokenIn: 'WETH',
        tokenOut: 'WBTC',
        amountIn: 2,
        amountOut: 0.05,
        priceUsd: null,
        paperTrade: true,
        status: 'paper',
        venue: 'paper',
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.queryByText('No USD leg')).not.toBeInTheDocument();
  });

  it('shows swap flow and tx hash directly in the compact table', () => {
    setTrades([
      makeTrade({
        action: 'swap',
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        amountIn: 1157,
        amountOut: 0.4975,
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('SWAP')).toBeInTheDocument();
    expect(screen.getByText('0.4975')).toBeInTheDocument();
    expect(screen.getByText('0x1234…cdef')).toBeInTheDocument();
  });

  it('does not show source filters or venue labels in the compact table', () => {
    setTrades([
      makeTrade({
        id: 'agent-trade',
        decisionSource: 'agent_execution',
      }),
      makeTrade({
        id: 'strategy-trade',
        tokenIn: 'DAI',
        tokenOut: 'WETH',
        decisionSource: 'code_strategy',
        strategyModuleId: 'template-momentum-breakout',
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('USDC/WETH')).toBeInTheDocument();
    expect(screen.getByText('DAI/WETH')).toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Venue')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Strategy Code')).not.toBeInTheDocument();
  });

  it('renders Hyperliquid perp rows as perp orders instead of swaps', () => {
    setTrades([
      makeTrade({
        action: 'open_long',
        tokenIn: 'USDC',
        tokenOut: 'USDC',
        amountIn: 10.934753,
        amountOut: 0,
        priceUsd: 0.999687,
        notionalUsd: 10.931330422311,
        targetProtocol: 'hyperliquid',
        venue: 'perp',
        txHash: 'hl:ok',
        validation: {
          approved: true,
          aggregateScore: 80,
          intentHash: '0xhl',
          responses: [],
        },
        hyperliquidMetadata: {
          asset: 'ETH',
          assetSize: '0.0052',
          orderType: 'market',
          reduceOnly: false,
        },
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('LONG')).toBeInTheDocument();
    expect(screen.getByText('ETH-PERP')).toBeInTheDocument();
    expect(screen.getByText('HL accepted')).toBeInTheDocument();
    expect(screen.getByText('10.9348 USDC')).toBeInTheDocument();
    expect(screen.getAllByText('0.0052 ETH').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('USDC/USDC')).not.toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Collateral:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Notional:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Tx Hash')).not.toBeInTheDocument();
    expect(screen.queryByText('Venue')).not.toBeInTheDocument();
    expect(screen.queryByText('Sim')).not.toBeInTheDocument();
    expect(screen.queryByText('Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Perp order')).not.toBeInTheDocument();
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
  });

  it('uses an honest fallback label for historical Hyperliquid rows without asset metadata', () => {
    setTrades([
      makeTrade({
        action: 'open_long',
        tokenIn: 'USDC',
        tokenOut: 'USDC',
        amountIn: 11,
        amountOut: 0,
        targetProtocol: 'hyperliquid',
        venue: 'perp',
        txHash: 'hl:err',
      }),
    ]);

    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('LONG')).toBeInTheDocument();
    expect(screen.getByText('HL rejected')).toBeInTheDocument();
    expect(screen.getByText('11 USDC')).toBeInTheDocument();
    expect(screen.queryByText('Hyperliquid perp')).not.toBeInTheDocument();
    expect(screen.queryByText('Perp order')).not.toBeInTheDocument();
    expect(screen.queryByText(/Collateral:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Notional:/)).not.toBeInTheDocument();
    expect(screen.queryByText('USDC/USDC')).not.toBeInTheDocument();
  });
});
