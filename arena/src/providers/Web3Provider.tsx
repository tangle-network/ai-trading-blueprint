import { createConfig } from 'wagmi';
import { ConnectKitProvider, getDefaultConfig } from 'connectkit';
import { type ReactNode } from 'react';
import type { Chain } from 'viem';
import { defaultConnectKitOptions, getTangleWalletChains } from '@tangle-network/blueprint-ui';
import { Web3Shell } from '@tangle-network/blueprint-ui/components';
import {
  executionForkChain,
  hyperEvmMainnet,
  hyperEvmMainnetConfigured,
  hyperEvmTestnet,
  hyperEvmTestnetConfigured,
  tangleLocal,
} from '~/lib/contracts/chains';
import { http } from 'wagmi';
import {
  detectTangleCloudParentOrigin,
  parentBridgeConnector,
} from '@tangle-network/blueprint-ui/wallet';

function isLocalRpcUrl(rpcUrl: string | undefined): boolean {
  if (!rpcUrl) return false;
  try {
    const { hostname } = new URL(rpcUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1';
  } catch {
    return false;
  }
}

function dedupeChains(chains: readonly Chain[]): readonly [Chain, ...Chain[]] {
  const seen = new Set<number>();
  const unique = chains.filter((chain) => {
    if (seen.has(chain.id)) return false;
    seen.add(chain.id);
    return true;
  });

  return unique as [Chain, ...Chain[]];
}

function getArenaWalletChains(): readonly [Chain, ...Chain[]] {
  const tangleChains = getTangleWalletChains(tangleLocal);
  const executionForkRpc = executionForkChain.rpcUrls.default.http[0];
  const shouldIncludeLocalExecutionFork =
    import.meta.env.VITE_USE_LOCAL_CHAIN === 'true' &&
    import.meta.env.VITE_DEX_ETHEREUM_ENABLED !== 'false' &&
    executionForkChain.id !== tangleLocal.id &&
    isLocalRpcUrl(executionForkRpc);

  return dedupeChains([
    tangleLocal,
    ...(shouldIncludeLocalExecutionFork ? [executionForkChain] : []),
    ...(hyperEvmTestnetConfigured ? [hyperEvmTestnet] : []),
    ...(hyperEvmMainnetConfigured ? [hyperEvmMainnet] : []),
    ...tangleChains.slice(1),
  ]);
}

const walletChains = getArenaWalletChains();

// Detect Tangle Cloud iframe context once at module load. The detection reads
// `document.referrer` + `window.location` — stable for the iframe's lifetime.
// Thread `VITE_TANGLE_CLOUD_ORIGINS` (comma-separated) into the library's
// origin allowlist. The library doesn't read `import.meta.env` itself so it
// stays bundler-agnostic; the app injects what its env can resolve.
const EXTRA_PARENT_ORIGINS = (
  import.meta.env.VITE_TANGLE_CLOUD_ORIGINS as string | undefined
)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PARENT_ORIGIN = detectTangleCloudParentOrigin({
  extraOrigins: EXTRA_PARENT_ORIGINS,
});
export const isEmbeddedInTangleCloud = PARENT_ORIGIN !== null;

const baseDefaultConfig = getDefaultConfig({
  chains: walletChains,
  transports: Object.fromEntries(walletChains.map((chain) => [chain.id, http(chain.rpcUrls.default.http[0])])),
  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '3fcc6bba6f1de962d911bb5b5c3dba68',
  appName: 'AI Trading Arena',
  appDescription: 'AI-powered trading competition platform on Tangle Network',
  appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://arena.tangle.tools',
  appIcon: '/favicon.svg',
});

// When embedded by Tangle Cloud, replace the injected/WalletConnect/Coinbase
// connectors with the parent-bridge connector. Browser-extension and popup
// connectors don't work inside the sandboxed iframe (no window.ethereum
// injection, no popup permission), so surfacing them in ConnectKit's modal
// would only confuse operators. The bridge connector auto-connects via
// `isAuthorized() === true`, so the iframe inherits the parent dapp's
// wallet without a separate wallet picker.
const config =
  PARENT_ORIGIN !== null
    ? createConfig({
        ...baseDefaultConfig,
        connectors: [
          parentBridgeConnector({
            parentOrigin: PARENT_ORIGIN,
            appId: 'trading-arena',
          }),
        ],
      })
    : createConfig(baseDefaultConfig);

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <Web3Shell config={config}>
      <ConnectKitProvider theme="auto" mode="auto" options={defaultConnectKitOptions}>
        {children}
      </ConnectKitProvider>
    </Web3Shell>
  );
}
