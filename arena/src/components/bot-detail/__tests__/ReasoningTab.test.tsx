import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReasoningTab } from '../ReasoningTab';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';
import type { Trade } from '~/lib/types/trade';

mockBlueprintUi();
mockFramerMotion();

// ── Hook mocks ────────────────────────────────────────────────────────

let allTrades: Trade[] = [];
let recentTrades: Trade[] = [];
let isLoading = false;

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotTrades: () => ({ data: allTrades, isLoading }),
  useBotRecentValidations: () => ({ data: recentTrades }),
}));

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
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
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('ReasoningTab', () => {
  beforeEach(() => {
    allTrades = [];
    recentTrades = [];
    isLoading = false;
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
      screen.getByText("No validator reasoning available for this bot's trades."),
    ).toBeInTheDocument();
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
