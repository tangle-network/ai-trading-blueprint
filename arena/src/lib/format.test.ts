import { describe, expect, it } from 'vitest';
import { formatNumber } from './format';

describe('formatNumber', () => {
  it('caps fraction digits without padding trailing zeroes', () => {
    expect(formatNumber(1, { maximumFractionDigits: 3 })).toBe('1');
    expect(formatNumber(1.2, { maximumFractionDigits: 3 })).toBe('1.2');
    expect(formatNumber(1.2345, { maximumFractionDigits: 3 })).toBe('1.235');
  });

  it('groups large values with a stable locale', () => {
    expect(formatNumber(1234, { maximumFractionDigits: 3 })).toBe('1,234');
  });
});
