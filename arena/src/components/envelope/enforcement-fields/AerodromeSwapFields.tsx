import type { AerodromeSwapEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField, NumberField } from '../FormPrimitives';

interface Props {
  value: AerodromeSwapEnforcement;
  onChange: (next: AerodromeSwapEnforcement) => void;
}

export function AerodromeSwapFields({ value, onChange }: Props) {
  const patch = <K extends keyof AerodromeSwapEnforcement>(
    key: K,
    next: AerodromeSwapEnforcement[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <AddressField
        label="Router"
        value={value.router}
        onChange={(v) => patch('router', v)}
        hint="Aerodrome SlipstreamRouter"
      />
      <NumberField
        label="Tick spacing"
        value={value.tick_spacing}
        onChange={(v) => patch('tick_spacing', v)}
        signed
        hint="Pool tick spacing (signed int)"
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
      />
    </div>
  );
}
