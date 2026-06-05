import { describe, expect, it } from 'vitest';
import { resolveTradingBlueprintId } from './ids';

describe('resolveTradingBlueprintId', () => {
  it('uses the configured blueprint id when it is non-zero', () => {
    expect(resolveTradingBlueprintId('42', '1')).toBe('42');
  });

  it('falls back when deployment env is missing, blank, or explicitly zero', () => {
    expect(resolveTradingBlueprintId(undefined, '1')).toBe('1');
    expect(resolveTradingBlueprintId('', '2')).toBe('2');
    expect(resolveTradingBlueprintId('0', '3')).toBe('3');
  });
});
