import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PortfolioWorkspace } from '../PortfolioWorkspace';

const hoisted = vi.hoisted(() => ({
  positionsProps: [] as any[],
  tradeHistoryProps: [] as any[],
}));

vi.mock('../PositionsTab', () => ({
  PositionsTab: (props: any) => {
    hoisted.positionsProps.push(props);
    return <div>positions rail</div>;
  },
}));

vi.mock('../TradeHistoryTab', () => ({
  TradeHistoryTab: (props: any) => {
    hoisted.tradeHistoryProps.push(props);
    return <div>execution ledger</div>;
  },
}));

describe('PortfolioWorkspace', () => {
  it('uses canonical ledgers inside the account terminal', () => {
    render(
      <PortfolioWorkspace
        botId="bot-1"
        botName="ETH Macro Scalper"
        status="active"
        isLive
        paperTrade
        chainId={84532}
        operatorApiUrl="/operator-api"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Positions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Executions' })).toBeInTheDocument();
    expect(screen.getByText('Paper')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Base Sepolia').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    expect(screen.getByText('positions rail')).toBeInTheDocument();
    expect(screen.getByText('execution ledger')).toBeInTheDocument();
    expect(hoisted.positionsProps.at(-1)).toEqual(expect.objectContaining({
      workspace: true,
      workspaceLayout: 'ledger',
    }));
    expect(hoisted.tradeHistoryProps.at(-1)).toEqual(expect.objectContaining({
      compact: true,
    }));
  });
});
