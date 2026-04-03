import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BotHeader } from '../BotHeader';
import type { Bot } from '~/lib/types/bot';

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('~/lib/hooks/useBotDetail', () => ({
  useBotDetail: () => ({
    data: {
      validator_endpoints: ['https://validator.example'],
    },
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
  it('renders live runtime values instead of stale bot summary values', () => {
    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByText('+1.7%')).toBeInTheDocument();
    expect(screen.getByText('1.23')).toBeInTheDocument();
    expect(screen.getByText('2.4%')).toBeInTheDocument();
    expect(screen.getByText('$10.2K')).toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Value')).toBeInTheDocument();
  });

  it('shows a dash for unsupported metrics instead of fake zeroes', () => {
    render(<BotHeader bot={makeBot()} />);

    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
