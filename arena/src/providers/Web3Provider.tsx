import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { ConnectKitProvider, getDefaultConfig } from 'connectkit';
import { type ReactNode, useState } from 'react';
import type { Chain } from 'viem';
import { tangleLocal, tangleTestnet, tangleMainnet, mainnet, rpcUrl } from '~/lib/contracts/chains';

const chains: readonly [Chain, ...Chain[]] = [tangleLocal, tangleTestnet, tangleMainnet, mainnet];

const transports = {
  [tangleLocal.id]: http(rpcUrl),
  [tangleTestnet.id]: http('https://testnet-rpc.tangle.tools'),
  [tangleMainnet.id]: http('https://rpc.tangle.tools'),
  [mainnet.id]: http(),
};

const config = createConfig(
  getDefaultConfig({
    chains,
    transports,
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '3fcc6bba6f1de962d911bb5b5c3dba68',
    appName: 'AI Trading Arena',
    appDescription: 'AI-powered trading competition platform on Tangle Network',
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://arena.tangle.tools',
    appIcon: '/favicon.svg',
  }),
);

export function Web3Provider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="auto"
          mode="auto"
          options={{
            hideBalance: false,
            hideTooltips: false,
            hideQuestionMarkCTA: true,
            overlayBlur: 4,
          }}
        >
          {children}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
