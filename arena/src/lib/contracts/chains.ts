import type { Address } from 'viem';
import { defineChain } from 'viem';
import {
  tangleLocal as sharedTangleLocal,
  tangleTestnet,
  tangleMainnet,
  rpcUrl,
  configureNetworks,
  getNetworks,
  type CoreAddresses,
} from '@tangle-network/blueprint-ui';

const forkMode = import.meta.env.VITE_FORK_MODE === 'true';
const executionForkChainId = Number(import.meta.env.VITE_DEX_ETHEREUM_CHAIN_ID ?? sharedTangleLocal.id);
const executionForkRpcUrl = import.meta.env.VITE_DEX_ETHEREUM_RPC_URL ?? rpcUrl;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function isLocalRpcUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1';
  } catch {
    return false;
  }
}

const includeLocalExecutionFork =
  import.meta.env.VITE_USE_LOCAL_CHAIN === 'true' &&
  import.meta.env.VITE_DEX_ETHEREUM_ENABLED !== 'false' &&
  executionForkChainId !== sharedTangleLocal.id &&
  isLocalRpcUrl(executionForkRpcUrl);

export const executionForkChain = defineChain({
  id: executionForkChainId,
  name: 'Ethereum Local Fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [executionForkRpcUrl] } },
  blockExplorers: { default: { name: 'Explorer', url: '' } },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const tangleLocal = forkMode ? executionForkChain : sharedTangleLocal;

// ─────────────────────────────────────────────────────────────────────────────
// Real-chain definitions for envelope-v3 cross-chain support.
//
// Vault deployments on each chain are authored by `DeployEnvelopeV3.s.sol`,
// which writes addresses to `deployments/{chainId}/v3.json`. The per-chain
// `VITE_TRADE_VALIDATOR_<chain>` and `VITE_TRADING_VAULT_<chain>` env vars
// override the placeholder defaults below; chains without a deployment yet
// stay at the zero address (rendered as a non-clickable disabled state in UI).
//
// Chain IDs:
//   1     — Ethereum mainnet
//   42161 — Arbitrum One
//   8453  — Base mainnet
//   84532 — Base Sepolia
// ─────────────────────────────────────────────────────────────────────────────

export const ethereumMainnet = defineChain({
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ETHEREUM_RPC_URL ?? 'https://eth.llamarpc.com'],
    },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://etherscan.io' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const arbitrumOne = defineChain({
  id: 42161,
  name: 'Arbitrum One',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc'],
    },
  },
  blockExplorers: { default: { name: 'Arbiscan', url: 'https://arbiscan.io' } },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const baseMainnet = defineChain({
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_BASE_RPC_URL ?? 'https://mainnet.base.org'],
    },
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://basescan.org' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const baseSepolia = defineChain({
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'],
    },
  },
  blockExplorers: {
    default: { name: 'BaseScan Sepolia', url: 'https://sepolia.basescan.org' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

const hyperEvmTestnetEnabled = import.meta.env.VITE_HYPEREVM_TESTNET_ENABLED === 'true';
const hyperEvmTestnetChainId = Number(import.meta.env.VITE_HYPEREVM_TESTNET_CHAIN_ID ?? 998);
const hyperEvmTestnetRpcUrl =
  import.meta.env.VITE_HYPEREVM_TESTNET_RPC_URL ?? 'https://rpc.hyperliquid-testnet.xyz/evm';

export const hyperEvmTestnet = defineChain({
  id: hyperEvmTestnetChainId,
  name: 'HyperEVM Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [hyperEvmTestnetRpcUrl] } },
  blockExplorers: { default: { name: 'HyperEVM Testnet', url: '' } },
});

export {
  tangleTestnet,
  tangleMainnet,
  rpcUrl,
  allTangleChains,
  mainnet,
  resolveRpcUrl,
  configureNetworks,
  getNetworks,
} from '@tangle-network/blueprint-ui';
export type { CoreAddresses, NetworkConfig } from '@tangle-network/blueprint-ui';

/** Arena-specific contract addresses. */
export interface ArenaAddresses extends CoreAddresses {
  tangle: Address;
  vaultFactory: Address;
  tradingBlueprint: Address;
  /** Envelope v3: TradeValidator deployed by `DeployEnvelopeV3.s.sol`. */
  tradeValidator: Address;
  /** Envelope v3: a vault on this chain that the operator targets. */
  tradingVault: Address;
}

/**
 * Per-chain envelope-v3 address resolution.
 *
 * Order of preference:
 *  1. `VITE_TRADE_VALIDATOR_<CHAIN>` / `VITE_TRADING_VAULT_<CHAIN>` env vars
 *     written by the deployer (or by the arena's local devnet wiring).
 *  2. The hardcoded fallback below — `ZERO_ADDRESS` for chains without a
 *     deployment yet.
 *
 * To wire a fresh deploy: copy the `tradeValidator` and `sampleVault` fields
 * out of `deployments/{chainId}/v3.json` into the matching env var, or update
 * the fallback constant in this file once a deployment is canonical.
 */
function envelopeV3Addresses(chainId: number): {
  tradeValidator: Address;
  tradingVault: Address;
} {
  switch (chainId) {
    case 31337:
      return {
        tradeValidator: (import.meta.env.VITE_TRADE_VALIDATOR_ANVIL ??
          import.meta.env.VITE_TRADE_VALIDATOR_ADDRESS ??
          ZERO_ADDRESS) as Address,
        tradingVault: (import.meta.env.VITE_TRADING_VAULT_ANVIL ??
          import.meta.env.VITE_INSTANCE_VAULT_ADDRESS ??
          ZERO_ADDRESS) as Address,
      };
    case 1:
      return {
        // No mainnet deployment yet — gate UI on non-zero before enabling.
        tradeValidator: (import.meta.env.VITE_TRADE_VALIDATOR_ETHEREUM ?? ZERO_ADDRESS) as Address,
        tradingVault: (import.meta.env.VITE_TRADING_VAULT_ETHEREUM ?? ZERO_ADDRESS) as Address,
      };
    case 42161:
      return {
        // No Arbitrum deployment yet.
        tradeValidator: (import.meta.env.VITE_TRADE_VALIDATOR_ARBITRUM ?? ZERO_ADDRESS) as Address,
        tradingVault: (import.meta.env.VITE_TRADING_VAULT_ARBITRUM ?? ZERO_ADDRESS) as Address,
      };
    case 8453:
      return {
        // No Base mainnet deployment yet.
        tradeValidator: (import.meta.env.VITE_TRADE_VALIDATOR_BASE ?? ZERO_ADDRESS) as Address,
        tradingVault: (import.meta.env.VITE_TRADING_VAULT_BASE ?? ZERO_ADDRESS) as Address,
      };
    case 84532:
      return {
        // First target for envelope-v3 rollout — populate via env once deployed.
        tradeValidator: (import.meta.env.VITE_TRADE_VALIDATOR_BASE_SEPOLIA ?? ZERO_ADDRESS) as Address,
        tradingVault: (import.meta.env.VITE_TRADING_VAULT_BASE_SEPOLIA ?? ZERO_ADDRESS) as Address,
      };
    default:
      return { tradeValidator: ZERO_ADDRESS, tradingVault: ZERO_ADDRESS };
  }
}

const localEnvelopeV3 = envelopeV3Addresses(tangleLocal.id);
const ethereumEnvelopeV3 = envelopeV3Addresses(ethereumMainnet.id);
const arbitrumEnvelopeV3 = envelopeV3Addresses(arbitrumOne.id);
const baseEnvelopeV3 = envelopeV3Addresses(baseMainnet.id);
const baseSepoliaEnvelopeV3 = envelopeV3Addresses(baseSepolia.id);
const tangleTestnetEnvelopeV3 = envelopeV3Addresses(tangleTestnet.id);
const tangleMainnetEnvelopeV3 = envelopeV3Addresses(tangleMainnet.id);

// Configure arena networks at module load time.
configureNetworks<ArenaAddresses>({
  [tangleLocal.id]: {
    chain: tangleLocal,
    rpcUrl: tangleLocal.rpcUrls.default.http[0] ?? rpcUrl,
    label: forkMode ? 'Ethereum Local Fork' : 'Tangle Local',
    shortLabel: 'Local',
    addresses: {
      jobs: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      services: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      tangle: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      vaultFactory: (import.meta.env.VITE_VAULT_FACTORY ?? ZERO_ADDRESS) as Address,
      tradingBlueprint: (import.meta.env.VITE_TRADING_BLUEPRINT ?? ZERO_ADDRESS) as Address,
      tradeValidator: localEnvelopeV3.tradeValidator,
      tradingVault: localEnvelopeV3.tradingVault,
    },
  },
  ...(includeLocalExecutionFork
    ? {
        [executionForkChain.id]: {
          chain: executionForkChain,
          rpcUrl: executionForkChain.rpcUrls.default.http[0] ?? rpcUrl,
          label: 'Ethereum Fork',
          shortLabel: 'Fork',
          addresses: {
            jobs: ZERO_ADDRESS,
            services: ZERO_ADDRESS,
            tangle: ZERO_ADDRESS,
            vaultFactory: (import.meta.env.VITE_DEX_ETHEREUM_VAULT_FACTORY_ADDRESS ?? ZERO_ADDRESS) as Address,
            tradingBlueprint: ZERO_ADDRESS,
            tradeValidator: (import.meta.env.VITE_TRADE_VALIDATOR_FORK ?? ZERO_ADDRESS) as Address,
            tradingVault: (import.meta.env.VITE_TRADING_VAULT_FORK ?? ZERO_ADDRESS) as Address,
          },
        },
      }
    : {}),
  [tangleTestnet.id]: {
    chain: tangleTestnet,
    rpcUrl: 'https://testnet-rpc.tangle.tools',
    label: 'Tangle Testnet',
    shortLabel: 'Testnet',
    addresses: {
      jobs: ZERO_ADDRESS,
      services: ZERO_ADDRESS,
      tangle: ZERO_ADDRESS,
      vaultFactory: ZERO_ADDRESS,
      tradingBlueprint: ZERO_ADDRESS,
      tradeValidator: tangleTestnetEnvelopeV3.tradeValidator,
      tradingVault: tangleTestnetEnvelopeV3.tradingVault,
    },
  },
  [tangleMainnet.id]: {
    chain: tangleMainnet,
    rpcUrl: 'https://rpc.tangle.tools',
    label: 'Tangle Mainnet',
    shortLabel: 'Mainnet',
    addresses: {
      jobs: ZERO_ADDRESS,
      services: ZERO_ADDRESS,
      tangle: ZERO_ADDRESS,
      vaultFactory: ZERO_ADDRESS,
      tradingBlueprint: ZERO_ADDRESS,
      tradeValidator: tangleMainnetEnvelopeV3.tradeValidator,
      tradingVault: tangleMainnetEnvelopeV3.tradingVault,
    },
  },
  [ethereumMainnet.id]: {
    chain: ethereumMainnet,
    rpcUrl: ethereumMainnet.rpcUrls.default.http[0] ?? '',
    label: 'Ethereum',
    shortLabel: 'ETH',
    addresses: {
      jobs: ZERO_ADDRESS,
      services: ZERO_ADDRESS,
      tangle: ZERO_ADDRESS,
      vaultFactory: ZERO_ADDRESS,
      tradingBlueprint: ZERO_ADDRESS,
      tradeValidator: ethereumEnvelopeV3.tradeValidator,
      tradingVault: ethereumEnvelopeV3.tradingVault,
    },
  },
  [arbitrumOne.id]: {
    chain: arbitrumOne,
    rpcUrl: arbitrumOne.rpcUrls.default.http[0] ?? '',
    label: 'Arbitrum',
    shortLabel: 'ARB',
    addresses: {
      jobs: ZERO_ADDRESS,
      services: ZERO_ADDRESS,
      tangle: ZERO_ADDRESS,
      vaultFactory: ZERO_ADDRESS,
      tradingBlueprint: ZERO_ADDRESS,
      tradeValidator: arbitrumEnvelopeV3.tradeValidator,
      tradingVault: arbitrumEnvelopeV3.tradingVault,
    },
  },
  [baseMainnet.id]: {
    chain: baseMainnet,
    rpcUrl: baseMainnet.rpcUrls.default.http[0] ?? '',
    label: 'Base',
    shortLabel: 'BASE',
    addresses: {
      jobs: ZERO_ADDRESS,
      services: ZERO_ADDRESS,
      tangle: ZERO_ADDRESS,
      vaultFactory: ZERO_ADDRESS,
      tradingBlueprint: ZERO_ADDRESS,
      tradeValidator: baseEnvelopeV3.tradeValidator,
      tradingVault: baseEnvelopeV3.tradingVault,
    },
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    rpcUrl: baseSepolia.rpcUrls.default.http[0] ?? '',
    label: 'Base Sepolia',
    shortLabel: 'BASE-S',
    addresses: {
      jobs: ZERO_ADDRESS,
      services: ZERO_ADDRESS,
      tangle: ZERO_ADDRESS,
      vaultFactory: ZERO_ADDRESS,
      tradingBlueprint: ZERO_ADDRESS,
      tradeValidator: baseSepoliaEnvelopeV3.tradeValidator,
      tradingVault: baseSepoliaEnvelopeV3.tradingVault,
    },
  },
  ...(hyperEvmTestnetEnabled
    ? {
        [hyperEvmTestnet.id]: {
          chain: hyperEvmTestnet,
          rpcUrl: hyperEvmTestnet.rpcUrls.default.http[0] ?? '',
          label: 'HyperEVM Testnet',
          shortLabel: 'HyperEVM',
          addresses: {
            jobs: ZERO_ADDRESS,
            services: ZERO_ADDRESS,
            tangle: ZERO_ADDRESS,
            vaultFactory: (import.meta.env.VITE_HYPEREVM_TESTNET_VAULT_FACTORY_ADDRESS ?? ZERO_ADDRESS) as Address,
            tradingBlueprint: ZERO_ADDRESS,
            tradeValidator: ZERO_ADDRESS,
            tradingVault: (import.meta.env.VITE_HYPEREVM_TESTNET_VAULT_ADDRESS ?? ZERO_ADDRESS) as Address,
          },
        },
      }
    : {}),
});

/** Backwards-compatible accessor. */
export const networks = getNetworks<ArenaAddresses>();
