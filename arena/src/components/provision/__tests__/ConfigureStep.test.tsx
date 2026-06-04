import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '~/test/mockBlueprintUi';
import '~/test/mockFramerMotion';
import { ConfigureStep, strategySupportsClobCollateral } from '../ConfigureStep';

vi.mock('~/lib/blueprints', () => ({
  strategyPacks: [
    {
      id: 'dex-swing',
      name: 'DEX Swing',
      description: 'Swing trading on DEXes',
      providers: ['Uniswap', 'Sushiswap'],
      executionMode: 'single-chain' as const,
      supportedChainIds: [1, 8453],
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
      executionMode: 'single-chain' as const,
      supportedChainIds: [1, 8453],
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
      executionMode: 'single-chain' as const,
      supportedChainIds: [137],
      cron: '0 */6 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'Prediction market signal selection and execution.',
    },
    {
      id: 'volatility',
      name: 'Volatility',
      description: 'Volatility strategies',
      providers: ['Polymarket', 'Uniswap V3'],
      executionMode: 'paper-only' as const,
      supportedChainIds: [],
      cron: '0 */10 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'Volatility and prediction market setup.',
    },
    {
      id: 'multi',
      name: 'Cross-Strategy',
      description: 'Cross-strategy allocation',
      providers: ['All protocols'],
      executionMode: 'none' as const,
      supportedChainIds: [],
      cron: '0 */5 * * *',
      maxTurns: 40,
      timeoutMs: 120000,
      expertKnowledge: 'Cross-protocol setup.',
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
      executionMode: 'single-chain' as const,
      supportedChainIds: [1, 8453],
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
  it('identifies all Polymarket-capable strategies as CLOB collateral candidates', () => {
    expect(strategySupportsClobCollateral('prediction_crypto', { providers: ['Polymarket'] })).toBe(true);
    expect(strategySupportsClobCollateral('volatility', { providers: ['Polymarket', 'Uniswap V3'] })).toBe(true);
    expect(strategySupportsClobCollateral('mm', { providers: ['Polymarket', 'Hyperliquid'] })).toBe(true);
    expect(strategySupportsClobCollateral('multi', { providers: ['All protocols'] })).toBe(true);
    expect(strategySupportsClobCollateral('dex', { providers: ['Uniswap V3'] })).toBe(false);
  });

  it('renders agent name input', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Agent Name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Base USDC/WETH swing bot…')).toBeInTheDocument();
  });

  it('renders activation adapter grid', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Activation Adapter')).toBeInTheDocument();
    expect(screen.getAllByText('DEX Swing').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('DeFi Yield')).toBeInTheDocument();
  });

  it('surfaces the inherited agent profile separately from the activation adapter', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          name: 'ETH Perp Sentinel',
          agentProfileName: 'ETH Perp Sentinel',
          agentProfileObjective: 'Autonomously trade and improve the mandate.',
          capabilityFocusLabels: ['Hyperliquid Perps', 'DEX Spot'],
          availableProtocolCount: 8,
        })}
      />,
    );

    expect(screen.getByText('Agent Profile')).toBeInTheDocument();
    expect(screen.getAllByText('ETH Perp Sentinel').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Adapter')).toBeInTheDocument();
    expect(screen.getAllByText('8 wired protocols').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Autonomously trade and improve the mandate.')).toBeInTheDocument();
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
    const nextBtn = screen.getByText('Review Activation');
    expect(nextBtn).toBeDisabled();
  });

  it('enables next button when canNext is true', () => {
    render(<ConfigureStep {...defaultProps({ canNext: true })} />);
    const nextBtn = screen.getByText('Review Activation');
    expect(nextBtn).not.toBeDisabled();
  });

  it('calls goNext when next button clicked', async () => {
    const goNext = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ canNext: true, goNext })} />);
    await user.click(screen.getByText('Review Activation'));
    expect(goNext).toHaveBeenCalledOnce();
  });

  it('calls setName on input change', async () => {
    const setName = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ setName })} />);
    const input = screen.getByPlaceholderText('e.g. Base USDC/WETH swing bot…');
    await user.type(input, 'My Bot');
    expect(setName).toHaveBeenCalled();
  });

  it('opens advanced settings on Runtime click', async () => {
    const setShowAdvanced = vi.fn();
    const user = userEvent.setup();
    render(<ConfigureStep {...defaultProps({ setShowAdvanced })} />);
    await user.click(screen.getByText('Runtime'));
    expect(setShowAdvanced).toHaveBeenCalledWith(true);
  });

  it('shows pack description for selected strategy', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Swing trading on DEXes')).toBeInTheDocument();
  });

  it('renders Hyperliquid target and guardrails for the default perp launch path', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          strategyType: 'hyperliquid_perp',
          selectedPack: {
            id: 'hyperliquid_perp',
            name: 'Hyperliquid Perps',
            description: 'Native Hyperliquid perpetual futures.',
            providers: ['Hyperliquid', 'CoinGecko'],
            executionMode: 'single-chain' as const,
            supportedChainIds: [998],
            cron: '0 */2 * * *',
            maxTurns: 40,
            timeoutMs: 120000,
            expertKnowledge: 'Hyperliquid account and margin setup.',
          },
          executionTargetLabel: 'HyperEVM Testnet',
          executionTargetDescription: 'Uses a bot-bound HyperEVM vault account for native Hyperliquid perps.',
        })}
      />,
    );

    expect(screen.getByPlaceholderText('e.g. ETH Hyperliquid breakout agent…')).toBeInTheDocument();
    expect(screen.getAllByText('Hyperliquid Perps').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('HyperEVM Testnet')).toBeInTheDocument();
    expect(screen.getByText('Hyperliquid Guardrails')).toBeInTheDocument();
    expect(screen.getByText('Bot-bound HyperEVM vault')).toBeInTheDocument();
    expect(screen.getByText('USDC margin, validator checked')).toBeInTheDocument();
    expect(screen.getByText('Native Hyperliquid perps only')).toBeInTheDocument();
    expect(screen.getByText('Reduce-only when closing risk')).toBeInTheDocument();
  });

  it('keeps runtime controls behind advanced settings', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.getByText('Runtime')).toBeInTheDocument();
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
    expect(screen.getByText('Operator Route')).toBeInTheDocument();
    expect(screen.getByText(/Service #1: active, permitted/)).toBeInTheDocument();
  });

  it('renders token logos and selected asset summary for DEX strategies', () => {
    const usdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const weth = '0x4200000000000000000000000000000000000006';
    const { container } = render(
      <ConfigureStep
        {...defaultProps({
          assetOptions: [
            {
              address: usdc,
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              known: true,
              valuationSource: 'chainlink',
              logoUri: '/token-icons/usdc.svg',
            },
            {
              address: weth,
              symbol: 'WETH',
              name: 'Wrapped Ether',
              decimals: 18,
              known: true,
              valuationSource: 'chainlink',
              logoUri: '/token-icons/weth.svg',
            },
          ],
          selectedAssetAddresses: [usdc, weth],
          baseAssetAddress: usdc,
        })}
      />,
    );

    expect(container.querySelector('img[src="/token-icons/usdc.svg"]')).not.toBeNull();
    expect(container.querySelector('img[src="/token-icons/weth.svg"]')).not.toBeNull();
    expect(screen.getByText('USDC / WETH')).toBeInTheDocument();
  });

  it('shows not validated yet when fleet service info is not loaded', () => {
    render(<ConfigureStep {...defaultProps({ serviceInfo: null })} />);
    expect(screen.getByText(/Service #1: not validated yet/)).toBeInTheDocument();
  });

  it('shows service loading and error states for fleet infra summary', () => {
    const { rerender } = render(<ConfigureStep {...defaultProps({ serviceLoading: true })} />);
    expect(screen.getByText(/Service #1: checking status…/)).toBeInTheDocument();

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

  it('shows CLOB collateral controls for Polymarket-capable non-prediction strategies', () => {
    render(
      <ConfigureStep
        {...defaultProps({
          strategyType: 'volatility',
          selectedPack: {
            id: 'volatility',
            name: 'Volatility',
            description: 'Volatility strategies',
            providers: ['Polymarket', 'Uniswap V3'],
            executionMode: 'paper-only' as const,
            supportedChainIds: [],
            cron: '0 */10 * * *',
            maxTurns: 40,
            timeoutMs: 120000,
            expertKnowledge: 'Volatility and prediction market setup.',
          },
        })}
      />,
    );

    expect(screen.getByLabelText('CLOB Collateral Cap (%)')).toBeInTheDocument();
  });

  it('does not show CLOB collateral controls for non-Polymarket strategies', () => {
    render(<ConfigureStep {...defaultProps()} />);
    expect(screen.queryByLabelText('CLOB Collateral Cap (%)')).not.toBeInTheDocument();
  });
});
