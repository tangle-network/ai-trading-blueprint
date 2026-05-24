import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';
import { readUrlTheme } from '~/lib/theme/urlTheme';

// localStorage access throws when the iframe is sandboxed without
// `allow-same-origin` — embedding shells sometimes drop this flag for
// hardening. Wrap every access so a throw doesn't abort hydration and leave
// the parent with an empty iframe rectangle.
function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignored */
  }
}

// Migrate localStorage keys from arena_* to bp_* (one-time, before hydration)
const KEY_MIGRATIONS: [string, string][] = [
  ['arena_theme', 'bp_theme'],
  ['arena_tx_history', 'bp_tx_history'],
  ['arena_selected_chain', 'bp_selected_chain'],
];
for (const [oldKey, newKey] of KEY_MIGRATIONS) {
  const oldValue = safeLocalStorageGet(oldKey);
  if (!safeLocalStorageGet(newKey) && oldValue) {
    safeLocalStorageSet(newKey, oldValue);
  }
}

// Parent-shell theme contract: if the embedding dapp set `?theme=light|dark`,
// persist it before the blueprint-ui themeStore initialises. The inline
// `inlineThemeBootScript` already wrote this same value during HTML parse —
// repeat it here so that an SPA route change after init (where the bundle is
// hot but the query string may have changed) still wins over stale storage.
const urlTheme = readUrlTheme(window.location.search);
if (urlTheme) {
  safeLocalStorageSet('bp_theme', urlTheme);
  document.querySelector('html')?.setAttribute('data-theme', urlTheme);
}

// Trigger configureNetworks() side effect
import('~/lib/contracts/chains');

startTransition(() => {
  hydrateRoot(document, <HydratedRouter />);
});
