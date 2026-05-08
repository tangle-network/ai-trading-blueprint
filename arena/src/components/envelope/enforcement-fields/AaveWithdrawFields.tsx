import type { AaveWithdrawEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField } from '../FormPrimitives';

interface Props {
  value: AaveWithdrawEnforcement;
  onChange: (next: AaveWithdrawEnforcement) => void;
}

export function AaveWithdrawFields({ value, onChange }: Props) {
  const patch = <K extends keyof AaveWithdrawEnforcement>(
    key: K,
    next: AaveWithdrawEnforcement[K],
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
