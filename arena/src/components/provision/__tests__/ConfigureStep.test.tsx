import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigureStep } from '../ConfigureStep';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';

mockBlueprintUi();
mockFramerMotion();

vi.mock('~/lib/blueprints', () => ({
  strategyPacks: [
    {
      id: 'dex-swing',
      name: 'DEX Swing',
      description: 'Swing trading on DEXes',
      providers: ['Uniswap', 'Sushiswap'],
      cron: '0 */6 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'DEX momentum and mean-reversion setup.',
    },
    {
      id: 'defi-yield',
      name: 'DeFi Yield',
      description: 'Yield farming strategies',
      providers: ['Aave', 'Compound'],
      cron: '0 */8 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'DeFi yield and lending market optimization.',
    },
    {
      id: 'prediction-polymarket',
      name: 'Polymarket',
      description: 'Prediction market strategies',
      providers: ['Polymarket'],
      cron: '0 */6 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'Prediction market signal selection and execution.',
    },
  ],
}));

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    name: '',
    setName: vi.fn(),
    strategyType: 'dex-swing',
    setStrategyType: vi.fn(),
    selectedPack: {
      id: 'dex-swing',
      name: 'DEX Swing',
      description: 'Swing trading on DEXes',
      providers: ['Uniswap', 'Sushiswap'],
      cron: '0 */6 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'DEX momentum and mean-reversion setup.',
    },
    isInstance: false,
    serviceId: '1',
    serviceInfo: null,
    serviceLoading: false,
    serviceError: null,
    selectedOperators: new Set() as Set<`0x${string}`>,
    setShowAdvanced: vi.fn(),
    collateralCapPct: '',
    setCollateralCapPct: vi.fn(),
    canNext: false,
    goNext: vi.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('ConfigureStep', () => {
  it('renders agent name input', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Agent Name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Alpha DEX Bot')).toBeInTheDocument();
  });

  it('renders strategy packs grid', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('DEX Swing')).toBeInTheDocument();
    expect(screen.getByText('DeFi Yield')).toBeInTheDocument();
  });

  it('renders prediction market section separately', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Prediction Markets')).toBeInTheDocument();
    // "Polymarket" appears twice: as the pack name and in the providers list
    const polymarketElements = screen.getAllByText('Polymarket');
    expect(polymarketElements.length).toBeGreaterThanOrEqual(1);
  });

  it('disables next button when canNext is false', () => {
    render(<ConfigureStep {...defaultProps({ canNext: false })} />);
    const nextBtn = screen.getByText('Next: Provision Agent');
    expect(nextBtn).toBeDisabled();
  });

  it('enables next button when canNext is true', () => {
    render(<ConfigureStep {...defaultProps({ canNext: true })} />);
    const nextBtn = screen.getByText('Next: Provision Agent');
    expect(nextBtn).not.toBeDisabled();
  });

  it('calls goNext when next button clicked', async () => {
    const goNext = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ canNext: true, goNext })} />);
    await user.click(screen.getByText('Next: Provision Agent'));
    expect(goNext).toHaveBeenCalledOnce();
  });

  it('calls setName on input change', async () => {
    const setName = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ setName })} />);
    const input = screen.getByPlaceholderText('e.g. Alpha DEX Bot');
    await user.type(input, 'My Bot');
    expect(setName).toHaveBeenCalled();
  });

  it('opens advanced settings on Customize click', async () => {
    const setShowAdvanced = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ setShowAdvanced })} />);
    await user.click(screen.getByText('Customize'));
    expect(setShowAdvanced).toHaveBeenCalledWith(true);
  });

  it('shows pack description for selected strategy', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Swing trading on DEXes')).toBeInTheDocument();
  });

  it('shows infrastructure/runtime hint for advanced settings', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Runtime backend and infrastructure controls are available in Advanced Settings.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Runtime Backend')).not.toBeInTheDocument();
    expect(screen.queryByText('Open Infrastructure Settings')).not.toBeInTheDocument();
  });

  it('shows fleet infrastructure status summary', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          serviceInfo: {
            blueprintId: 1,
            owner: '0x0000000000000000000000000000000000000000',
            operators: ['0x0000000000000000000000000000000000000001'],
            operatorCount: 1,
            ttl: 100,
            createdAt: 1,
            status: 1,
            isActive: true,
            isPermitted: true,
            blueprintMismatch: false,
          },
        })}
      />,
    );
    expect(screen.getByText('Infrastructure Status')).toBeInTheDocument();
    expect(screen.getByText(/Service #1: active, permitted/)).toBeInTheDocument();
  });

  it('shows not validated yet when fleet service info is not loaded', () => {
    render(<ConfigureStep {...defaultProps({ serviceInfo: null })} />);
    expect(screen.getByText(/Service #1: not validated yet/)).toBeInTheDocument();
  });

  it('shows service loading and error states for fleet infra summary', () => {
    const { rerender } = render(<ConfigureStep {...defaultProps({ serviceLoading: true })} />);
    expect(screen.getByText(/Service #1: checking status.../)).toBeInTheDocument();

    rerender(<ConfigureStep {...defaultProps({ serviceLoading: false, serviceError: 'boom' })} />);
    expect(screen.getByText(/Service #1: status unavailable/)).toBeInTheDocument();
  });

  it('shows blueprint mismatch and permission issues in infra summary', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          serviceInfo: {
            blueprintId: 42,
            owner: '0x0000000000000000000000000000000000000000',
            operators: ['0x0000000000000000000000000000000000000001'],
            operatorCount: 1,
            ttl: 100,
            createdAt: 1,
            status: 1,
            isActive: true,
            isPermitted: false,
            blueprintMismatch: true,
          },
        })}
      />,
    );
    expect(screen.getByText(/Service #1: active, not permitted, wrong blueprint \(#42\)/)).toBeInTheDocument();
  });

  it('shows instance infrastructure status summary', () => {
    const selectedOperators = new Set(['0x1234567890123456789012345678901234567890']);
    render(<ConfigureStep {...defaultProps({ isInstance: true, selectedOperators })} />);
    expect(screen.getByText(/Instance service mode with 1 selected operator\./)).toBeInTheDocument();
  });
});
