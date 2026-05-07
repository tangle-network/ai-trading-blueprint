import type { AaveRepayEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField, SelectField } from '../FormPrimitives';

interface Props {
  value: AaveRepayEnforcement;
  onChange: (next: AaveRepayEnforcement) => void;
}

const RATE_MODES = [
  { label: 'Stable (1)', value: 1 as const },
  { label: 'Variable (2)', value: 2 as const },
];

export function AaveRepayFields({ value, onChange }: Props) {
  const patch = <K extends keyof AaveRepayEnforcement>(
    key: K,
    next: AaveRepayEnforcement[K],
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
      <AddressField
        label="Debt token"
        value={value.debt_token}
        onChange={(v) => patch('debt_token', v)}
        hint="Aave variable/stable debt token for the asset"
      />
      <SelectField
        label="Interest rate mode"
        value={value.interest_rate_mode}
        onChange={(v) => patch('interest_rate_mode', v as 1 | 2)}
        options={RATE_MODES}
      />
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
    </div>
  );
}
