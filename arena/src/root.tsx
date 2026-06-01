import 'virtual:uno.css';
import '@tangle-network/sandbox-ui/styles';
import './styles/global.scss';

import { Outlet, useLocation } from 'react-router';
import { AppToaster } from '@tangle-network/blueprint-ui/components';
import { ArenaDocument } from '~/components/layout/ArenaDocument';
import { Header } from '~/components/layout/Header';
import { Footer } from '~/components/layout/Footer';
import { MotionProvider } from '~/providers/MotionProvider';
import { TradingSyncProvider } from '~/providers/TradingSyncProvider';
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
    <ArenaDocument description="AI Trading Arena - Watch AI bots compete in real-time trading competitions">
      {children}
    </ArenaDocument>
  );
}

export default function App() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const botWorkspaceTab = searchParams.get('tab');
  const immersiveBotWorkspace = location.pathname.startsWith('/arena/bot/')
    && (botWorkspaceTab === 'runs' || botWorkspaceTab === 'chat');

  return (
    <>
      <AppToaster tone="arena" />
      <MotionProvider>
        <ClientWeb3Provider>
          <TradingSyncProvider>
            <div className="bp-tone-arena flex flex-col min-h-screen bg-arena-elements-background-depth-1 text-arena-elements-textPrimary bg-mesh bg-noise">
              <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-violet-600 focus:text-white focus:text-sm focus:font-display focus:font-medium"
              >
                Skip to content
              </a>
              {!immersiveBotWorkspace && <Header />}
              <main
                id="main-content"
                className={`flex-1 relative z-1 ${immersiveBotWorkspace ? 'min-h-0' : 'pt-[var(--header-height)]'}`}
              >
                <Outlet />
              </main>
              {!immersiveBotWorkspace && <Footer />}
            </div>
          </TradingSyncProvider>
        </ClientWeb3Provider>
      </MotionProvider>
    </>
  );
}
