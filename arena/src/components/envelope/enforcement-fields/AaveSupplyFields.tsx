import type { AaveSupplyEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField } from '../FormPrimitives';

interface Props {
  value: AaveSupplyEnforcement;
  onChange: (next: AaveSupplyEnforcement) => void;
}

export function AaveSupplyFields({ value, onChange }: Props) {
  const patch = <K extends keyof AaveSupplyEnforcement>(
    key: K,
    next: AaveSupplyEnforcement[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <AddressField
        label="Pool"
        value={value.pool}
        onChange={(v) => patch('pool', v)}
        hint="Aave V3 pool contract"
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
    </div>
  );
}
