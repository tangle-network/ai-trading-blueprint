import type { UniswapV4SwapEnforcement } from '~/lib/types/envelope';
import {
  AddressField,
  AmountField,
  NumberField,
  ToggleField,
} from '../FormPrimitives';

interface Props {
  value: UniswapV4SwapEnforcement;
  onChange: (next: UniswapV4SwapEnforcement) => void;
}

export function UniswapV4SwapFields({ value, onChange }: Props) {
  const patch = <K extends keyof UniswapV4SwapEnforcement>(
    key: K,
    next: UniswapV4SwapEnforcement[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <AddressField
        label="Universal router"
        value={value.universal_router}
        onChange={(v) => patch('universal_router', v)}
      />
      <AddressField
        label="Hooks"
        value={value.hooks}
        onChange={(v) => patch('hooks', v)}
        hint="Pass 0x0…0 if pool has no hooks contract"
      />
      <AddressField
        label="Currency 0"
        value={value.currency0}
        onChange={(v) => patch('currency0', v)}
      />
      <AddressField
        label="Currency 1"
        value={value.currency1}
        onChange={(v) => patch('currency1', v)}
      />
      <NumberField
        label="Fee"
        value={value.fee}
        onChange={(v) => patch('fee', v)}
        hint="Pool fee (e.g. 3000 for 0.30%)"
      />
      <NumberField
        label="Tick spacing"
        value={value.tick_spacing}
        onChange={(v) => patch('tick_spacing', v)}
        signed
        hint="Pool tick spacing (signed int)"
      />
      <ToggleField
        label="Zero-for-one"
        value={value.zero_for_one}
        onChange={(v) => patch('zero_for_one', v)}
        hint="Direction: currency0 → currency1 when on"
      />
      <div />
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
      />
    </div>
  );
}
