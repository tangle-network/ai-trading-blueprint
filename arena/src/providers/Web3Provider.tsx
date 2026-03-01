import { createConfig } from 'wagmi';
import { ConnectKitProvider, getDefaultConfig } from 'connectkit';
import { type ReactNode } from 'react';
import {
  createTangleTransports,
  defaultConnectKitOptions,
  tangleWalletChains,
} from '@tangle/blueprint-ui';
import { Web3Shell } from '@tangle/blueprint-ui/components';

const config = createConfig(
  getDefaultConfig({
    chains: tangleWalletChains,
    transports: createTangleTransports(),
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '3fcc6bba6f1de962d911bb5b5c3dba68',
    appName: 'AI Trading Arena',
    appDescription: 'AI-powered trading competition platform on Tangle Network',
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://arena.tangle.tools',
    appIcon: '/favicon.svg',
  }),
);

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <Web3Shell config={config}>
      <ConnectKitProvider theme="auto" mode="auto" options={defaultConnectKitOptions}>
        {children}
      </ConnectKitProvider>
    </Web3Shell>
  );
}
