import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';
import { readUrlTheme } from '~/lib/theme/urlTheme';

// Migrate localStorage keys from arena_* to bp_* (one-time, before hydration)
const KEY_MIGRATIONS: [string, string][] = [
  ['arena_theme', 'bp_theme'],
  ['arena_tx_history', 'bp_tx_history'],
  ['arena_selected_chain', 'bp_selected_chain'],
];
for (const [oldKey, newKey] of KEY_MIGRATIONS) {
  if (!localStorage.getItem(newKey) && localStorage.getItem(oldKey)) {
    localStorage.setItem(newKey, localStorage.getItem(oldKey)!);
  }
}

// Parent-shell theme contract: if the embedding dapp set `?theme=light|dark`,
// persist it before the blueprint-ui themeStore initialises. The inline
// `inlineThemeBootScript` already wrote this same value during HTML parse —
// repeat it here so that an SPA route change after init (where the bundle is
// hot but the query string may have changed) still wins over stale storage.
const urlTheme = readUrlTheme(window.location.search);
if (urlTheme) {
  localStorage.setItem('bp_theme', urlTheme);
  document.querySelector('html')?.setAttribute('data-theme', urlTheme);
}

// Trigger configureNetworks() side effect
import('~/lib/contracts/chains');

startTransition(() => {
  hydrateRoot(document, <HydratedRouter />);
});
