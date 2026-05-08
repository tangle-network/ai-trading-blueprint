import type { MorphoBorrowEnforcement } from '~/lib/types/envelope';
import { AddressField, AmountField, Bytes32Field } from '../FormPrimitives';

interface Props {
  value: MorphoBorrowEnforcement;
  onChange: (next: MorphoBorrowEnforcement) => void;
}

export function MorphoBorrowFields({ value, onChange }: Props) {
  const patch = <K extends keyof MorphoBorrowEnforcement>(
    key: K,
    next: MorphoBorrowEnforcement[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <AddressField
        label="Morpho"
        value={value.morpho}
        onChange={(v) => patch('morpho', v)}
      />
      <Bytes32Field
        label="Market id"
        value={value.market_id}
        onChange={(v) => patch('market_id', v)}
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
        label="Min collateral ratio"
        value={value.min_collateral_ratio}
        onChange={(v) => patch('min_collateral_ratio', v)}
        defaultDecimals={18}
        hint="1e18-scaled collateralization floor"
      />
    </div>
  );
}
