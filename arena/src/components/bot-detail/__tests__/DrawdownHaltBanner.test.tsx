import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '~/lib/types/bot';
import { DrawdownHaltBanner } from '../DrawdownHaltBanner';

const useBotMetricsMock = vi.hoisted(() => vi.fn());
const acknowledgeState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null as Error | null,
}));

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotMetrics: useBotMetricsMock,
  useAcknowledgeDrawdown: () => acknowledgeState,
}));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'ETH Macro Scalper',
    operatorAddress: '0x1111111111111111111111111111111111111111',
    vaultAddress: '0x2222222222222222222222222222222222222222',
    strategyType: 'dex',
    status: 'active',
    createdAt: Date.now(),
    pnlPercent: -6.2,
    pnlAbsolute: -620,
    sharpeRatio: 0,
    maxDrawdown: 6.2,
    winRate: 40,
    totalTrades: 12,
    tvl: 9_380,
    avgValidatorScore: 80,
    sparklineData: [],
    verificationState: 'authoritative',
    operatorApiUrl: 'https://operator.test',
    riskParams: { max_drawdown_pct: 4 },
    ...overrides,
  } as Bot;
}

function setLatestDrawdown(drawdownPct: number | null) {
  useBotMetricsMock.mockReturnValue({
    data: drawdownPct == null
      ? []
      : [{
          timestamp: new Date().toISOString(),
          bot_id: 'bot-1',
          account_value_usd: 9_380,
          unrealized_pnl: 0,
          realized_pnl: -620,
          high_water_mark: 10_000,
          drawdown_pct: drawdownPct,
          positions_count: 1,
          trade_count: 12,
        }],
    isLoading: false,
  });
}

describe('DrawdownHaltBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeState.isPending = false;
    acknowledgeState.isSuccess = false;
    acknowledgeState.isError = false;
    acknowledgeState.error = null;
  });

  it('shows the halted state with drawdown vs mandate for the creator', () => {
    setLatestDrawdown(6.2);
    render(<DrawdownHaltBanner bot={makeBot()} canCommand />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Trading halted');
    expect(alert).toHaveTextContent('6.2%');
    expect(alert).toHaveTextContent('4.0%');
    expect(screen.getByRole('button', { name: /acknowledge & resume/i })).toBeInTheDocument();
  });

  it('requires explicit confirmation before re-arming', async () => {
    setLatestDrawdown(6.2);
    const user = userEvent.setup();
    render(<DrawdownHaltBanner bot={makeBot()} canCommand />);

    await user.click(screen.getByRole('button', { name: /acknowledge & resume/i }));
    expect(screen.getByText(/new baseline/i)).toBeInTheDocument();
    expect(acknowledgeState.mutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /accept 6\.2% loss & re-arm/i }));
    expect(acknowledgeState.mutate).toHaveBeenCalledTimes(1);
  });

  it('shows the halted state without a resume action for non-creators', () => {
    setLatestDrawdown(6.2);
    render(<DrawdownHaltBanner bot={makeBot()} canCommand={false} />);

    expect(screen.getByRole('alert')).toHaveTextContent('agent creator');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing while the breaker is not tripped', () => {
    setLatestDrawdown(1.3);
    const { container } = render(<DrawdownHaltBanner bot={makeBot()} canCommand />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the bot has no drawdown mandate', () => {
    setLatestDrawdown(6.2);
    const { container } = render(
      <DrawdownHaltBanner bot={makeBot({ riskParams: {} })} canCommand />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces acknowledge failures in the banner', () => {
    setLatestDrawdown(6.2);
    acknowledgeState.isError = true;
    acknowledgeState.error = new Error('Caller is not permitted');
    render(<DrawdownHaltBanner bot={makeBot()} canCommand />);

    expect(screen.getByRole('status')).toHaveTextContent('Caller is not permitted');
  });
});
