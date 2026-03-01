import 'virtual:uno.css';
import './styles/global.scss';

import { Outlet } from 'react-router';
import { AppDocument, AppToaster } from '@tangle/blueprint-ui/components';
import { Header } from '~/components/layout/Header';
import { Footer } from '~/components/layout/Footer';
import { MotionProvider } from '~/providers/MotionProvider';
import { useState, useEffect, type ReactNode } from 'react';

// Client-only wrapper for Web3Provider — connectkit's family package starts
// async wallet connections at module scope that crash Node during SSR.
// Dynamic import ensures it's never evaluated server-side.
function ClientWeb3Provider({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<React.ComponentType<{ children: ReactNode }> | null>(null);

  useEffect(() => {
    import('~/providers/Web3Provider').then((m) => setProvider(() => m.Web3Provider));
  }, []);

  if (!Provider) return null;
  return <Provider>{children}</Provider>;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppDocument
      description="AI Trading Arena - Watch AI bots compete in real-time trading competitions"
      themeStorageKeys={['bp_theme', 'arena_theme']}
    >
      {children}
    </AppDocument>
  );
}

export default function App() {
  return (
    <>
      <AppToaster tone="arena" />
      <MotionProvider>
        <ClientWeb3Provider>
          <div className="flex flex-col min-h-screen bg-arena-elements-background-depth-1 text-arena-elements-textPrimary bg-mesh bg-noise">
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-violet-600 focus:text-white focus:text-sm focus:font-display focus:font-medium"
            >
              Skip to content
            </a>
            <Header />
            <main id="main-content" className="flex-1 pt-[var(--header-height)] relative z-1">
              <Outlet />
            </main>
            <Footer />
          </div>
        </ClientWeb3Provider>
      </MotionProvider>
    </>
  );
}
