type CancelIdle = () => void;

/**
 * Run `callback` when the main thread is idle (with a hard timeout so it
 * always fires), falling back to a timer where requestIdleCallback is
 * unavailable (Safari, jsdom). Returns a cancel function.
 */
export function scheduleIdle(callback: () => void, timeoutMs = 3000): CancelIdle {
  if (typeof window === 'undefined') return () => {};
  // typeof check rather than `in`: jsdom and Safari lack requestIdleCallback
  // even though the DOM lib types declare it unconditionally.
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => callback(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, timeoutMs);
  return () => window.clearTimeout(id);
}

/**
 * Kick off a set of dynamic-import thunks during idle time so the chunks are
 * already in the module cache when a Suspense boundary first asks for them.
 * Failures are swallowed — warming is an optimization, never a dependency;
 * the lazy() boundary that actually needs the module surfaces real errors.
 */
export function warmModulesOnIdle(
  loaders: ReadonlyArray<() => Promise<unknown>>,
  timeoutMs = 3000,
): CancelIdle {
  return scheduleIdle(() => {
    for (const load of loaders) {
      void load().catch(() => {});
    }
  }, timeoutMs);
}

/** Respect explicit data-saver preferences before speculative downloads. */
export function prefersReducedData(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}
