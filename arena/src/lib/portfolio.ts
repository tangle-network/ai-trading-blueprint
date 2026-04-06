import type { Portfolio, Position } from '~/lib/types/portfolio';

const KNOWN_STABLECOINS = new Set(
  [
    'usdc',
    'usdc.e',
    'usdt',
    'dai',
    'fdusd',
    'usde',
    'usdbc',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0x6b175474e89094c44da98b954eedeac495271d0f',
    '0x2791bcaf2de4661ed88a30c99a7a9449aa84174',
    import.meta.env.VITE_USDC_ADDRESS,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.trim().toLowerCase()),
);

const STABLECOIN_PRICE_MIN = 0.5;
const STABLECOIN_PRICE_MAX = 1.5;

export interface RawPortfolioPosition {
  token: string;
  symbol?: string;
  amount: number | string;
  value_usd?: number;
  entry_price: number | string;
  current_price: number | string;
  pnl_percent?: number;
  weight?: number;
  unrealized_pnl?: string;
  protocol?: string;
}

export interface RawPortfolioState {
  positions: RawPortfolioPosition[];
  total_value_usd: number | string;
  cash_balance?: number | string;
  unrealized_pnl?: string;
  realized_pnl?: string;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculatePnlPercent(currentPrice: number, entryPrice: number): number {
  if (entryPrice <= 0) return 0;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

function calculateWeight(valueUsd: number, totalValueUsd: number): number {
  if (totalValueUsd <= 0) return 0;
  return (valueUsd / totalValueUsd) * 100;
}

function normalizeToken(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isKnownStablecoin(token: string, symbol?: string): boolean {
  return KNOWN_STABLECOINS.has(normalizeToken(token)) || KNOWN_STABLECOINS.has(normalizeToken(symbol));
}

function materiallyDifferent(a: number, b: number, absoluteTolerance: number, relativeTolerance: number): boolean {
  const delta = Math.abs(a - b);
  if (delta <= absoluteTolerance) return false;
  const baseline = Math.max(Math.abs(a), Math.abs(b), 1);
  return delta / baseline > relativeTolerance;
}

function isStablecoinPriceSuspicious(price: number): boolean {
  return price > 0 && (price < STABLECOIN_PRICE_MIN || price > STABLECOIN_PRICE_MAX);
}

function mapApiPosition(
  pos: RawPortfolioPosition,
  totalValueUsd: number,
): Position {
  const amount = toFiniteNumber(pos.amount) ?? 0;
  const entryPrice = toFiniteNumber(pos.entry_price) ?? 0;
  const currentPrice = toFiniteNumber(pos.current_price) ?? 0;
  const derivedValueUsd = amount * currentPrice;
  const rawValueUsd = pos.value_usd != null ? toFiniteNumber(pos.value_usd) : derivedValueUsd;
  const derivedPnlPercent = calculatePnlPercent(currentPrice, entryPrice);
  const rawPnlPercent = pos.pnl_percent != null
    ? toFiniteNumber(pos.pnl_percent)
    : derivedPnlPercent;
  const derivedWeight = calculateWeight(rawValueUsd ?? derivedValueUsd, totalValueUsd);
  const rawWeight = pos.weight != null
    ? toFiniteNumber(pos.weight)
    : derivedWeight;

  const warnings: string[] = [];
  if (toFiniteNumber(pos.amount) == null) warnings.push('Position amount is not a finite number.');
  if (toFiniteNumber(pos.entry_price) == null) warnings.push('Entry price is not a finite number.');
  if (toFiniteNumber(pos.current_price) == null) warnings.push('Current price is not a finite number.');
  if (rawValueUsd == null) warnings.push('Portfolio value is not a finite number.');
  if (rawPnlPercent == null) warnings.push('PnL is not a finite number.');
  if (rawWeight == null) warnings.push('Portfolio weight is not a finite number.');

  const stablecoin = isKnownStablecoin(pos.token, pos.symbol);
  if (stablecoin && amount > 0) {
    const impliedValuePrice = rawValueUsd != null ? rawValueUsd / amount : 0;
    if (isStablecoinPriceSuspicious(entryPrice)) {
      warnings.push('Stablecoin entry price is outside the expected $1 range.');
    }
    if (isStablecoinPriceSuspicious(currentPrice)) {
      warnings.push('Stablecoin current price is outside the expected $1 range.');
    }
    if (isStablecoinPriceSuspicious(impliedValuePrice)) {
      warnings.push('Stablecoin value is inconsistent with its reported amount.');
    }
  }

  if (rawValueUsd != null && Number.isFinite(derivedValueUsd)
    && materiallyDifferent(rawValueUsd, derivedValueUsd, 1, 0.1)) {
    warnings.push('Reported position value does not match amount × current price.');
  }

  if (rawPnlPercent != null && Number.isFinite(derivedPnlPercent)
    && materiallyDifferent(rawPnlPercent, derivedPnlPercent, 5, 0.2)) {
    warnings.push('Reported PnL does not match the reported entry and current prices.');
  }

  if (rawWeight != null && Number.isFinite(derivedWeight)
    && materiallyDifferent(rawWeight, derivedWeight, 2, 0.2)) {
    warnings.push('Reported portfolio weight does not match the reported position value.');
  }

  const isSuspicious = warnings.length > 0;

  return {
    token: pos.token,
    symbol: pos.symbol ?? pos.token,
    amount,
    valueUsd: rawValueUsd ?? 0,
    entryPrice,
    currentPrice,
    pnlPercent: rawPnlPercent ?? 0,
    weight: rawWeight ?? 0,
    displayValueUsd: isSuspicious ? null : (rawValueUsd ?? derivedValueUsd),
    displayPnlPercent: isSuspicious ? null : (rawPnlPercent ?? derivedPnlPercent),
    displayWeight: isSuspicious ? null : (rawWeight ?? derivedWeight),
    warnings,
    isSuspicious,
  };
}

export function mapApiPortfolioState(p: RawPortfolioState, botId: string): Portfolio {
  const totalValueUsd = toFiniteNumber(p.total_value_usd) ?? 0;
  const cashBalance = toFiniteNumber(p.cash_balance) ?? 0;
  const positions = p.positions.map((pos) => mapApiPosition(pos, totalValueUsd));
  const trustedPositionValueUsd = positions.reduce(
    (sum, pos) => sum + (pos.displayValueUsd ?? 0),
    0,
  );

  const warnings: string[] = [];
  const hasSuspiciousPositions = positions.some((pos) => pos.isSuspicious);
  if (hasSuspiciousPositions) {
    warnings.push('Some portfolio metrics were hidden because the operator returned values that failed sanity checks.');
  }

  if (!Number.isFinite(totalValueUsd) || totalValueUsd < 0) {
    warnings.push('Reported total portfolio value is invalid.');
  }

  if (!Number.isFinite(cashBalance) || cashBalance < 0) {
    warnings.push('Reported cash balance is invalid.');
  }

  if (!hasSuspiciousPositions
    && materiallyDifferent(trustedPositionValueUsd + cashBalance, totalValueUsd, 1, 0.05)) {
    warnings.push('Reported portfolio totals are inconsistent with the position rows.');
  }

  const totalsTrusted = warnings.length === 0;

  return {
    botId,
    totalValueUsd,
    cashBalance,
    displayTotalValueUsd: totalsTrusted ? totalValueUsd : null,
    displayCashBalance: totalsTrusted ? cashBalance : null,
    warnings,
    hasSuspiciousPositions,
    positions,
  };
}
