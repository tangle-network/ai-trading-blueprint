import { formatUnits } from 'viem';
import { tokens } from '~/lib/contracts/addresses';

interface TokenMetadata {
  symbol: string;
  decimals: number;
}

const TOKEN_METADATA_BY_ADDRESS: Record<string, TokenMetadata> = {
  [tokens.WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
  [tokens.USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
};

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function isTokenAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

export function getTradeTokenMetadata(token: string): TokenMetadata | null {
  if (!isTokenAddress(token)) return null;
  return TOKEN_METADATA_BY_ADDRESS[token.toLowerCase()] ?? null;
}

export function getTradeTokenDisplaySymbol(token: string): string {
  return getTradeTokenMetadata(token)?.symbol ?? token;
}

export function parseTradeDisplayAmount(rawAmount: string | number | undefined, rawToken: string): number {
  if (rawAmount == null) return 0;
  if (typeof rawAmount === 'number') return Number.isFinite(rawAmount) ? rawAmount : 0;

  const raw = rawAmount.trim();
  if (raw === '') return 0;

  const metadata = getTradeTokenMetadata(rawToken);
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
