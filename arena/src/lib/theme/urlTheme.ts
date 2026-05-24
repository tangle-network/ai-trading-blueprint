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
//
// Also installs an in-memory localStorage shim when the real localStorage
// throws on access. This happens when the embedding parent (e.g. Tangle Cloud
// dapp) loads the iframe with `sandbox="allow-scripts allow-forms"` and omits
// `allow-same-origin` — every `localStorage.getItem` then throws a
// SecurityError synchronously and any module that touches storage during eval
// (notably blueprint-ui's themeStore) fails to load. The shim restores normal
// semantics for the current document so hydration proceeds; values do not
// persist across reloads, which is acceptable because the parent reloads the
// iframe with a fresh `?theme=` on every state change anyway.
export const inlineThemeBootScript = `
(function () {
  try {
    // localStorage shim — only installs when the real one throws.
    // Probe BOTH getItem and setItem because some browsers throw only on
    // mutation (private-mode Safari historically; Firefox's "block cookies"
    // setting); the sandboxed-iframe case typically throws on either.
    var needsShim = false;
    try {
      window.localStorage.getItem('__bp_probe__');
      window.localStorage.setItem('__bp_probe__', '1');
      window.localStorage.removeItem('__bp_probe__');
    } catch (_probeErr) {
      needsShim = true;
    }
    if (needsShim) {
      var memory = {};
      var shim = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
        setItem: function (k, v) { memory[k] = String(v); },
        removeItem: function (k) { delete memory[k]; },
        clear: function () { memory = {}; },
        key: function (i) { return Object.keys(memory)[i] || null; },
      };
      Object.defineProperty(shim, 'length', { get: function () { return Object.keys(memory).length; } });
      try {
        Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
        Object.defineProperty(window, 'sessionStorage', { value: shim, configurable: true });
      } catch (_defErr) {}
    }

    var theme = null;
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('theme');
      if (raw === 'light' || raw === 'dark') {
        theme = raw;
        try { localStorage.setItem('bp_theme', theme); } catch (_setErr) {}
      }
    } catch (_urlErr) {}
    if (!theme) {
      try {
        theme = localStorage.getItem('bp_theme') || localStorage.getItem('arena_theme');
      } catch (_getErr) {}
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
