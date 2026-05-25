// MIRROR of ai-agent-sandbox-blueprint/ui/src/lib/wallet/parentBridgeConnector.ts.
// Both products embed in the same Tangle Cloud parent under the same
// iframe protocol. Consolidate into @tangle-network/blueprint-ui next.
//
// Wagmi connector that proxies wallet operations to the Tangle Cloud parent
// dapp via the iframe postMessage bridge. Becomes the autoConnect target
// when this app is loaded inside an iframe sandbox without a window.ethereum
// — i.e. always, when embedded by cloud.tangle.tools.
//
// Architecture: the connector owns one `ParentBridgeProvider` (singleton),
// forwards every wagmi method to it, and reflects the provider's EIP-1193
// events back to wagmi's emitter so the rest of the dapp (ConnectKit's
// account chip, hooks like useAccount/useChainId) reacts to parent-state
// changes without polling.

import type { Address, Chain } from 'viem';
import { createConnector } from 'wagmi';

import { ParentBridgeProvider, type ParentBridgeOptions } from './parentBridgeProvider';

export type ParentBridgeConnectorOptions = ParentBridgeOptions;

export function parentBridgeConnector(options: ParentBridgeConnectorOptions) {
  let provider: ParentBridgeProvider | undefined;
  let installed = false;

  return createConnector<ParentBridgeProvider>((config) => {
    const ensureProvider = (): ParentBridgeProvider => {
      if (!provider) provider = new ParentBridgeProvider(options);
      if (!installed) {
        provider.install();
        installed = true;
        // Wire the provider's EIP-1193 events to wagmi's emitter so
        // ConnectKit and useAccount/useChainId reflect parent-state changes
        // without polling.
        provider.on('accountsChanged', (accounts) => {
          config.emitter.emit('change', {
            accounts: Array.isArray(accounts)
              ? (accounts as readonly Address[])
              : ([] as readonly Address[]),
          });
        });
        provider.on('chainChanged', (chainIdHex) => {
          const chainId =
            typeof chainIdHex === 'string'
              ? Number.parseInt(chainIdHex, 16)
              : Number(chainIdHex);
          if (Number.isFinite(chainId)) {
            config.emitter.emit('change', { chainId });
          }
        });
        provider.on('disconnect', () => {
          config.emitter.emit('disconnect');
        });
      }
      return provider;
    };

    return {
      id: 'tangleParentBridge',
      name: 'Tangle Cloud',
      type: 'parentBridge',

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async connect(): Promise<any> {
        // wagmi v3's connect() return type is a conditional based on
        // `withCapabilities`. We always return plain addresses; cast through
        // `any` rather than re-implementing the type predicate.
        const p = ensureProvider();
        const accountsResult = (await p.request({
          method: 'eth_requestAccounts',
        })) as readonly Address[];
        const chainIdHex = (await p.request({ method: 'eth_chainId' })) as string;
        const chainId = Number.parseInt(chainIdHex, 16);
        return {
          accounts: accountsResult,
          chainId: Number.isFinite(chainId) ? chainId : 0,
        };
      },

      async disconnect() {
        // Disconnect from the iframe's perspective is a local-only state
        // reset — we can't ask the parent dapp to disconnect its wallet on
        // our behalf, and a real disconnect should be initiated from the
        // parent's UI. Tear down listeners + the message bridge so a future
        // reconnect re-handshakes cleanly.
        if (provider) provider.uninstall();
        installed = false;
        provider = undefined;
      },

      async getAccounts() {
        const p = ensureProvider();
        const cached = p.getCachedAccount();
        if (cached) return [cached];
        const accounts = (await p.request({
          method: 'eth_accounts',
        })) as readonly Address[];
        return accounts;
      },

      async getChainId() {
        const p = ensureProvider();
        const cached = p.getCachedChainId();
        if (cached !== null) return cached;
        const chainIdHex = (await p.request({ method: 'eth_chainId' })) as string;
        const chainId = Number.parseInt(chainIdHex, 16);
        return Number.isFinite(chainId) ? chainId : 0;
      },

      async getProvider() {
        return ensureProvider();
      },

      async isAuthorized() {
        // Always authorized when in iframe mode — the parent dapp has
        // already gated access by being the embedder. Returning `true`
        // makes wagmi auto-reconnect on every page load, which is the
        // right UX (iframe → parent wallet is always-on).
        try {
          const p = ensureProvider();
          const accounts = (await p.request({
            method: 'eth_accounts',
          })) as readonly Address[];
          return accounts.length > 0;
        } catch {
          return false;
        }
      },

      async switchChain({ chainId }): Promise<Chain> {
        const p = ensureProvider();
        await p.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${chainId.toString(16)}` }],
        });
        const chain = config.chains.find((c) => c.id === chainId);
        if (!chain) {
          throw new Error(`Chain ${chainId} not configured for this app`);
        }
        return chain;
      },

      onAccountsChanged(accounts) {
        config.emitter.emit('change', {
          accounts: accounts as readonly Address[],
        });
      },
      onChainChanged(chainIdHex) {
        const chainId = Number.parseInt(chainIdHex, 16);
        if (Number.isFinite(chainId)) {
          config.emitter.emit('change', { chainId });
        }
      },
      onDisconnect() {
        config.emitter.emit('disconnect');
      },
    };
  });
}
