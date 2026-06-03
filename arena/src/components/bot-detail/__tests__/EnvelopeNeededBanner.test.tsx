/**
 * Verifies the envelope-required banner only renders for envelope-mode bots
 * with no envelope on file, and disappears once one is stored.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '~/test/mockBlueprintUi';
import '~/test/mockFramerMotion';
import { EnvelopeNeededBanner } from '../EnvelopeNeededBanner';
import type { Bot } from '~/lib/types/bot';

const useEnvelopeMock = vi.fn();

vi.mock('~/lib/hooks/useEnvelope', () => ({
  useEnvelope: (...args: unknown[]) => useEnvelopeMock(...args),
}));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    serviceId: 1,
    name: 'Bot',
    operatorAddress: '0x0000000000000000000000000000000000000001',
    vaultAddress: '0x0000000000000000000000000000000000000002',
    strategyType: 'dex',
    status: 'active',
    createdAt: 0,
    pnlPercent: 0,
    pnlAbsolute: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    tvl: 0,
    avgValidatorScore: 0,
    sparklineData: [],
    operatorKind: 'cloud',
    operatorApiUrl: 'http://operator',
    ...overrides,
  };
}

describe('EnvelopeNeededBanner', () => {
  it('does not render for per-trade bots', () => {
    useEnvelopeMock.mockReturnValue({ data: null, isLoading: false, isError: false });
    const { container } = render(
      <EnvelopeNeededBanner
        bot={makeBot({ validationTrust: 'per_trade' })}
        onSignEnvelope={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not render while the envelope query is loading', () => {
    useEnvelopeMock.mockReturnValue({ data: null, isLoading: true, isError: false });
    const { container } = render(
      <EnvelopeNeededBanner
        bot={makeBot({ validationTrust: 'envelope' })}
        onSignEnvelope={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders for envelope bots with no envelope on file', () => {
    useEnvelopeMock.mockReturnValue({ data: null, isLoading: false, isError: false });
    render(
      <EnvelopeNeededBanner
        bot={makeBot({ validationTrust: 'envelope' })}
        onSignEnvelope={vi.fn()}
      />,
    );
    expect(screen.getByText(/Envelope required/i)).toBeInTheDocument();
    expect(screen.getByText(/This bot is in Envelope mode/i)).toHaveClass('dark:text-amber-100/85');
    expect(screen.getByRole('button', { name: /Open Envelope tab/i })).toBeInTheDocument();
  });

  it('disappears once an envelope is stored', () => {
    useEnvelopeMock.mockReturnValue({
      data: { version: 2, signatures: [{ signer: '0x1', signature: '0x2', score: 100 }] },
      isLoading: false,
      isError: false,
    });
    const { container } = render(
      <EnvelopeNeededBanner
        bot={makeBot({ validationTrust: 'envelope' })}
        onSignEnvelope={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('invokes the callback when Open Envelope tab is clicked', async () => {
    useEnvelopeMock.mockReturnValue({ data: null, isLoading: false, isError: false });
    const onSignEnvelope = vi.fn();
    const user = userEvent.setup();
    render(
      <EnvelopeNeededBanner
        bot={makeBot({ validationTrust: 'envelope' })}
        onSignEnvelope={onSignEnvelope}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Open Envelope tab/i }));
    expect(onSignEnvelope).toHaveBeenCalledOnce();
  });
});
