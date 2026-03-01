import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TradeHistoryTab } from '../TradeHistoryTab';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';
import type { Trade } from '~/lib/types/trade';

mockBlueprintUi();
mockFramerMotion();

// ── Hook mocks ────────────────────────────────────────────────────────

const mockTrades: Trade[] = [];

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotTrades: () => ({ data: mockTrades, isLoading: false }),
}));

function setTrades(trades: Trade[]) {
  mockTrades.length = 0;
  mockTrades.push(...trades);
}

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

describe('TradeHistoryTab', () => {
  beforeEach(() => {
    setTrades([]);
  });

  it('renders empty state when no trades', () => {
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('No trades recorded for this bot.')).toBeInTheDocument();
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
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('USDC/WETH')).toBeInTheDocument();
    expect(screen.getByText('executed')).toBeInTheDocument();
  });

  it('shows simulation badge when simulation data present', () => {
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
    // SimulationBadge renders the risk score
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('shows dash when no simulation data', () => {
    setTrades([makeTrade()]);
    render(<TradeHistoryTab botId="bot-1" botName="Test Bot" />);
    // Both the validation column and sim column show '-' when empty
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

    // Expanded view shows the APPROVED badge and intent hash
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
    expect(screen.getByText('Intent Hash')).toBeInTheDocument();
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
});
