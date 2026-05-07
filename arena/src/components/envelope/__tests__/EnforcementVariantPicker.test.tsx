import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockBlueprintUi } from '~/test/mocks';

mockBlueprintUi();

import { EnforcementVariantPicker } from '../EnforcementVariantPicker';
import { defaultEnforcementForKind } from '../defaults';
import type { EnvelopeEnforcement } from '~/lib/types/envelope';

describe('EnforcementVariantPicker', () => {
  it('renders all 11 variants as options', () => {
    const onChange = vi.fn();
    render(
      <EnforcementVariantPicker value="uniswap_v3_swap" onChange={onChange} />,
    );
    const select = screen.getByTestId('enforcement-variant-picker') as HTMLSelectElement;
    expect(select.options).toHaveLength(11);
    expect([...select.options].map((o) => o.value)).toEqual([
      'uniswap_v3_swap',
      'uniswap_v4_swap',
      'aerodrome_swap',
      'aave_supply',
      'aave_withdraw',
      'aave_borrow',
      'aave_repay',
      'morpho_supply',
      'morpho_withdraw',
      'morpho_borrow',
      'morpho_repay',
    ]);
  });

  it('emits a defaulted enforcement of the new kind when the variant changes', () => {
    const onChange = vi.fn<(next: EnvelopeEnforcement) => void>();
    render(
      <EnforcementVariantPicker value="uniswap_v3_swap" onChange={onChange} />,
    );

    const select = screen.getByTestId('enforcement-variant-picker') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'aave_borrow' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.kind).toBe('aave_borrow');
    // Defaulted shape matches `defaultEnforcementForKind` exactly.
    expect(next).toEqual(defaultEnforcementForKind('aave_borrow'));
  });

  it('switching to a Morpho variant produces a bytes32 market_id default', () => {
    const onChange = vi.fn<(next: EnvelopeEnforcement) => void>();
    render(
      <EnforcementVariantPicker value="uniswap_v3_swap" onChange={onChange} />,
    );

    const select = screen.getByTestId('enforcement-variant-picker') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'morpho_withdraw' } });

    const next = onChange.mock.calls[0][0];
    expect(next.kind).toBe('morpho_withdraw');
    if (next.kind === 'morpho_withdraw') {
      expect(next.MorphoWithdraw.market_id).toMatch(/^0x[0-9a-f]{64}$/);
      // No fields leaked from the previous (UniswapV3) shape.
      expect(Object.keys(next.MorphoWithdraw).sort()).toEqual([
        'market_id',
        'max_single_amount',
        'max_total_amount',
        'min_collateral_ratio',
        'morpho',
      ]);
    }
  });

  it('respects the `disabled` prop', () => {
    render(
      <EnforcementVariantPicker
        value="aave_supply"
        onChange={vi.fn()}
        disabled
      />,
    );
    const select = screen.getByTestId('enforcement-variant-picker') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
