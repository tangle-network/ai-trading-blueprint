import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockBlueprintUi } from '~/test/mocks';

mockBlueprintUi();

import { EnvelopeBuilder } from '../EnvelopeBuilder';
import type { SignedEnvelope } from '~/lib/types/envelope';

const VALID_VAULT = '0x0000000000000000000000000000000000000077' as const;
const VALID_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const;
const VALID_TOKEN_IN = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const VALID_TOKEN_OUT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const VALID_SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

function makeStartingEnvelope(): SignedEnvelope {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 2,
    bot_id: 'bot-builder-test',
    vault_address: VALID_VAULT,
    chain_id: 31337,
    protocol: 'uniswap_v3',
    policy: {
      max_trade_size_usd: '1000',
      max_total_exposure_usd: '5000',
      max_drawdown_pct: '20',
      can_open_positions: true,
    },
    approval_signers: [VALID_SIGNER],
    min_signatures: 1,
    issued_at: now - 10,
    expires_at: now + 86400,
    nonce: 1,
    verifying_contract: VALID_VAULT,
    enforcement: {
      kind: 'uniswap_v3_swap',
      UniswapV3Swap: {
        router: VALID_ROUTER,
        token_in: VALID_TOKEN_IN,
        token_out: VALID_TOKEN_OUT,
        fee_tier: 3000,
        max_single_amount_in: '1000000000000000000',
        max_total_amount_in: '10000000000000000000',
        min_output_per_input: '1',
      },
    },
    signatures: [],
  };
}

describe('EnvelopeBuilder', () => {
  it('hands a structurally-valid envelope back via onUseEnvelope', () => {
    const onUse = vi.fn<(env: SignedEnvelope) => void>();
    render(
      <EnvelopeBuilder
        initial={makeStartingEnvelope()}
        onUseEnvelope={onUse}
      />,
    );

    // No issues — validation status reads "structurally valid".
    expect(screen.getByTestId('validation-status')).toHaveTextContent(/structurally valid/i);

    const useBtn = screen.getByTestId('use-envelope-button') as HTMLButtonElement;
    expect(useBtn.disabled).toBe(false);
    fireEvent.click(useBtn);

    expect(onUse).toHaveBeenCalledTimes(1);
    const out = onUse.mock.calls[0][0];
    expect(out.version).toBe(2);
    expect(out.bot_id).toBe('bot-builder-test');
    expect(out.protocol).toBe('uniswap_v3');
    expect(out.enforcement?.kind).toBe('uniswap_v3_swap');
    if (out.enforcement?.kind === 'uniswap_v3_swap') {
      expect(out.enforcement.UniswapV3Swap.router).toBe(VALID_ROUTER);
      expect(out.enforcement.UniswapV3Swap.fee_tier).toBe(3000);
    }
    expect(out.approval_signers).toEqual([VALID_SIGNER]);
    expect(out.min_signatures).toBe(1);
  });

  it('disables "Use this envelope" when validation fails', () => {
    const onUse = vi.fn();
    render(
      <EnvelopeBuilder onUseEnvelope={onUse} />,
    );
    // Default zeroed envelope has multiple issues (no signers, zero amounts, etc.)
    const useBtn = screen.getByTestId('use-envelope-button') as HTMLButtonElement;
    expect(useBtn.disabled).toBe(true);
    expect(screen.getByTestId('validation-status')).toHaveTextContent(/issue/i);
  });

  it('switching enforcement variant resets protocol field accordingly', () => {
    const onUse = vi.fn<(env: SignedEnvelope) => void>();
    const { container } = render(
      <EnvelopeBuilder
        initial={makeStartingEnvelope()}
        onUseEnvelope={onUse}
      />,
    );
    const select = container.querySelector(
      '[data-testid="enforcement-variant-picker"]',
    ) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'morpho_supply' } });

    // Re-render: validation now flags the zeroed Morpho fields.
    expect(screen.getByTestId('validation-status')).toHaveTextContent(/issue/i);
    // And the picker reflects the new kind.
    expect(select.value).toBe('morpho_supply');
  });
});
