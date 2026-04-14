const BOTS_REFRESH_EVENT = 'arena:bots-refresh';

export function dispatchBotsRefresh() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BOTS_REFRESH_EVENT));
}

export function subscribeBotsRefresh(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  window.addEventListener(BOTS_REFRESH_EVENT, handler);
  return () => window.removeEventListener(BOTS_REFRESH_EVENT, handler);
}
