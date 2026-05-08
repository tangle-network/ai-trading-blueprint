import type { AaveBorrowEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField, SelectField } from '../FormPrimitives';

interface Props {
  value: AaveBorrowEnforcement;
  onChange: (next: AaveBorrowEnforcement) => void;
}

const RATE_MODES = [
  { label: 'Stable (1)', value: 1 as const },
  { label: 'Variable (2)', value: 2 as const },
];

export function AaveBorrowFields({ value, onChange }: Props) {
  const patch = <K extends keyof AaveBorrowEnforcement>(
    key: K,
    next: AaveBorrowEnforcement[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <AddressField
        label="Pool"
        value={value.pool}
        onChange={(v) => patch('pool', v)}
      />
      <AddressField
        label="Asset"
        value={value.asset}
        onChange={(v) => patch('asset', v)}
      />
      <SelectField
        label="Interest rate mode"
        value={value.interest_rate_mode}
        onChange={(v) => patch('interest_rate_mode', v as 1 | 2)}
        options={RATE_MODES}
      />
      <div />
      <AmountField
        label="Max single amount"
        value={value.max_single_amount}
        onChange={(v) => patch('max_single_amount', v)}
      />
      <AmountField
        label="Max total amount"
        value={value.max_total_amount}
        onChange={(v) => patch('max_total_amount', v)}
      />
      <AmountField
        label="Min health factor"
        value={value.min_health_factor}
        onChange={(v) => patch('min_health_factor', v)}
        defaultDecimals={18}
        hint="1e18-scaled — typically 1.0 to 2.0"
      />
    </div>
  );
}
