import 'virtual:uno.css';
import '@tangle-network/sandbox-ui/styles';
import './styles/global.scss';

import { AppToaster } from '@tangle-network/blueprint-ui/components';
import { ArenaDocument } from '~/components/layout/ArenaDocument';
import { ArenaAppShell } from '~/components/layout/ArenaAppShell';
import { AppShellFallback } from '~/components/layout/AppShellFallback';
import { MotionProvider } from '~/providers/MotionProvider';
import { TradingSyncProvider } from '~/providers/TradingSyncProvider';
import { useState, useEffect, type ReactNode } from 'react';

// Client-only Web3Provider — connectkit's family package starts async wallet
// connections at module scope that crash Node during SSR, so it must never be
// statically imported here (this module is evaluated in Node at build time to
// prerender the SPA index.html). The import() is hoisted to module scope so
// the chunk download starts as soon as the root bundle evaluates, instead of
// waiting for first render + useEffect.
const web3ProviderModule =
  typeof document === 'undefined' ? null : import('~/providers/Web3Provider');

function ClientWeb3Provider({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<React.ComponentType<{ children: ReactNode }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    web3ProviderModule?.then((m) => {
      if (!cancelled) setProvider(() => m.Web3Provider);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the app chrome painted while the provider chunk loads — returning
  // null here used to blank the entire document for the whole download.
  if (!Provider) return <AppShellFallback />;
  return <Provider>{children}</Provider>;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ArenaDocument description="Tangle Trading - AI agent execution, fills, and portfolio intelligence">
      {children}
    </ArenaDocument>
  );
}

// Prerendered into the SPA index.html (and shown until hydration completes),
// so users see themed app chrome instead of a blank white document while the
// bundle downloads. Must render the same markup on server and client.
export function HydrateFallback() {
  return <AppShellFallback />;
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
