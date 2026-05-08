import '@testing-library/jest-dom/vitest';

// Some upstream UI components (notably @tangle-network/blueprint-ui's Identicon)
// were transpiled with the classic JSX runtime expecting a global `React` symbol.
// Vite's automatic JSX runtime doesn't inject one, so test renders fail with
// `ReferenceError: React is not defined`. Provide a global shim so those
// components mount in jsdom without forcing every consumer to wrap them.
import * as React from 'react';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).React = React;
