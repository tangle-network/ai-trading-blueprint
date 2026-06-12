// Static replica of the app chrome geometry (sidebar rail + header strip).
// Rendered in two blank-prone windows:
//   1. As the root HydrateFallback — react-router prerenders it into the SPA
//      index.html, so the first paint is themed chrome instead of an empty
//      white document while the JS bundle downloads and hydrates.
//   2. While the client-only Web3Provider chunk loads (see root.tsx), so the
//      document never collapses back to a blank canvas after hydration.
// Must stay hook-free and SSR-safe: it is evaluated at build time in Node.
// No spinners, no fake nav items — quiet chrome only.
export function AppShellFallback() {
  return (
    <div
      data-testid="app-shell-fallback"
      className="bp-tone-arena arena-trace-terminal flex h-[100dvh] overflow-hidden bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]"
    >
      <aside
        aria-hidden="true"
        className="hidden w-60 shrink-0 flex-col border-r border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] lg:flex"
      >
        <div className="flex h-14 shrink-0 items-center border-b border-[var(--arena-terminal-border)] px-3">
          <span className="inline-flex h-8 w-8 items-center justify-center overflow-hidden">
            <img src="/tangle-mark.svg" alt="" className="h-full w-full object-contain" />
          </span>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-14 shrink-0 border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] lg:bg-[var(--arena-terminal-bg)]" />
        <main className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
