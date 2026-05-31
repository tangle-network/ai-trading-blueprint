/**
 * Variant picker for the envelope enforcement union.
 *
 * Switching the kind hands the parent a freshly-defaulted enforcement of the
 * new shape via onChange — the parent should treat that as a full replace
 * rather than a partial merge so we don't leak fields from the previous
 * variant into the new struct.
 */

import { ENFORCEMENT_KINDS, type EnforcementKind, type EnvelopeEnforcement } from '~/lib/types/envelope';
import { defaultEnforcementForKind, ENFORCEMENT_KIND_LABELS } from './defaults';
import { FieldShell } from './FormPrimitives';

interface Props {
  value: EnforcementKind;
  onChange: (next: EnvelopeEnforcement) => void;
  disabled?: boolean;
}

export function EnforcementVariantPicker({ value, onChange, disabled }: Props) {
  return (
    <FieldShell
      label="Enforcement variant"
      hint="Determines which on-chain protocol binding the envelope authorizes."
    >
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as EnforcementKind;
          onChange(defaultEnforcementForKind(next));
        }}
        className="h-11 rounded-lg px-3.5 py-2.5 text-base bg-arena-elements-background-depth-3 border border-arena-elements-borderColor text-arena-elements-textPrimary outline-none disabled:opacity-40"
        data-testid="enforcement-variant-picker"
      >
        {ENFORCEMENT_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {ENFORCEMENT_KIND_LABELS[kind]}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
