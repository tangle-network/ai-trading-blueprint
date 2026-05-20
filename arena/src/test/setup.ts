import '@testing-library/jest-dom/vitest';

// Some upstream UI components (notably @tangle-network/blueprint-ui's Identicon)
// were transpiled with the classic JSX runtime expecting a global `React` symbol.
// Vite's automatic JSX runtime doesn't inject one, so test renders fail with
// `ReferenceError: React is not defined`. Provide a global shim so those
// components mount in jsdom without forcing every consumer to wrap them.
import * as React from 'react';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).React = React;

const createStorageShim = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
};

// Node 26 exposes experimental web-storage hooks, but Vitest/jsdom may still
// leave bare `localStorage` undefined while upstream packages read it at import.
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createStorageShim(),
  });
}
