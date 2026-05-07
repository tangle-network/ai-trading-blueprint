/**
 * Switch dispatcher: render the right per-variant fields for the given
 * enforcement value. Centralizes the discriminant check so the builder
 * doesn't need an 11-arm switch inline.
 */

import type { EnvelopeEnforcement } from '~/lib/types/envelope';
import { UniswapV3SwapFields } from './UniswapV3SwapFields';
import { UniswapV4SwapFields } from './UniswapV4SwapFields';
import { AerodromeSwapFields } from './AerodromeSwapFields';
import { AaveSupplyFields } from './AaveSupplyFields';
import { AaveWithdrawFields } from './AaveWithdrawFields';
import { AaveBorrowFields } from './AaveBorrowFields';
import { AaveRepayFields } from './AaveRepayFields';
import { MorphoSupplyFields } from './MorphoSupplyFields';
import { MorphoWithdrawFields } from './MorphoWithdrawFields';
import { MorphoBorrowFields } from './MorphoBorrowFields';
import { MorphoRepayFields } from './MorphoRepayFields';

interface Props {
  value: EnvelopeEnforcement;
  onChange: (next: EnvelopeEnforcement) => void;
}

export function EnforcementFields({ value, onChange }: Props) {
  switch (value.kind) {
    case 'uniswap_v3_swap':
      return (
        <UniswapV3SwapFields
          value={value.UniswapV3Swap}
          onChange={(v) => onChange({ kind: 'uniswap_v3_swap', UniswapV3Swap: v })}
        />
      );
    case 'uniswap_v4_swap':
      return (
        <UniswapV4SwapFields
          value={value.UniswapV4Swap}
          onChange={(v) => onChange({ kind: 'uniswap_v4_swap', UniswapV4Swap: v })}
        />
      );
    case 'aerodrome_swap':
      return (
        <AerodromeSwapFields
          value={value.AerodromeSwap}
          onChange={(v) => onChange({ kind: 'aerodrome_swap', AerodromeSwap: v })}
        />
      );
    case 'aave_supply':
      return (
        <AaveSupplyFields
          value={value.AaveSupply}
          onChange={(v) => onChange({ kind: 'aave_supply', AaveSupply: v })}
        />
      );
    case 'aave_withdraw':
      return (
        <AaveWithdrawFields
          value={value.AaveWithdraw}
          onChange={(v) => onChange({ kind: 'aave_withdraw', AaveWithdraw: v })}
        />
      );
    case 'aave_borrow':
      return (
        <AaveBorrowFields
          value={value.AaveBorrow}
          onChange={(v) => onChange({ kind: 'aave_borrow', AaveBorrow: v })}
        />
      );
    case 'aave_repay':
      return (
        <AaveRepayFields
          value={value.AaveRepay}
          onChange={(v) => onChange({ kind: 'aave_repay', AaveRepay: v })}
        />
      );
    case 'morpho_supply':
      return (
        <MorphoSupplyFields
          value={value.MorphoSupply}
          onChange={(v) => onChange({ kind: 'morpho_supply', MorphoSupply: v })}
        />
      );
    case 'morpho_withdraw':
      return (
        <MorphoWithdrawFields
          value={value.MorphoWithdraw}
          onChange={(v) => onChange({ kind: 'morpho_withdraw', MorphoWithdraw: v })}
        />
      );
    case 'morpho_borrow':
      return (
        <MorphoBorrowFields
          value={value.MorphoBorrow}
          onChange={(v) => onChange({ kind: 'morpho_borrow', MorphoBorrow: v })}
        />
      );
    case 'morpho_repay':
      return (
        <MorphoRepayFields
          value={value.MorphoRepay}
          onChange={(v) => onChange({ kind: 'morpho_repay', MorphoRepay: v })}
        />
      );
  }
}
