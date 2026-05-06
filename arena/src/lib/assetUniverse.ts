import type { Address } from 'viem';
import {
  getTradeTokenMetadata,
  isTokenAddress,
  knownTradeTokensForChain,
  type TokenMetadata,
} from '~/lib/tradeTokenMetadata';
import { truncateAddress } from '~/lib/format';

export type DexAssetUniverseAsset = {
  strategy_type: 'dex';
  protocol: 'uniswap_v3';
  chain_id: number;
  symbol: string;
  address: Address;
  decimals: number;
  roles: ('input' | 'output')[];
  valuation_adapter: 'chainlink_usd';
};

export type DexAssetUniverse = {
  mode: 'user_selected';
  base_asset: Address;
  allowed_assets: DexAssetUniverseAsset[];
  exit_only_assets: DexAssetUniverseAsset[];
  valuation_policy: 'chainlink_usd';
  routing_policy: 'explicit_allowed_tokens_only';
};

export type DexAssetSelection = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  known: boolean;
};

export function normalizeAssetAddress(address: string): Address {
  return address.trim() as Address;
}

export function dexAssetSelectionsForChain(chainId?: number): DexAssetSelection[] {
  return knownTradeTokensForChain(chainId).map(selectionFromMetadata);
}

export function resolveDexAssetInput(
  value: string,
  chainId?: number,
): DexAssetSelection | null {
  const raw = value.trim();
  if (!raw) return null;
  const metadata = getTradeTokenMetadata(raw, chainId);
  if (metadata) return selectionFromMetadata(metadata);
  if (!isTokenAddress(raw)) return null;
  return {
    address: normalizeAssetAddress(raw),
    symbol: truncateAddress(raw),
    name: 'Custom asset',
    decimals: 18,
    known: false,
  };
}

export function buildDexAssetUniverse({
  chainId,
  baseAsset,
  selectedAssets,
}: {
  chainId: number;
  baseAsset: Address;
  selectedAssets: Address[];
}): DexAssetUniverse {
  const unique = new Map<string, Address>();
  for (const asset of [baseAsset, ...selectedAssets]) {
    unique.set(asset.toLowerCase(), asset);
  }

  return {
    mode: 'user_selected',
    base_asset: baseAsset,
    allowed_assets: [...unique.values()].map((address) =>
      assetUniverseAssetForAddress(chainId, address),
    ),
    exit_only_assets: [],
    valuation_policy: 'chainlink_usd',
    routing_policy: 'explicit_allowed_tokens_only',
  };
}

export function assetUniverseAssetForAddress(
  chainId: number,
  address: Address,
): DexAssetUniverseAsset {
  const metadata = getTradeTokenMetadata(address, chainId);
  return {
    strategy_type: 'dex',
    protocol: 'uniswap_v3',
    chain_id: chainId,
    symbol: metadata?.symbol ?? truncateAddress(address),
    address,
    decimals: metadata?.decimals ?? 18,
    roles: ['input', 'output'],
    valuation_adapter: 'chainlink_usd',
  };
}

function selectionFromMetadata(metadata: TokenMetadata): DexAssetSelection {
  return {
    address: metadata.address as Address,
    symbol: metadata.symbol,
    name: metadata.name,
    decimals: metadata.decimals,
    known: true,
  };
}
