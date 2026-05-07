/**
 * Controlled form primitives for the envelope builder.
 *
 * - AddressField: viem-validated checksummed address input.
 * - AmountField: decimal-string entry with a "decimals" toggle that scales
 *   to the U256 string the contract expects.
 * - Bytes32Field: 32-byte hex with auto-padding + length validation.
 * - SignedIntField, NumberField, ToggleField, TextField wrappers.
 *
 * All emit normalized values via onChange and surface inline error text.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { getAddress } from 'viem';
import { Input } from '@tangle-network/blueprint-ui/components';

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}

export function FieldShell({ label, hint, error, children }: FieldShellProps) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-bp-elements-textTertiary font-medium">
        {label}
      </span>
      {children}
      {hint && !error && (
        <span className="text-xs text-bp-elements-textTertiary">{hint}</span>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </label>
  );
}

// ── Address ──

interface AddressFieldProps {
  label: string;
  value: `0x${string}`;
  onChange: (next: `0x${string}`) => void;
  hint?: string;
}

export function AddressField({ label, value, onChange, hint }: AddressFieldProps) {
  const [draft, setDraft] = useState<string>(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleBlur = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError('address required');
      return;
    }
    try {
      const checksummed = getAddress(trimmed);
      setError(null);
      setDraft(checksummed);
      if (checksummed !== value) {
        onChange(checksummed as `0x${string}`);
      }
    } catch {
      setError('invalid EVM address');
    }
  };

  const handleChange = (raw: string) => {
    setDraft(raw);
    if (error) setError(null);
  };

  return (
    <FieldShell label={label} hint={hint} error={error}>
      <Input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder="0x…"
        className="font-mono text-xs"
      />
    </FieldShell>
  );
}

// ── Bytes32 ──

interface Bytes32FieldProps {
  label: string;
  value: `0x${string}`;
  onChange: (next: `0x${string}`) => void;
  hint?: string;
}

export function Bytes32Field({ label, value, onChange, hint }: Bytes32FieldProps) {
  const [draft, setDraft] = useState<string>(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleBlur = () => {
    let trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError('bytes32 required');
      return;
    }
    if (!trimmed.startsWith('0x') && !trimmed.startsWith('0X')) {
      trimmed = `0x${trimmed}`;
    }
    const hex = trimmed.slice(2);
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      setError('must be hex');
      return;
    }
    if (hex.length > 64) {
      setError('exceeds 32 bytes');
      return;
    }
    const padded = `0x${hex.padStart(64, '0').toLowerCase()}` as `0x${string}`;
    setError(null);
    setDraft(padded);
    if (padded !== value) {
      onChange(padded);
    }
  };

  return (
    <FieldShell label={label} hint={hint} error={error}>
      <Input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={handleBlur}
        placeholder="0x…"
        className="font-mono text-xs"
      />
    </FieldShell>
  );
}

// ── Amount with optional decimal scaling ──

const COMMON_DECIMALS = [
  { label: 'Raw integer (no scaling)', value: 0 },
  { label: 'USDC / USDT (6 decimals)', value: 6 },
  { label: 'WBTC (8 decimals)', value: 8 },
  { label: 'WETH / DAI (18 decimals)', value: 18 },
];

interface AmountFieldProps {
  label: string;
  /** Raw U256 value as a decimal string. */
  value: string;
  onChange: (rawU256: string) => void;
  hint?: string;
  defaultDecimals?: number;
}

/**
 * Two-mode amount entry:
 *   - User picks a decimals preset (0/6/8/18).
 *   - Input field shows the human-readable value.
 *   - We persist the U256 raw integer to the envelope.
 *
 * Round-trips: if `value` is changed externally, we infer a human display
 * by dividing by 10^decimals.
 */
