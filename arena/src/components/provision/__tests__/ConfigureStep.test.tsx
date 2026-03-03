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
    runtimeBackend: 'docker' as const,
    setRuntimeBackend: vi.fn(),
    firecrackerSupported: false,
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
    selectedBlueprint: undefined,
    serviceInfo: null,
    serviceLoading: false,
    serviceError: null,
    serviceId: '1',
    discoveryLoading: false,
    selectedOperators: new Set() as Set<`0x${string}`>,
    isInstance: false,
    setShowInfra: vi.fn(),
    setShowAdvanced: vi.fn(),
    collateralCapPct: '',
    setCollateralCapPct: vi.fn(),
    canNext: false,
    goNext: vi.fn(),
    userAddress: undefined,
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

  it('opens infrastructure dialog on bar click', async () => {
    const setShowInfra = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ setShowInfra })} />);
    const infraBtn = screen.getByText('Change');
    await user.click(infraBtn.closest('button')!);
    expect(setShowInfra).toHaveBeenCalledWith(true);
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

  it('shows instance mode infrastructure bar text', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          isInstance: true,
          selectedBlueprint: { name: 'Trading Instance', id: 0 },
        })}
      />,
    );
    expect(screen.getByText(/Trading Instance — New service will be created/)).toBeInTheDocument();
  });

  it('disables firecracker option when unsupported', () => {
    render(<ConfigureStep {...defaultProps({ firecrackerSupported: false })} />);
    const option = screen.getByRole('option', { name: /Firecracker \(microVM, unavailable\)/ });
    expect(option).toBeDisabled();
    expect(screen.getByText('Firecracker runtime is currently unavailable and cannot be selected.')).toBeInTheDocument();
  });

  it('enables firecracker option when supported', () => {
    render(<ConfigureStep {...defaultProps({ firecrackerSupported: true })} />);
    const option = screen.getByRole('option', { name: /Firecracker \(microVM\)/ });
    expect(option).not.toBeDisabled();
  });

  it('calls setRuntimeBackend when selecting tee runtime', async () => {
    const setRuntimeBackend = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ setRuntimeBackend })} />);
    await user.selectOptions(screen.getByLabelText('Runtime Backend'), 'tee');
    expect(setRuntimeBackend).toHaveBeenCalledWith('tee');
  });

  it('disables runtime selector for tee blueprints', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          runtimeBackend: 'tee',
          selectedBlueprint: { name: 'TEE Blueprint', id: 'tee-blueprint', isTee: true },
        })}
      />,
    );
    expect(screen.getByLabelText('Runtime Backend')).toBeDisabled();
  });
});
