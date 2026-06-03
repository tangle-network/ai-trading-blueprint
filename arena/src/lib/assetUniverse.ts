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
  name: string;
  address: Address;
  decimals: number;
  roles: ('input' | 'output')[];
  valuation_adapter: 'chainlink_usd' | 'chainlink_or_uniswap_v3_twap';
};

export type DexAssetUniverse = {
  mode: 'user_selected';
  base_asset: Address;
  allowed_assets: DexAssetUniverseAsset[];
  exit_only_assets: DexAssetUniverseAsset[];
  valuation_policy: 'chainlink_or_uniswap_v3_twap';
  routing_policy: 'explicit_allowed_tokens_only';
};

export type DexAssetSelection = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  known: boolean;
  logoUri?: string;
  valuationSource?: 'chainlink' | 'uniswap_v3_twap' | 'base_asset';
  verifiedBaseAsset?: Address;
};

export function strategyUsesDexAssetUniverse(strategyType: string): boolean {
  return strategyType === 'dex' || strategyType.startsWith('dex-');
}

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
  assetSelections = [],
}: {
  chainId: number;
  baseAsset: Address;
  selectedAssets: Address[];
  assetSelections?: DexAssetSelection[];
}): DexAssetUniverse {
  const unique = new Map<string, Address>();
  for (const asset of [baseAsset, ...selectedAssets]) {
    unique.set(asset.toLowerCase(), asset);
  }
  const selectionByAddress = new Map(
    assetSelections.map((asset) => [asset.address.toLowerCase(), asset]),
  );

  return {
    mode: 'user_selected',
    base_asset: baseAsset,
    allowed_assets: [...unique.values()].map((address) =>
      assetUniverseAssetForAddress(chainId, address, selectionByAddress.get(address.toLowerCase())),
    ),
    exit_only_assets: [],
    valuation_policy: 'chainlink_or_uniswap_v3_twap',
    routing_policy: 'explicit_allowed_tokens_only',
  };
}

export function assetUniverseAssetForAddress(
  chainId: number,
  address: Address,
  selection?: DexAssetSelection,
): DexAssetUniverseAsset {
  const metadata = getTradeTokenMetadata(address, chainId);
  const isKnownPriced = Boolean(metadata) || selection?.valuationSource === 'chainlink';
  return {
    strategy_type: 'dex',
    protocol: 'uniswap_v3',
    chain_id: chainId,
    symbol: selection?.symbol ?? metadata?.symbol ?? truncateAddress(address),
    name: selection?.name ?? metadata?.name ?? 'Custom asset',
    address,
    decimals: selection?.decimals ?? metadata?.decimals ?? 18,
    roles: ['input', 'output'],
    valuation_adapter: isKnownPriced ? 'chainlink_usd' : 'chainlink_or_uniswap_v3_twap',
  };
}

function selectionFromMetadata(metadata: TokenMetadata): DexAssetSelection {
  return {
    address: metadata.address as Address,
    symbol: metadata.symbol,
    name: metadata.name,
    decimals: metadata.decimals,
    known: true,
    logoUri: metadata.logoUri,
    valuationSource: 'chainlink',
  };
}

export function tokenMetadataFromDexAssetSelections(
  assets: DexAssetSelection[],
  chainId: number,
): TokenMetadata[] {
  return assets.map((asset) => ({
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    address: asset.address,
    chainIds: [chainId],
    accentClassName: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
    logoUri: asset.logoUri,
  }));
}

export function tokenMetadataFromStrategyConfig(
  strategyConfig: unknown,
): TokenMetadata[] {
  if (!strategyConfig || typeof strategyConfig !== 'object') return [];
  const assetUniverse = (strategyConfig as { asset_universe?: unknown }).asset_universe;
  if (!assetUniverse || typeof assetUniverse !== 'object') return [];
  const allowedAssets = (assetUniverse as { allowed_assets?: unknown }).allowed_assets;
  if (!Array.isArray(allowedAssets)) return [];

  return allowedAssets.flatMap((asset): TokenMetadata[] => {
    if (!asset || typeof asset !== 'object') return [];
    const value = asset as {
      address?: unknown;
      symbol?: unknown;
      name?: unknown;
      decimals?: unknown;
      chain_id?: unknown;
    };
    if (typeof value.address !== 'string' || !isTokenAddress(value.address)) return [];
    if (typeof value.symbol !== 'string' || value.symbol.trim() === '') return [];
    const decimals = typeof value.decimals === 'number' ? value.decimals : 18;
    const chainId = typeof value.chain_id === 'number' ? value.chain_id : 1;
    const symbol = value.symbol.trim();
    const name =
      typeof value.name === 'string' && value.name.trim() !== ''
        ? value.name.trim()
        : symbol;
    return [{
      symbol,
      name,
      decimals,
      address: value.address,
      chainIds: [chainId],
      accentClassName: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
    }];
  });
}
