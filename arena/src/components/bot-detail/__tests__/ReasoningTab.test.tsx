import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '~/test/mockBlueprintUi';
import '~/test/mockFramerMotion';
import { ReasoningTab } from '../ReasoningTab';
import type { Trade } from '~/lib/types/trade';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';

// ── Hook mocks ────────────────────────────────────────────────────────

let allTrades: Trade[] = [];
let recentTrades: Trade[] = [];
let isLoading = false;
let allTradesIsError = false;
let allTradesError: unknown = null;

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotTrades: () => ({
    data: allTrades,
    isLoading,
    isError: allTradesIsError,
    error: allTradesError,
  }),
  useBotRecentValidations: () => ({ data: recentTrades }),
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

describe('ReasoningTab', () => {
  beforeEach(() => {
    allTrades = [];
    recentTrades = [];
    isLoading = false;
    allTradesIsError = false;
    allTradesError = null;
  });

  it('renders loading state with skeleton cards', () => {
    isLoading = true;
    const { container } = render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    // Skeleton cards render as glass-card divs with animate-pulse children
    const skeletonCards = container.querySelectorAll('.glass-card');
    expect(skeletonCards.length).toBe(3);
  });

  it('renders empty state when no validated trades', () => {
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    expect(
      screen.getByText("No validation details available for this bot's trades."),
    ).toBeInTheDocument();
  });

  it('shows an unavailable state when validation history fails to load', () => {
    allTradesIsError = true;
    allTradesError = new Error('operator request failed');

    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('Validation details unavailable')).toBeInTheDocument();
    expect(screen.getByText('operator request failed')).toBeInTheDocument();
    expect(
      screen.queryByText("No validation details available for this bot's trades."),
    ).not.toBeInTheDocument();
  });

  it('renders historical trade with validation', () => {
    allTrades = [
      makeTrade({
        id: 'trade-1',
        validatorScore: 85,
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xabc',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 85,
              reasoning: 'Good trade',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
        },
      }),
    ];
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
  });

  it('keeps read-only validation history visible when operator verification is pending', () => {
    allTrades = [
      makeTrade({
        id: 'trade-1',
        validatorScore: 85,
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xabc',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 85,
              reasoning: 'Good trade',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
        },
      }),
    ];

    render(
      <ReasoningTab
        botId="bot-1"
        botName="Test Bot"
        verificationState="unverified"
      />,
    );

    expect(screen.getByText('Operator verification pending')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
  });

  it('renders explicit paper bypasses as bypassed with explanatory copy', () => {
    allTrades = [
      makeTrade({
        id: 'trade-bypass',
        paperTrade: true,
        status: 'paper',
        venue: 'paper',
        validatorScore: 100,
        validation: {
          approved: true,
          aggregateScore: 100,
          intentHash: '0xbypass',
          responses: [
            {
              validator: 'paper-mode',
              score: 100,
              reasoning: 'Paper trade mode — validation bypassed',
              signature: '0x' + '00'.repeat(65),
            },
          ],
        },
      }),
    ];
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);

    expect(screen.getByText('BYPASSED')).toBeInTheDocument();
    expect(
      screen.getByText('Paper mode bypassed validator signing because no validators were configured.'),
    ).toBeInTheDocument();
  });

  it('renders pending trade from recent validations', () => {
    recentTrades = [
      makeTrade({
        id: 'pending-1',
        status: 'pending',
        timestamp: Date.now(),
        validation: {
          approved: false,
          aggregateScore: 0,
          intentHash: '',
          responses: [],
        },
      }),
    ];
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('validating')).toBeInTheDocument();
  });

  it('shows simulation summary when present', () => {
    allTrades = [
      makeTrade({
        id: 'trade-sim',
        validatorScore: 70,
        validation: {
          approved: true,
          aggregateScore: 70,
          intentHash: '0xabc',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 70,
              reasoning: 'OK',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
          simulation: {
            success: true,
            gasUsed: 80000,
            riskScore: 35,
            warnings: ['PriceImpactHigh'],
            outputAmount: '1200',
          },
        },
      }),
    ];
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getByText('35')).toBeInTheDocument();
    expect(screen.getByText('PriceImpactHigh')).toBeInTheDocument();
  });

  it('shows divider between pending and history sections', () => {
    recentTrades = [
      makeTrade({
        id: 'pending-1',
        status: 'pending',
        timestamp: Date.now(),
        validation: {
          approved: false,
          aggregateScore: 0,
          intentHash: '',
          responses: [],
        },
      }),
    ];
    allTrades = [
      makeTrade({
        id: 'hist-1',
        status: 'executed',
        validatorReasoning: 'Old trade reasoning',
      }),
    ];
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('renders trade with reasoning but no validator responses', () => {
    allTrades = [
      makeTrade({
        id: 'trade-reasoning',
        validatorReasoning: 'This trade was evaluated using policy rules only.',
      }),
    ];
    render(<ReasoningTab botId="bot-1" botName="Test Bot" />);
    expect(
      screen.getByText('This trade was evaluated using policy rules only.'),
    ).toBeInTheDocument();
  });
});