export function AmountField({
  label,
  value,
  onChange,
  hint,
  defaultDecimals = 0,
}: AmountFieldProps) {
  const id = useId();
  const [decimals, setDecimals] = useState<number>(defaultDecimals);
  const [draft, setDraft] = useState<string>(() => rawToHuman(value, defaultDecimals));
  const [error, setError] = useState<string | null>(null);

  // If the parent changes the underlying U256 (e.g. variant switch), recompute display.
  useEffect(() => {
    setDraft(rawToHuman(value, decimals));
  }, [value, decimals]);

  const commit = (humanInput: string, dec: number) => {
    const trimmed = humanInput.trim();
    if (trimmed.length === 0) {
      setError(null);
      onChange('0');
      return;
    }
    try {
      const raw = humanToRaw(trimmed, dec);
      setError(null);
      onChange(raw);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <FieldShell label={label} hint={hint} error={error}>
      <div className="flex flex-col gap-1.5">
        <Input
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value, decimals);
          }}
          placeholder="0"
        />
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-dec`} className="text-xs text-bp-elements-textTertiary shrink-0">
            Scale:
          </label>
          <select
            id={`${id}-dec`}
            value={decimals}
            onChange={(e) => {
              const next = Number(e.target.value);
              setDecimals(next);
              commit(draft, next);
            }}
            className="text-xs bg-bp-elements-background-depth-3 border border-bp-elements-borderColor rounded px-2 py-1 outline-none"
          >
            {COMMON_DECIMALS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="text-[10px] font-mono text-bp-elements-textTertiary truncate">
            raw = {value}
          </span>
        </div>
      </div>
    </FieldShell>
  );
}

function humanToRaw(human: string, decimals: number): string {
  if (decimals === 0) {
    if (!/^-?\d+$/.test(human)) {
      throw new Error('must be an integer when scale = 0');
    }
    return BigInt(human).toString();
  }
  const negative = human.startsWith('-');
  const stripped = negative ? human.slice(1) : human;
  if (!/^\d+(\.\d+)?$/.test(stripped)) {
    throw new Error('not a valid decimal number');
  }
  const [intPart, fracPart = ''] = stripped.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`max ${decimals} fractional digits`);
  }
  const padded = fracPart.padEnd(decimals, '0');
  const raw = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return (negative ? -raw : raw).toString();
}

function rawToHuman(raw: string, decimals: number): string {
  if (!raw || raw === '0') return '0';
  if (decimals === 0) return raw;
  let big: bigint;
  try {
    big = BigInt(raw);
  } catch {
    return raw;
  }
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const denom = 10n ** BigInt(decimals);
  const intPart = abs / denom;
  const fracPart = abs % denom;
  if (fracPart === 0n) return `${negative ? '-' : ''}${intPart.toString()}`;
  const fracStr = fracPart.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracStr}`;
}

// ── Number / Signed-int / Text / Toggle ──

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (n: number) => void;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  signed?: boolean;
}

export function NumberField({ label, value, onChange, hint, min, max, step, signed }: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const handleChange = (raw: string) => {
    setDraft(raw);
    if (raw.trim().length === 0) {
      setError('required');
      return;
    }
    const pattern = signed ? /^-?\d+$/ : /^\d+$/;
    if (!pattern.test(raw)) {
      setError(signed ? 'must be an integer' : 'must be a non-negative integer');
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setError('not a number');
      return;
    }
    if (min !== undefined && n < min) {
      setError(`must be ≥ ${min}`);
      return;
    }
    if (max !== undefined && n > max) {
      setError(`must be ≤ ${max}`);
      return;
    }
    setError(null);
    onChange(n);
  };

  return (
    <FieldShell label={label} hint={hint} error={error}>
      <Input
        type="text"
        inputMode="numeric"
        value={draft}
        step={step}
        onChange={(e) => handleChange(e.target.value)}
      />
    </FieldShell>
  );
}

interface ToggleFieldProps {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}

export function ToggleField({ label, value, onChange, hint }: ToggleFieldProps) {
  return (
    <FieldShell label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
          value
            ? 'border-violet-500/40 bg-violet-500/10 text-violet-400'
            : 'border-bp-elements-borderColor bg-bp-elements-background-depth-3 text-bp-elements-textSecondary'
        }`}
      >
        <span
          className={`block h-3 w-3 rounded-full transition-colors ${
            value ? 'bg-violet-400' : 'bg-bp-elements-textTertiary'
          }`}
        />
        {value ? 'On' : 'Off'}
      </button>
    </FieldShell>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (s: string) => void;
  hint?: string;
  placeholder?: string;
}

export function TextField({ label, value, onChange, hint, placeholder }: TextFieldProps) {
  return (
    <FieldShell label={label} hint={hint}>
      <Input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

interface SelectFieldProps<T extends string | number> {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ label: string; value: T }>;
  hint?: string;
}

export function SelectField<T extends string | number>({
  label,
  value,
  onChange,
  options,
  hint,
}: SelectFieldProps<T>) {
  const opts = useMemo(() => options, [options]);
  return (
    <FieldShell label={label} hint={hint}>
      <select
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const numeric = opts.find((o) => String(o.value) === raw);
          if (numeric) onChange(numeric.value);
        }}
        className="h-11 rounded-lg px-3.5 py-2.5 text-base bg-bp-elements-background-depth-3 border border-bp-elements-borderColor text-bp-elements-textPrimary outline-none"
      >
        {opts.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
