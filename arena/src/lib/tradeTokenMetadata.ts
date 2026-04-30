import { formatUnits } from 'viem';
import { truncateAddress } from '~/lib/format';

interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
  chainIds: number[];
  aliases?: string[];
  accentClassName: string;
}

export interface ResolvedAssetDisplay {
  rawToken: string;
  symbol: string;
  name: string;
  primaryLabel: string;
  secondaryLabel?: string;
  shortAddress?: string;
  isKnown: boolean;
  accentClassName: string;
  iconText: string;
}

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const KNOWN_TOKENS: TokenMetadata[] = [
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    chainIds: [1, 31337, 31338, 31339],
    aliases: ['ETH'],
    accentClassName: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    chainIds: [1, 31337, 31338, 31339],
    accentClassName: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200',
  },
  {
    symbol: 'USDT',
    name: 'Tether',
    decimals: 6,
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    chainIds: [1, 31337, 31338, 31339],
    accentClassName: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200',
  },
  {
    symbol: 'DAI',
    name: 'Dai',
    decimals: 18,
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    chainIds: [1, 31337, 31338, 31339],
    accentClassName: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    chainIds: [1, 31337, 31338, 31339],
    aliases: ['BTC'],
    accentClassName: 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200',
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    address: '0x4200000000000000000000000000000000000006',
    chainIds: [8453, 84532],
    aliases: ['ETH'],
    accentClassName: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainIds: [8453],
    accentClassName: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    chainIds: [84532],
    accentClassName: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    chainIds: [137],
    accentClassName: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200',
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    chainIds: [8453],
    aliases: ['BTC', 'WBTC'],
    accentClassName: 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200',
  },
];

const FALLBACK_ACCENTS = [
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-200',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-200',
  'bg-lime-100 text-lime-700 dark:bg-lime-500/20 dark:text-lime-200',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
];

function normalizeTokenKey(token: string): string {
  return token.trim().toLowerCase();
}

export function isTokenAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

function tokenMatches(metadata: TokenMetadata, key: string): boolean {
  if (normalizeTokenKey(metadata.address) === key) return true;
  if (metadata.symbol.toLowerCase() === key) return true;
  return metadata.aliases?.some((alias) => alias.toLowerCase() === key) ?? false;
}

function lookupKnownToken(token: string, chainId?: number): TokenMetadata | null {
  const key = normalizeTokenKey(token);
  if (chainId != null) {
    const exact = KNOWN_TOKENS.find((metadata) => metadata.chainIds.includes(chainId) && tokenMatches(metadata, key));
    if (exact) return exact;
  }

  return KNOWN_TOKENS.find((metadata) => tokenMatches(metadata, key)) ?? null;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function fallbackAccentClassName(token: string): string {
  return FALLBACK_ACCENTS[hashString(token) % FALLBACK_ACCENTS.length];
}

function iconTextForLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  if (cleaned === '') return '?';

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  }

  return cleaned.slice(0, 3).toUpperCase();
}

export function getTradeTokenMetadata(token: string, chainId?: number): TokenMetadata | null {
  return lookupKnownToken(token, chainId);
}

export function getTradeTokenDisplaySymbol(token: string, chainId?: number): string {
  return lookupKnownToken(token, chainId)?.symbol ?? token;
}

export function resolveAssetDisplay(token: string, chainId?: number): ResolvedAssetDisplay {
  const rawToken = token.trim();
  const metadata = lookupKnownToken(rawToken, chainId);

  if (metadata) {
    return {
      rawToken,
      symbol: metadata.symbol,
      name: metadata.name,
      primaryLabel: metadata.name,
      secondaryLabel: metadata.symbol,
      shortAddress: isTokenAddress(rawToken) ? truncateAddress(rawToken) : undefined,
      isKnown: true,
      accentClassName: metadata.accentClassName,
      iconText: iconTextForLabel(metadata.symbol),
    };
  }

  if (isTokenAddress(rawToken)) {
    return {
      rawToken,
      symbol: 'Asset',
      name: 'Unknown Asset',
      primaryLabel: 'Unknown Asset',
      secondaryLabel: truncateAddress(rawToken),
      shortAddress: truncateAddress(rawToken),
      isKnown: false,
      accentClassName: fallbackAccentClassName(rawToken),
      iconText: '?',
    };
  }

  const fallbackLabel = rawToken === '' ? 'Asset' : rawToken;
  return {
    rawToken,
    symbol: fallbackLabel,
    name: fallbackLabel,
    primaryLabel: fallbackLabel,
    isKnown: false,
    accentClassName: fallbackAccentClassName(fallbackLabel),
    iconText: iconTextForLabel(fallbackLabel),
  };
}

export function parseTradeDisplayAmount(
  rawAmount: string | number | undefined,
  rawToken: string,
  chainId?: number,
): number {
  if (rawAmount == null) return 0;
  if (typeof rawAmount === 'number') return Number.isFinite(rawAmount) ? rawAmount : 0;

  const raw = rawAmount.trim();
  if (raw === '') return 0;

  const metadata = getTradeTokenMetadata(rawToken, chainId);
  if (metadata && /^[0-9]+$/.test(raw)) {
    try {
      return Number(formatUnits(BigInt(raw), metadata.decimals));
    } catch {
      // Fall through to the generic numeric parser below.
    }
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
