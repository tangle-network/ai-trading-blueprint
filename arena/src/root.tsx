import 'virtual:uno.css';
import './styles/global.scss';

import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { Toaster } from 'sonner';
import { useThemeValue } from '@tangle/blueprint-ui';
import { Header } from '~/components/layout/Header';
import { Footer } from '~/components/layout/Footer';
import { MotionProvider } from '~/providers/MotionProvider';
import { useState, useEffect, type ReactNode } from 'react';

const inlineThemeCode = `
  (function() {
    var theme = localStorage.getItem('bp_theme') || localStorage.getItem('arena_theme');
    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.querySelector('html').setAttribute('data-theme', theme);
  })();
`;

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
    <html lang="en" data-theme="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="AI Trading Arena - Watch AI bots compete in real-time trading competitions" />
        <Meta />
        <Links />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&family=Outfit:wght@400;500;600;700;800;900&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const theme = useThemeValue();

  return (
    <>
      <Toaster
        position="bottom-right"
        theme={theme as 'light' | 'dark' | 'system'}
        richColors
        closeButton
        duration={3000}
        toastOptions={{
          style: {
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--glass-border)',
            color: 'var(--arena-elements-textPrimary)',
          },
        }}
      />
      <MotionProvider>
        <ClientWeb3Provider>
          <div className="flex flex-col min-h-screen bg-arena-elements-background-depth-1 text-arena-elements-textPrimary bg-mesh bg-noise">
            <Header />
            <main className="flex-1 pt-[var(--header-height)] relative z-1">
              <Outlet />
            </main>
            <Footer />
          </div>
        </ClientWeb3Provider>
      </MotionProvider>
    </>
  );
}
