import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BotHeader } from '../BotHeader';
import type { Bot } from '~/lib/types/bot';

let mockDetail: Record<string, unknown> = {
  validator_endpoints: ['https://validator.example'],
};

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: mockDetail,
  }),
}));

const liveSummary = {
  pnlPercent: 1.7,
  pnlAbsolute: 167.04,
  sharpeRatio: 1.23,
  maxDrawdown: 2.4,
  winRate: null,
  portfolioValue: 10167.04,
  avgValidatorScore: 92,
  isLoading: false,
};

vi.mock('~/lib/hooks/useBotLiveSummary', () => ({
  useBotLiveSummary: () => liveSummary,
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

describe('BotHeader', () => {
  it('shows a human strategy label instead of the fabricated strategy-agent fallback', () => {
    mockDetail = { validator_endpoints: ['https://validator.example'] };

    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByRole('heading', { name: 'DEX Spot Trading' })).toBeInTheDocument();
  });

  it('renders live runtime values instead of stale bot summary values', () => {
    mockDetail = { validator_endpoints: ['https://validator.example'] };
    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByText('+1.7%')).toBeInTheDocument();
    expect(screen.getByText('1.23')).toBeInTheDocument();
    expect(screen.getByText('2.4%')).toBeInTheDocument();
    expect(screen.getByText('$10.2K')).toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('30D Return %')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Value')).toBeInTheDocument();
    expect(screen.queryByText('PnL')).not.toBeInTheDocument();
  });

  it('shows a dash for unsupported metrics instead of fake zeroes', () => {
    mockDetail = { validator_endpoints: ['https://validator.example'] };
    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('exposes metric explanations through info buttons', () => {
    mockDetail = { validator_endpoints: ['https://validator.example'] };
    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByRole('button', { name: /About 30D Return %: Calculated/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /About Sharpe: Risk-adjusted return/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /About Max DD: Maximum drawdown/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /About Win Rate: Estimated win rate/i })).toBeInTheDocument();
  });

  it('prefers the authoritative detail name when available', () => {
    mockDetail = {
      validator_endpoints: ['https://validator.example'],
      name: 'Base Sepolia Rollout Plan',
      strategy_type: 'dex',
    };

    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByRole('heading', { name: 'Base Sepolia Rollout Plan' })).toBeInTheDocument();
  });

  it('separates strategy identity from execution metadata', () => {
    mockDetail = {
      validator_endpoints: ['https://validator.example'],
      name: 'MM ETH/USDC Aerodrome (Base mainnet) - band 3% target 0.5 (active)',
      strategy_type: 'dex',
    };

    render(<BotHeader bot={makeBot({
      chainId: 1,
      paperTrade: true,
      strategyConfig: {
        protocol_chain_id: 8453,
        initial_capital_usd: 10_000,
        protocol: 'aerodrome',
      },
      riskParams: {
        max_drawdown_pct: 10,
      },
    })} />);

    expect(screen.getByRole('heading', { name: 'Market-making bot: ETH/USDC on Aerodrome' })).toBeInTheDocument();
    expect(screen.getByText('Base mainnet')).toBeInTheDocument();
    expect(screen.getByText('band 3% target 0.5')).toBeInTheDocument();
    expect(screen.getByText('Network: Base')).toBeInTheDocument();
    expect(screen.getByText('Capital: $10,000')).toBeInTheDocument();
    expect(screen.getByText('Max DD: 10%')).toBeInTheDocument();
  });

  it('links to the vault with the bot chain id', () => {
    mockDetail = { validator_endpoints: ['https://validator.example'] };
    const vaultAddress = '0x1111111111111111111111111111111111111111';

    render(<BotHeader bot={makeBot({ vaultAddress, chainId: 84532 })} />);

    expect(screen.getByRole('link', { name: /View Vault/i })).toHaveAttribute(
      'href',
      `/vault/${vaultAddress}?chainId=84532`,
    );
  });
});
