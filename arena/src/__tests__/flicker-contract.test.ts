// Regression contract for the navigation-flicker fixes. These assertions are
// deliberately source-level where runtime rendering would drag in
// virtual:uno.css / connectkit: they pin the invariants that, if dropped,
// silently reintroduce white-screen flashes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// vitest sets css:false, which empties .scss imports (even ?raw), so source
// contracts are read straight from disk. import.meta.dirname needs the node
// types that arena's tsconfig now includes.
const src = (rel: string) =>
  readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

describe('root shell contract', () => {
  const root = src('root.tsx');

  it('exports a HydrateFallback so the SPA index.html prerenders themed chrome', () => {
    expect(root).toMatch(/export function HydrateFallback\(\)/);
    expect(root).toMatch(/HydrateFallback\(\)\s*{\s*return <AppShellFallback \/>;/);
  });

  it('never blanks the document while the Web3Provider chunk loads', () => {
    expect(root).not.toMatch(/if \(!Provider\) return null/);
    expect(root).toMatch(/if \(!Provider\) return <AppShellFallback \/>;/);
  });

  it('keeps Web3Provider out of the build-time module graph (SSR-safe guard)', () => {
    expect(root).toMatch(/typeof document === 'undefined'\s*\?\s*null\s*:\s*import\('~\/providers\/Web3Provider'\)/);
  });
});

describe('document chrome contract', () => {
  it('ArenaDocument inlines the critical theme CSS ahead of the stylesheet', () => {
    const doc = src('components/layout/ArenaDocument.tsx');
    expect(doc).toContain('criticalThemeCss');
    // Inline <style> must come before <Links /> so it wins the first paint.
    expect(doc.indexOf('criticalThemeCss }}')).toBeLessThan(doc.indexOf('<Links />'));
  });

  it('html paints the theme background in the base stylesheet', () => {
    const styles = src('styles/global.scss');
    expect(styles).toMatch(/html\s*{[^}]*background:\s*var\(--arena-terminal-bg\)/s);
  });

  it('navigation progress sweep is disabled under prefers-reduced-motion', () => {
    const styles = src('styles/global.scss');
    const reducedMotion = styles.match(/@media \(prefers-reduced-motion: reduce\) {[^]*?\n}/);
    expect(reducedMotion).not.toBeNull();
    expect(reducedMotion![0]).toContain('.arena-nav-progress');
    expect(reducedMotion![0]).toContain('animation: none');
  });
});
