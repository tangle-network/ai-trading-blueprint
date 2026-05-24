// URL theme contract: parent shells (e.g. Tangle Cloud) embed the arena iframe
// with `?theme=light|dark` on every load. The iframe must apply that theme
// before first paint so the user never sees a dark-mode panel inside a
// light-mode shell (or vice versa). When the user toggles theme INSIDE the
// iframe, their toggle persists for that session — a fresh parent load will
// arrive with a new `?theme=` and override it. No postMessage handshake.
//
// The persistence layer is the existing `bp_theme` localStorage key used by
// blueprint-ui's themeStore. Writing the URL theme to that key on first paint
// ensures themeStore initialises with the parent-intended theme.

export type ArenaTheme = 'light' | 'dark';

export const THEME_STORAGE_KEYS = ['bp_theme', 'arena_theme'] as const;

export function isArenaTheme(value: unknown): value is ArenaTheme {
  return value === 'light' || value === 'dark';
}

export function readUrlTheme(search: string): ArenaTheme | null {
  if (!search) return null;
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('theme');
    return isArenaTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Inline-script source used by ArenaDocument. Must be a self-contained IIFE —
// it runs before the React bundle loads, so it cannot reference module imports
// or share scope. Kept in sync with the helpers above.
export const inlineThemeBootScript = `
(function () {
  try {
    var theme = null;
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('theme');
      if (raw === 'light' || raw === 'dark') {
        theme = raw;
        localStorage.setItem('bp_theme', theme);
      }
    } catch (_urlErr) {}
    if (!theme) {
      theme = localStorage.getItem('bp_theme') || localStorage.getItem('arena_theme');
    }
    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.querySelector('html').setAttribute('data-theme', theme);
  } catch (_err) {
    document.querySelector('html').setAttribute('data-theme', 'dark');
  }
})();
`;
