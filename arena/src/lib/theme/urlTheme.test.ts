import { describe, it, expect } from 'vitest';
import { isArenaTheme, readUrlTheme } from './urlTheme';

describe('isArenaTheme', () => {
  it('accepts "light" and "dark" only', () => {
    expect(isArenaTheme('light')).toBe(true);
    expect(isArenaTheme('dark')).toBe(true);
  });

  it('rejects every other value', () => {
    expect(isArenaTheme('Light')).toBe(false);
    expect(isArenaTheme('DARK')).toBe(false);
    expect(isArenaTheme('')).toBe(false);
    expect(isArenaTheme(null)).toBe(false);
    expect(isArenaTheme(undefined)).toBe(false);
    expect(isArenaTheme(0)).toBe(false);
  });
});

describe('readUrlTheme', () => {
  it('extracts theme=light', () => {
    expect(readUrlTheme('?theme=light')).toBe('light');
    expect(readUrlTheme('?mode=default&theme=light&blueprintId=15')).toBe('light');
  });

  it('extracts theme=dark', () => {
    expect(readUrlTheme('?theme=dark')).toBe('dark');
  });

  it('returns null for missing param', () => {
    expect(readUrlTheme('')).toBeNull();
    expect(readUrlTheme('?mode=default')).toBeNull();
  });

  it('returns null for invalid values to avoid silently accepting attacker-supplied strings', () => {
    expect(readUrlTheme('?theme=evil')).toBeNull();
    expect(readUrlTheme('?theme=LIGHT')).toBeNull();
    expect(readUrlTheme('?theme=')).toBeNull();
  });

  it('handles multiple theme params by using the first', () => {
    // URLSearchParams.get() returns the first occurrence — confirm contract.
    expect(readUrlTheme('?theme=light&theme=dark')).toBe('light');
  });

  it('does not throw on malformed input', () => {
    expect(readUrlTheme('?%E0%A4%A')).toBeNull();
  });
});
