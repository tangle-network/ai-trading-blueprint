import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlsTab } from '../ControlsTab';
import type { Bot } from '~/lib/types/bot';
import type { Trade } from '~/lib/types/trade';

const mocks = vi.hoisted(() => ({
  writeContract: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  updateConfigMutate: vi.fn(),
  detail: {
    id: 'bot-1',
    operator_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    submitter_address: '0x2222222222222222222222222222222222222222',
    vault_address: '0x0000000000000000000000000000000000000000',
    strategy_type: 'dex',
    strategy_config: {
      runtime_backend: 'docker',
      paper_trade: true,
      asset_token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      initial_capital_usd: '10000',
    },
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
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  useWriteContract: () => ({ writeContract: mocks.writeContract, isPending: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn() },
}));

vi.mock('../shared/ValidatorComponents', () => ({
  ScoreRing: ({ score }: { score: number }) => <span>{score}</span>,
}));

const trades: Trade[] = [];
let avgValidatorScore: number | null = 88;

function makeAssetDisplay(symbol: string) {
  return {
    rawToken: symbol,
    symbol,
    name: symbol,
    primaryLabel: symbol,
    secondaryLabel: symbol,
    isKnown: true,
    accentClassName: '',
    iconText: symbol.slice(0, 3).toUpperCase(),
  };
}

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: mocks.detail,
    isLoading: false,
  }),
}));

vi.mock('~/lib/hooks/useBotControl', () => ({
  useBotControl: () => ({
    startBot: { mutate: vi.fn(), isPending: false, error: null },
    stopBot: { mutate: vi.fn(), isPending: false, error: null },
    runNow: { mutate: vi.fn(), isPending: false, error: null, isSuccess: false },
    updateConfig: { mutate: mocks.updateConfigMutate, isPending: false, error: null },
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
  beforeEach(() => {
    mocks.writeContract.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.updateConfigMutate.mockReset();
    mocks.detail.submitter_address = '0x1111111111111111111111111111111111111111';
    mocks.detail.paper_trade = true;
    mocks.detail.strategy_config = {
      runtime_backend: 'docker',
      paper_trade: true,
      asset_token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      initial_capital_usd: '10000',
    };
    mocks.detail.risk_params = {};
  });

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

  it('shows a success toast when bot lifetime extension is submitted', async () => {
    mocks.writeContract.mockImplementation((_config, callbacks) => {
      callbacks?.onSuccess?.('0x123');
    });
    const user = userEvent.setup();

    render(<ControlsTab bot={makeBot()} />);

    await user.click(screen.getByRole('button', { name: 'Extend' }));
    await user.click(screen.getByRole('button', { name: 'Submit Extension' }));

    expect(mocks.writeContract).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Bot lifetime extension submitted for 7 days.');
  });

  it('shows an error toast when bot lifetime extension submission fails', async () => {
    mocks.writeContract.mockImplementation((_config, callbacks) => {
      callbacks?.onError?.(new Error('wallet rejected'));
    });
    const user = userEvent.setup();

    render(<ControlsTab bot={makeBot()} />);

    await user.click(screen.getByRole('button', { name: 'Extend' }));
    await user.click(screen.getByRole('button', { name: 'Submit Extension' }));

    expect(mocks.writeContract).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith('Bot lifetime extension failed: wallet rejected');
  });

  it('saves paper trading and instruction changes without dropping provisioned settings', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<ControlsTab bot={makeBot()} />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Expert Knowledge'));
    await user.type(screen.getByLabelText('Expert Knowledge'), 'Focus on ETH momentum setups.');
    await user.clear(screen.getByLabelText('Custom Instructions'));
    await user.type(screen.getByLabelText('Custom Instructions'), 'Prefer liquid pairs only.');
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await user.click(screen.getByRole('checkbox', { name: 'Paper trading' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.updateConfigMutate).toHaveBeenCalledTimes(1);

    const [payload] = mocks.updateConfigMutate.mock.calls[0];
    expect(JSON.parse(payload.strategyConfigJson)).toEqual({
      runtime_backend: 'docker',
      paper_trade: false,
      asset_token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      initial_capital_usd: '10000',
      expert_knowledge_override: 'Focus on ETH momentum setups.',
      custom_instructions: 'Prefer liquid pairs only.',
    });
    expect(JSON.parse(payload.riskParamsJson)).toEqual({});

    confirmSpy.mockRestore();
  });

  it('excludes paper bypasses from approval rate and does not count unsigned approvals as approved', () => {
    avgValidatorScore = 88;
    trades.splice(0, trades.length);
    trades.push(
      {
        id: 'signed-trade',
        botId: 'bot-1',
        botName: 'Test Bot',
        action: 'buy',
        assetIn: makeAssetDisplay('USDC'),
        assetOut: makeAssetDisplay('WETH'),
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        amountIn: 1000,
        amountOut: 0.5,
        priceUsd: 2000,
        timestamp: Date.now(),
        status: 'paper',
        venue: 'paper',
        paperTrade: true,
        validation: {
          approved: true,
          aggregateScore: 90,
          intentHash: '0xsigned',
          responses: [
            {
              validator: '0x1234567890abcdef1234567890abcdef12345678',
              score: 90,
              reasoning: 'Looks good',
              signature: '0x' + 'ab'.repeat(65),
            },
          ],
        },
      },
      {
        id: 'bypass-trade',
        botId: 'bot-1',
        botName: 'Test Bot',
        action: 'buy',
        assetIn: makeAssetDisplay('USDC'),
        assetOut: makeAssetDisplay('WETH'),
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        amountIn: 1000,
        amountOut: 0.5,
        priceUsd: 2000,
        timestamp: Date.now(),
        status: 'paper',
        venue: 'paper',
        paperTrade: true,
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
      },
      {
        id: 'unsigned-trade',
        botId: 'bot-1',
        botName: 'Test Bot',
        action: 'buy',
        assetIn: makeAssetDisplay('USDC'),
        assetOut: makeAssetDisplay('WETH'),
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        amountIn: 1000,
        amountOut: 0.5,
        priceUsd: 2000,
        timestamp: Date.now(),
        status: 'paper',
        venue: 'paper',
        paperTrade: true,
        validation: {
          approved: true,
          aggregateScore: 85,
          intentHash: '0xunsigned',
          responses: [
            {
              validator: '0xabcdef1234567890abcdef1234567890abcdef12',
              score: 85,
              reasoning: 'Score passed; signature error: invalid vault_address',
              signature: '0x' + '00'.repeat(65),
            },
          ],
        },
      },
    );

    render(<ControlsTab bot={makeBot()} />);

    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('(2 trades)')).toBeInTheDocument();
  });
});
