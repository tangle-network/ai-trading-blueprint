import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedData, scheduleIdle, warmModulesOnIdle } from './idleWarm';

describe('scheduleIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to a timer when requestIdleCallback is unavailable', () => {
    const callback = vi.fn();
    scheduleIdle(callback, 500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('returns a working cancel function', () => {
    const callback = vi.fn();
    const cancel = scheduleIdle(callback, 500);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('uses requestIdleCallback when available', () => {
    const ric = vi.fn(() => 1);
    const cancelRic = vi.fn();
    (window as any).requestIdleCallback = ric;
    (window as any).cancelIdleCallback = cancelRic;
    try {
      const cancel = scheduleIdle(() => {}, 700);
      expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 700 });
      cancel();
      expect(cancelRic).toHaveBeenCalledWith(1);
    } finally {
      delete (window as any).requestIdleCallback;
      delete (window as any).cancelIdleCallback;
    }
  });
});

describe('warmModulesOnIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes every loader once idle fires and swallows rejections', async () => {
    const ok = vi.fn(() => Promise.resolve('module'));
    const fail = vi.fn(() => Promise.reject(new Error('offline')));
    warmModulesOnIdle([ok, fail], 100);
    vi.advanceTimersByTime(100);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
    // Rejection must not surface as an unhandled error.
    await vi.runAllTimersAsync();
  });
});

describe('prefersReducedData', () => {
  it('is false when the connection API is absent', () => {
    expect(prefersReducedData()).toBe(false);
  });

  it('is true when saveData is set', () => {
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });
    try {
      expect(prefersReducedData()).toBe(true);
    } finally {
      delete (navigator as any).connection;
    }
  });
});
