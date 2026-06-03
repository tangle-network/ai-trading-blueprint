import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OperationsWorkspace } from '../OperationsWorkspace';
import type { Bot } from '~/lib/types/bot';

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));

vi.mock('../ReasoningTab', () => ({
  ReasoningTab: () => <div>validation panel loaded</div>,
}));

vi.mock('../RevisionArenaTab', () => ({
  RevisionArenaTab: () => <div>revisions panel loaded</div>,
}));

vi.mock('../ControlsTab', () => ({
  ControlsTab: () => <div>controls panel loaded</div>,
}));

vi.mock('../EnvelopeTab', () => ({
  EnvelopeTab: () => <div>envelope panel loaded</div>,
}));

vi.mock('../SecretsTab', () => ({
  SecretsTab: () => <div>secrets panel loaded</div>,
}));

vi.mock('../TerminalTab', () => ({
  TerminalTab: () => <div>terminal panel loaded</div>,
}));

vi.mock('../HyperliquidVaultTab', () => ({
  HyperliquidVaultTab: () => <div>vault panel loaded</div>,
}));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 42,
    name: 'ETH Macro Scalper',
    operatorAddress: '0x1111111111111111111111111111111111111111',
    vaultAddress: '0x2222222222222222222222222222222222222222',
    strategyType: 'hyperliquid_perp',
    status: 'active',
    createdAt: Date.parse('2026-06-01T12:00:00Z'),
    chainId: 84532,
    pnlPercent: 4.5,
    pnlAbsolute: 1129,
    sharpeRatio: 3.87,
    maxDrawdown: 2.5,
    winRate: 58,
    totalTrades: 12,
    tvl: 26_800,
    avgValidatorScore: 91,
    sparklineData: [],
    sandboxId: 'sandbox-1',
    sandboxState: 'Running',
    lifecycleStatus: 'active',
    controlAvailable: true,
    tradingActive: true,
    maxLifetimeDays: 30,
    secretsConfigured: false,
    submitterAddress: '0x3333333333333333333333333333333333333333',
    strategyConfig: { position_sizing: { fraction: 0.12 } },
    riskParams: { max_drawdown_pct: '5', stop_loss_pct: '1.8' },
    paperTrade: true,
    callId: 7,
    source: 'operator',
    verificationState: 'authoritative',
    operatorKind: 'cloud',
    operatorApiUrl: '/operator-api',
    lastVerifiedAt: Date.parse('2026-06-01T12:34:00Z'),
    validationTrust: 'envelope',
    ...overrides,
  };
}

describe('OperationsWorkspace', () => {
  it('opens on an operations overview instead of a lazy validation spinner', () => {
    render(
      <OperationsWorkspace
        bot={makeBot()}
        botName="ETH Macro Scalper"
        isLive
        hasTerminal
        isHyperliquidPerpBot
        canCommand
      />,
    );

    expect(screen.getByRole('heading', { name: 'Control Plane' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Command Runway' })).toBeInTheDocument();
    expect(screen.getByText('loop active')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Guardrails' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Runtime Stack' })).toBeInTheDocument();
    expect(screen.getByText('Record')).toBeInTheDocument();
    expect(screen.getAllByText('State').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Envelope').length).toBeGreaterThan(0);
    expect(screen.getByText('Needed')).toBeInTheDocument();
    expect(screen.getByText('Max DD')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('Position Cap')).toBeInTheDocument();
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.getByText('Stop Loss')).toBeInTheDocument();
    expect(screen.getByText('1.8%')).toBeInTheDocument();
    expect(screen.getAllByText('Runtime').length).toBeGreaterThan(0);
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Secrets Provider keys required/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Envelope Allowance policy/i })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Operations panels' })).toBeInTheDocument();
    expect(screen.queryByText('Loading Validation')).not.toBeInTheDocument();
  });

  it('lets overview action cards drill into existing operation panels', async () => {
    const user = userEvent.setup();
    render(
      <OperationsWorkspace
        bot={makeBot({ secretsConfigured: true })}
        botName="ETH Macro Scalper"
        isLive
        hasTerminal
        isHyperliquidPerpBot
        canCommand
      />,
    );

    await user.click(screen.getByRole('button', { name: /Validation Evidence/i }));

    expect(await screen.findByRole('heading', { name: 'Validation' })).toBeInTheDocument();
    expect(await screen.findByText('validation panel loaded')).toBeInTheDocument();
  });

  it('hides command-only operation panels for non-commandable viewers', () => {
    render(
      <OperationsWorkspace
        bot={makeBot({ secretsConfigured: false, validationTrust: 'envelope' })}
        botName="ETH Macro Scalper"
        isLive
        hasTerminal
        isHyperliquidPerpBot
      />,
    );

    expect(screen.getByRole('heading', { name: 'Control Plane' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Secrets Provider keys required/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Controls Risk and lifecycle/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Terminal Runtime logs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Envelope Allowance policy/i })).not.toBeInTheDocument();
  });
});
