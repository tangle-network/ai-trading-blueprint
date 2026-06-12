import { useContext, useEffect, useState } from 'react';
import { UNSAFE_DataRouterStateContext } from 'react-router';

// Quiet pending indicator for route transitions. React Router keeps the
// current page rendered while the next route's chunk loads, which is correct —
// but on slow links that hold can read as "the click did nothing". After a
// short delay (so fast navigations never flash it) a 2px accent bar appears at
// the top of the content column. Sweep animation is disabled under
// prefers-reduced-motion via .arena-nav-progress in global.scss.
//
// Reads the data-router state context directly (instead of useNavigation) so
// the shell still renders under plain <MemoryRouter> test harnesses, where no
// data router exists and useNavigation would throw.
export function NavigationProgress({ delayMs = 150 }: { delayMs?: number }) {
  const routerState = useContext(UNSAFE_DataRouterStateContext);
  const pending = (routerState?.navigation.state ?? 'idle') !== 'idle';
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [pending, delayMs]);

  if (!visible) return null;

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      className="pointer-events-none absolute inset-x-0 top-0 z-50 h-0.5 overflow-hidden"
    >
      <div className="arena-nav-progress h-full w-full" />
    </div>
  );
}
