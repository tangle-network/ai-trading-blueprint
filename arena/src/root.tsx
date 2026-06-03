import 'virtual:uno.css';
import '@tangle-network/sandbox-ui/styles';
import './styles/global.scss';

import { AppToaster } from '@tangle-network/blueprint-ui/components';
import { ArenaDocument } from '~/components/layout/ArenaDocument';
import { ArenaAppShell } from '~/components/layout/ArenaAppShell';
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
    <ArenaDocument description="Tangle Trading - AI agent execution, fills, and portfolio intelligence">
      {children}
    </ArenaDocument>
  );
}

export default function App() {
  return (
    <>
      <AppToaster tone="arena" />
      <MotionProvider>
        <ClientWeb3Provider>
          <TradingSyncProvider>
            <ArenaAppShell />
          </TradingSyncProvider>
        </ClientWeb3Provider>
      </MotionProvider>
    </>
  );
}
