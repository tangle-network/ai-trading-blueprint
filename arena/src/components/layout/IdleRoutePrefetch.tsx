import { useEffect, useState } from 'react';
import { PrefetchPageLinks } from 'react-router';
import { prefersReducedData, scheduleIdle } from '~/lib/utils/idleWarm';

// Most-traveled routes, warmed after the current page settles. Emits
// <link rel="modulepreload"> for each page's route chunks (SPA mode has no
// loaders, so this is module-only — no data requests). First click on a
// primary nav item then resolves from the module cache instead of the network.
// '/arena/bot/_/performance' matches the bot-detail pattern so the workspace
// chunk is warm before any agent row is opened.
const PREFETCH_PAGES = [
  '/',
  '/leaderboard',
  '/activity',
  '/observatory',
  '/operators',
  '/dashboard',
  '/create',
  '/arena/bot/_/performance',
] as const;

export function IdleRoutePrefetch() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (prefersReducedData()) return;
    return scheduleIdle(() => setReady(true), 4000);
  }, []);

  // PrefetchPageLinks needs the framework manifest, which only exists when the
  // app boots through HydratedRouter (window.__reactRouterContext is set by
  // the generated index.html). Plain data/memory routers — test harnesses —
  // have nothing to prefetch.
  if (typeof window === 'undefined' || !('__reactRouterContext' in window)) return null;
  if (!ready) return null;

  return (
    <>
      {PREFETCH_PAGES.map((page) => (
        <PrefetchPageLinks key={page} page={page} />
      ))}
    </>
  );
}
