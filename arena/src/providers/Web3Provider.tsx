import { createConfig } from 'wagmi';
import { ConnectKitProvider, getDefaultConfig } from 'connectkit';
import { type ReactNode } from 'react';
import type { Chain } from 'viem';
import { defaultConnectKitOptions } from '@tangle-network/blueprint-ui';
import { Web3Shell } from '@tangle-network/blueprint-ui/components';
import {
  executionForkChain,
  networks,
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

// The wallet-switchable chain set is derived from the SAME `networks` map the
// network selector (`selectedChainIdStore`) reads from. Previously this was a
// hardcoded Tangle-only list (getTangleWalletChains → local/testnet/mainnet/eth)
// that omitted Base Sepolia and HyperEVM even though they're configured + offered
// in the selector — so `switchChain(84532)` was rejected by the connector ("chain
// not configured"), stranding the wallet on chain 31337. Sourcing both from
// `networks` makes every selectable network wallet-switchable, by construction.
function getArenaWalletChains(): readonly [Chain, ...Chain[]] {
  const localChainEnabled = import.meta.env.VITE_USE_LOCAL_CHAIN === 'true';
  const configuredChains = Object.values(networks).map((n) => n.chain);
  const executionForkRpc = executionForkChain.rpcUrls.default.http[0];
  const shouldIncludeLocalExecutionFork =
    localChainEnabled &&
    import.meta.env.VITE_DEX_ETHEREUM_ENABLED !== 'false' &&
    executionForkChain.id !== tangleLocal.id &&
    isLocalRpcUrl(executionForkRpc);

  return dedupeChains([
    ...(localChainEnabled ? [tangleLocal] : []),
    ...(shouldIncludeLocalExecutionFork ? [executionForkChain] : []),
    ...configuredChains,
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

// Some viem chains ship a browser-hostile default RPC. Notably Ethereum
// mainnet defaults to https://eth.merkle.io, which sends no
// Access-Control-Allow-Origin header, so every browser read is blocked by CORS.
// Override those chains with a CORS-enabled public endpoint (env-overridable).
const CORS_SAFE_RPC: Record<number, string> = {
  1: import.meta.env.VITE_ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
};

const baseDefaultConfig = getDefaultConfig({
  chains: walletChains,
  transports: Object.fromEntries(
    walletChains.map((chain) => [
      chain.id,
      http(CORS_SAFE_RPC[chain.id] ?? chain.rpcUrls.default.http[0]),
    ]),
  ),
  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '3fcc6bba6f1de962d911bb5b5c3dba68',
  appName: 'Tangle Trading',
  appDescription: 'AI agent execution, fills, and portfolio intelligence on Tangle Network',
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
