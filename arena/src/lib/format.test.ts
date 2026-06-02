import { describe, expect, it } from 'vitest';
import { formatCompactUsd, formatNumber } from './format';

describe('formatNumber', () => {
  it('caps fraction digits without padding trailing zeroes', () => {
    expect(formatNumber(1, { maximumFractionDigits: 3 })).toBe('1');
    expect(formatNumber(1.2, { maximumFractionDigits: 3 })).toBe('1.2');
    expect(formatNumber(1.2345, { maximumFractionDigits: 3 })).toBe('1.235');
  });

  it('groups large values with a stable locale', () => {
    expect(formatNumber(1234, { maximumFractionDigits: 3 })).toBe('1,234');
  });

  it('normalizes values that round to negative zero', () => {
    expect(formatNumber(-0, { maximumFractionDigits: 2 })).toBe('0');
    expect(formatNumber(-0.004, { maximumFractionDigits: 2 })).toBe('0');
    expect(formatNumber(-0.04, { maximumFractionDigits: 1 })).toBe('0');
  });
});

describe('formatCompactUsd', () => {
  it('formats compact positive USD values and hides missing notional', () => {
    expect(formatCompactUsd(0)).toBe('—');
    expect(formatCompactUsd(Number.NaN)).toBe('—');
    expect(formatCompactUsd(913.123)).toBe('$913.12');
    expect(formatCompactUsd(43_200)).toBe('$43.2K');
    expect(formatCompactUsd(1_250_000)).toBe('$1.25M');
  });
});
