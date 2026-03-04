import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdvancedSettingsDialog } from '../AdvancedSettingsDialog';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';

mockBlueprintUi();
mockFramerMotion();

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
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
    fullInstructions: 'Base prompt',
    customExpertKnowledge: '',
    setCustomExpertKnowledge: vi.fn(),
    customInstructions: '',
    setCustomInstructions: vi.fn(),
    customCron: '',
    setCustomCron: vi.fn(),
    validatorMode: 'default' as const,
    setValidatorMode: vi.fn(),
    customValidatorIds: '',
    setCustomValidatorIds: vi.fn(),
    runtimeBackend: 'docker' as const,
    setRuntimeBackend: vi.fn(),
    firecrackerSupported: false,
    isTeeBlueprint: false,
    onOpenInfrastructure: vi.fn(),
    ...overrides,
  };
}

describe('AdvancedSettingsDialog', () => {
  it('renders runtime selector and disables firecracker when unsupported', () => {
    render(<AdvancedSettingsDialog {...defaultProps()} />);
    const select = screen.getByLabelText('Runtime Backend') as HTMLSelectElement;
    expect(select.value).toBe('docker');
    const firecrackerOption = screen.getByRole('option', { name: /Firecracker \(microVM, unavailable\)/ });
    expect(firecrackerOption).toBeDisabled();
    expect(screen.getByText('Firecracker runtime is not enabled for this deployment.')).toBeInTheDocument();
  });

  it('pins runtime to tee for tee blueprints', () => {
    render(<AdvancedSettingsDialog {...defaultProps({ isTeeBlueprint: true, runtimeBackend: 'docker' })} />);
    const select = screen.getByLabelText('Runtime Backend') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.value).toBe('tee');
    expect(screen.getByText('TEE blueprints are pinned to TEE runtime.')).toBeInTheDocument();
  });

  it('opens infrastructure settings from advanced dialog', async () => {
    const onOpenInfrastructure = vi.fn();
    const user = userEvent.setup();
    render(<AdvancedSettingsDialog {...defaultProps({ onOpenInfrastructure })} />);
    await user.click(screen.getByText('Open Infrastructure Settings'));
    expect(onOpenInfrastructure).toHaveBeenCalledOnce();
  });

  it('calls setRuntimeBackend when runtime selection changes', async () => {
    const setRuntimeBackend = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedSettingsDialog
        {...defaultProps({
          firecrackerSupported: true,
          setRuntimeBackend,
        })}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Runtime Backend'), 'firecracker');
    expect(setRuntimeBackend).toHaveBeenCalledWith('firecracker');
  });

  it('shows enabled firecracker option when supported', () => {
    render(<AdvancedSettingsDialog {...defaultProps({ firecrackerSupported: true })} />);
    const firecrackerOption = screen.getByRole('option', { name: 'Firecracker (microVM)' });
    expect(firecrackerOption).not.toBeDisabled();
  });

  it('resets runtime and validator settings to defaults', async () => {
    const setRuntimeBackend = vi.fn();
    const setCustomCron = vi.fn();
    const setValidatorMode = vi.fn();
    const setCustomValidatorIds = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedSettingsDialog
        {...defaultProps({
          runtimeBackend: 'firecracker',
          customCron: '0 */10 * * *',
          validatorMode: 'custom',
          customValidatorIds: '1,2',
          setRuntimeBackend,
          setCustomCron,
          setValidatorMode,
          setCustomValidatorIds,
        })}
      />,
    );
    await user.click(screen.getByText('Reset to Defaults'));
    expect(setCustomCron).toHaveBeenCalledWith('');
    expect(setValidatorMode).toHaveBeenCalledWith('default');
    expect(setCustomValidatorIds).toHaveBeenCalledWith('');
    expect(setRuntimeBackend).toHaveBeenCalledWith('docker');
  });

  it('does not reset runtime when tee blueprint is pinned', async () => {
    const setRuntimeBackend = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedSettingsDialog
        {...defaultProps({
          isTeeBlueprint: true,
          runtimeBackend: 'tee',
          customCron: '0 */10 * * *',
          setRuntimeBackend,
        })}
      />,
    );
    await user.click(screen.getByText('Reset to Defaults'));
    expect(setRuntimeBackend).not.toHaveBeenCalled();
  });
});
