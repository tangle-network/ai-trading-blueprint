import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShellFallback } from '../AppShellFallback';

describe('AppShellFallback', () => {
  it('renders themed app chrome instead of a blank document', () => {
    render(<AppShellFallback />);

    const shell = screen.getByTestId('app-shell-fallback');
    // The fallback must paint the brand background token — this is what
    // replaces the white screen while the bundle / Web3Provider chunk loads.
    expect(shell.className).toContain('bg-[var(--arena-terminal-bg)]');
    expect(shell.className).toContain('h-[100dvh]');
    // Chrome geometry mirrors the real shell so hydration does not jump.
    expect(shell.querySelector('aside')).not.toBeNull();
    expect(shell.querySelector('main')).not.toBeNull();
  });

  it('stays quiet: no spinners, no progressbars, no fake readiness states', () => {
    render(<AppShellFallback />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('is hook-free static markup (safe for build-time prerendering)', () => {
    // Rendering twice must produce identical markup — no client-only state.
    const first = render(<AppShellFallback />);
    const html = first.container.innerHTML;
    first.unmount();
    const second = render(<AppShellFallback />);
    expect(second.container.innerHTML).toBe(html);
  });
});
