/**
 * Validates the post-provision redirect behavior for envelope-mode bots.
 *
 * The provision wizard's SecretsStep renders a "View Bot" link once a bot
 * activates. When the operator chose `validationTrust=envelope` during the
 * Configure step, that link must include `?tab=envelope` so the bot detail
 * page opens directly on the Envelope tab — the operator still needs to sign
 * and submit the first envelope before trading is enabled.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecretsStep } from '../SecretsStep';
import type { TrackedProvision } from '~/lib/stores/provisions';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';

mockBlueprintUi();
mockFramerMotion();

vi.mock('react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) => (
    <a href={typeof to === 'string' ? to : ''} {...rest}>
      {children as React.ReactNode}
    </a>
  ),
}));

vi.mock('~/components/secrets/SecretsProviderFields', () => ({
  SecretsProviderFields: () => null,
}));

vi.mock('~/lib/utils/provisionBotRoute', () => ({
  getProvisionBotRouteId: (provision: TrackedProvision) =>
    provision.botId ?? provision.sandboxId ?? null,
}));

vi.mock('~/lib/config/aiProviders', () => ({
  ACTIVATION_LABELS: {},
}));

const baseProvision: TrackedProvision = {
  id: 'prov-1',
  owner: '0x0000000000000000000000000000000000000001',
  name: 'Bot',
  strategyType: 'dex',
  operators: [],
  blueprintId: '1',
  phase: 'active',
  createdAt: 1,
  updatedAt: 2,
  chainId: 31337,
  botId: 'bot-abc',
  sandboxId: 'sandbox-abc',
};

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    latestDeployment: baseProvision,
    isInstance: false,
    aiProvider: 'anthropic' as const,
    setAiProvider: vi.fn(),
    apiKey: 'sk-x',
    setApiKey: vi.fn(),
    extraEnvs: [],
    setExtraEnvs: vi.fn(),
    envIdRef: { current: 0 } as React.MutableRefObject<number>,
    useOperatorKey: false,
    setUseOperatorKey: vi.fn(),
    isSubmittingSecrets: false,
    activationPhase: null,
    secretsLookupError: null,
    handleSubmitSecrets: vi.fn(),
    setStep: vi.fn(),
    resetTx: vi.fn(),
    defaultProvider: 'anthropic' as const,
    ...overrides,
  };
}

describe('SecretsStep post-provision redirect', () => {
  it('routes to the Envelope tab when validationTrust=envelope', () => {
    render(
      <SecretsStep
        {...defaultProps({ validationTrust: 'envelope' })}
      />,
    );

    const link = screen.getByRole('link', {
      name: /Sign Envelope to Enable Trading/i,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/arena/bot/bot-abc?tab=envelope');
  });

  it('routes to the default bot detail when validationTrust is per_trade', () => {
    render(<SecretsStep {...defaultProps({ validationTrust: 'per_trade' })} />);

    const link = screen.getByRole('link', { name: /View Bot/i });
    expect(link).toHaveAttribute('href', '/arena/bot/bot-abc');
    expect(link).not.toHaveAttribute('href', expect.stringContaining('tab='));
  });

  it('routes to the default bot detail when validationTrust is omitted', () => {
    render(<SecretsStep {...defaultProps()} />);

    const link = screen.getByRole('link', { name: /View Bot/i });
    expect(link).toHaveAttribute('href', '/arena/bot/bot-abc');
  });

  it('shows the envelope reminder copy only in envelope mode', () => {
    const { rerender } = render(
      <SecretsStep {...defaultProps({ validationTrust: 'envelope' })} />,
    );
    expect(
      screen.getByText(
        /this bot won't trade until an envelope is signed and submitted/i,
      ),
    ).toBeInTheDocument();

    rerender(<SecretsStep {...defaultProps({ validationTrust: 'per_trade' })} />);
    expect(
      screen.queryByText(
        /this bot won't trade until an envelope is signed and submitted/i,
      ),
    ).not.toBeInTheDocument();
  });
});
