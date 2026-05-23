import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsTab } from '../SecretsTab';
import type { Bot } from '~/lib/types/bot';

const mocks = vi.hoisted(() => ({
  walletAddress: undefined as string | undefined,
  operatorAccountAddress: '0x1111111111111111111111111111111111111111' as string | null,
  detail: {
    id: 'bot-1',
    operator_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    submitter_address: '0x1111111111111111111111111111111111111111',
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
    secrets_configured: false,
    sandbox_exists: true,
    sandbox_state: 'Running',
    lifecycle_status: 'awaiting_secrets',
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
  useAccount: () => ({ address: mocks.walletAddress }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    accountAddress: mocks.operatorAccountAddress,
    token: 'token',
    isAuthenticated: true,
    isAuthenticating: false,
    authCacheKey: 'auth-key',
    authenticate: vi.fn(),
    clearCachedToken: vi.fn(),
    error: null,
    getCachedToken: () => 'token',
    getToken: () => Promise.resolve('token'),
  }),
}));

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: mocks.detail,
    isLoading: false,
  }),
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

function renderSecretsTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SecretsTab bot={makeBot()} />
    </QueryClientProvider>,
  );
}

describe('SecretsTab', () => {
  beforeEach(() => {
    mocks.walletAddress = undefined;
    mocks.operatorAccountAddress = '0x1111111111111111111111111111111111111111';
    mocks.detail.submitter_address = '0x1111111111111111111111111111111111111111';
  });

  it('allows secrets management when the operator auth session owns the bot without a connected wallet', () => {
    renderSecretsTab();

    expect(screen.queryByText('Owner only')).not.toBeInTheDocument();
    expect(screen.getByText('Runtime Secrets')).toBeInTheDocument();
  });

  it('keeps secrets owner-gated when neither wallet nor operator auth owns the bot', () => {
    mocks.operatorAccountAddress = '0x2222222222222222222222222222222222222222';

    renderSecretsTab();

    expect(screen.getByText('Owner only')).toBeInTheDocument();
  });
});
