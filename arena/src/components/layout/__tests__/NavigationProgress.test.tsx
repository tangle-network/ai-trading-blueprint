import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NavigationProgress } from '../NavigationProgress';

function createDeferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('NavigationProgress', () => {
  it('keeps the previous page rendered during a slow navigation and shows a quiet pending bar', async () => {
    const deferred = createDeferred();
    const router = createMemoryRouter([
      {
        path: '/',
        Component: () => (
          <div>
            <NavigationProgress delayMs={10} />
            <div>home content</div>
            <Link to="/slow">go slow</Link>
          </div>
        ),
      },
      {
        path: '/slow',
        loader: () => deferred.promise,
        Component: () => <div>slow content</div>,
      },
    ]);

    render(<RouterProvider router={router} />);
    expect(screen.getByText('home content')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'go slow' }));

    // Core flicker regression: the navigation suspends IN PLACE — the
    // previous screen must stay painted while the next route loads.
    const bar = await screen.findByRole('progressbar', { name: 'Loading page' });
    expect(bar).toBeInTheDocument();
    expect(screen.getByText('home content')).toBeInTheDocument();
    expect(screen.queryByText('slow content')).not.toBeInTheDocument();

    deferred.resolve(null);

    expect(await screen.findByText('slow content')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  it('renders nothing when idle', () => {
    const router = createMemoryRouter([
      {
        path: '/',
        Component: () => (
          <div>
            <NavigationProgress delayMs={10} />
            <div>home content</div>
          </div>
        ),
      },
    ]);

    render(<RouterProvider router={router} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
