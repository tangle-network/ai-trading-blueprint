import type { UniswapV3SwapEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField, NumberField } from '../FormPrimitives';

interface Props {
  value: UniswapV3SwapEnforcement;
  onChange: (next: UniswapV3SwapEnforcement) => void;
}

export function UniswapV3SwapFields({ value, onChange }: Props) {
  const patch = <K extends keyof UniswapV3SwapEnforcement>(
    key: K,
    next: UniswapV3SwapEnforcement[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <AddressField
        label="Router"
        value={value.router}
        onChange={(v) => patch('router', v)}
        hint="Uniswap V3 SwapRouter contract"
      />
      <NumberField
        label="Fee tier"
        value={value.fee_tier}
        onChange={(v) => patch('fee_tier', v)}
        hint="100 / 500 / 3000 / 10000"
      />
      <AddressField
        label="Token in"
        value={value.token_in}
        onChange={(v) => patch('token_in', v)}
      />
      <AddressField
        label="Token out"
        value={value.token_out}
        onChange={(v) => patch('token_out', v)}
      />
      <AmountField
        label="Max single amount in"
        value={value.max_single_amount_in}
        onChange={(v) => patch('max_single_amount_in', v)}
      />
      <AmountField
        label="Max total amount in"
        value={value.max_total_amount_in}
        onChange={(v) => patch('max_total_amount_in', v)}
      />
      <AmountField
        label="Min output per input"
        value={value.min_output_per_input}
        onChange={(v) => patch('min_output_per_input', v)}
        hint="Floor on output token per input token (raw scaled)"
      />
    </div>
  );
}
