import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

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

// Trigger configureNetworks() side effect
import('~/lib/contracts/chains');

startTransition(() => {
  hydrateRoot(document, <HydratedRouter />);
});
