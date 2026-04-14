import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ControlsTab } from '../ControlsTab';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../shared/ValidatorComponents', () => ({
  ScoreRing: ({ score }: { score: number }) => <span>{score}</span>,
}));

const trades: Trade[] = [];
let avgValidatorScore: number | null = 88;

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: {
      id: 'bot-1',
      operator_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      submitter_address: '0x2222222222222222222222222222222222222222',
      vault_address: '0x0000000000000000000000000000000000000000',
      strategy_type: 'dex',
      strategy_config: {},
      risk_params: {},
      chain_id: 31338,
      trading_active: true,
      paper_trade: true,
      created_at: 1712125717,
      max_lifetime_days: 30,
      trading_api_url: 'http://localhost:9101',
      trading_api_token: 'token',
      sandbox_id: 'sandbox-1',
      workflow_id: '177571563657601274',
      secrets_configured: true,
      sandbox_exists: true,
      sandbox_state: 'Running',
      lifecycle_status: 'active',
      archived: false,
      control_available: true,
      wind_down_started_at: null,
      validator_service_ids: [],
      validator_endpoints: [],
      call_id: 1,
      service_id: 1,
    },
    isLoading: false,
  }),
}));

vi.mock('~/lib/hooks/useBotControl', () => ({
  useBotControl: () => ({
    startBot: { mutate: vi.fn(), isPending: false, error: null },
    stopBot: { mutate: vi.fn(), isPending: false, error: null },
    runNow: { mutate: vi.fn(), isPending: false, error: null, isSuccess: false },
    updateConfig: { mutate: vi.fn(), isPending: false, error: null },
    isAuthenticated: true,
    authenticate: vi.fn(),
  }),
}));

vi.mock('~/lib/hooks/useBotApi', () => ({
  useBotTrades: () => ({ data: trades }),
}));

vi.mock('~/lib/hooks/useBotLiveSummary', () => ({
  useBotLiveSummary: () => ({
    pnlPercent: 1.7,
    pnlAbsolute: 167.04,
    sharpeRatio: 1.23,
    maxDrawdown: 2.4,
    winRate: null,
    portfolioValue: 10167.04,
    avgValidatorScore,
    isLoading: false,
  }),
}));

vi.mock('~/lib/hooks/useServiceInfo', () => ({
  useServiceInfo: () => ({ service: null, remainingSeconds: null }),
}));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'dex Agent',
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
    sparklineData: [],
    verificationState: 'authoritative',
    operatorKind: 'cloud',
    operatorApiUrl: 'http://localhost:9201',
    ...overrides,
  };
}

describe('ControlsTab', () => {
  it('renders the live average validator score instead of the stale bot field', () => {
    avgValidatorScore = 88;
    trades.splice(0, trades.length);
    render(<ControlsTab bot={makeBot()} />);

    expect(screen.getByText('Avg Score')).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
  });

  it('shows a dash when no live average validator score is available', () => {
    avgValidatorScore = null;
    render(<ControlsTab bot={makeBot()} />);

    expect(screen.getByText('Avg Score')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the exact workflow id string without numeric rounding', () => {
    avgValidatorScore = 88;
    render(<ControlsTab bot={makeBot()} />);

    expect(screen.getByText('177571563657601274')).toBeInTheDocument();
  });
});
