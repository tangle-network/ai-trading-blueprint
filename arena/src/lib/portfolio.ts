import type { Portfolio, Position } from '~/lib/types/portfolio';

export interface RawPortfolioPosition {
  token: string;
  symbol?: string;
  amount: number | string;
  value_usd?: number | string | null;
  entry_price?: number | string | null;
  current_price?: number | string | null;
  pnl_percent?: number | string | null;
  weight?: number | string | null;
  valuation_status?: 'priced' | 'unpriced';
  protocol?: string;
}

export interface RawPortfolioState {
  positions: RawPortfolioPosition[];
  total_value_usd?: number | string | null;
  cash_balance?: number | string | null;
  warnings?: string[];
  has_unpriced_positions?: boolean;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferValuationStatus(pos: RawPortfolioPosition): Position['valuationStatus'] {
  if (pos.valuation_status === 'priced') return 'priced';
  if (pos.valuation_status === 'unpriced') return 'unpriced';

  const hasPricedFields = [
    pos.value_usd,
    pos.current_price,
    pos.weight,
    pos.pnl_percent,
  ].some((value) => toFiniteNumber(value) != null);

  return hasPricedFields ? 'priced' : 'unpriced';
}

function mapApiPosition(pos: RawPortfolioPosition): Position {
  const valuationStatus = inferValuationStatus(pos);
  const amount = toFiniteNumber(pos.amount) ?? 0;
  const valueUsd = valuationStatus === 'priced' ? toFiniteNumber(pos.value_usd) : null;
  const entryPrice = valuationStatus === 'priced' ? toFiniteNumber(pos.entry_price) : null;
  const currentPrice = valuationStatus === 'priced' ? toFiniteNumber(pos.current_price) : null;
  const pnlPercent = valuationStatus === 'priced' ? toFiniteNumber(pos.pnl_percent) : null;
  const weight = valuationStatus === 'priced' ? toFiniteNumber(pos.weight) : null;

  const warnings: string[] = [];
  if (toFiniteNumber(pos.amount) == null) {
    warnings.push('Position amount is not a finite number.');
  }
  if (valuationStatus === 'priced') {
    if (valueUsd == null) warnings.push('Position value is unavailable.');
    if (entryPrice == null) warnings.push('Entry price is unavailable.');
    if (currentPrice == null) warnings.push('Current price is unavailable.');
    if (pnlPercent == null) warnings.push('PnL is unavailable.');
    if (weight == null) warnings.push('Portfolio weight is unavailable.');
  } else {
    warnings.push('Valuation data is unavailable for this position.');
  }

  return {
    token: pos.token,
    symbol: pos.symbol ?? pos.token,
    amount,
    valueUsd,
    entryPrice,
    currentPrice,
    pnlPercent,
    weight,
    displayValueUsd: valueUsd,
    displayPnlPercent: pnlPercent,
    displayWeight: weight,
    warnings,
    valuationStatus,
  };
}

export function mapApiPortfolioState(p: RawPortfolioState, botId: string): Portfolio {
  const positions = p.positions.map((pos) => mapApiPosition(pos));
  const hasUnpricedPositions = p.has_unpriced_positions ?? positions.some((pos) => pos.valuationStatus === 'unpriced');
  const totalValueUsd = hasUnpricedPositions ? null : toFiniteNumber(p.total_value_usd);
  const cashBalance = toFiniteNumber(p.cash_balance);
  const warnings = [...(p.warnings ?? [])];

  if (hasUnpricedPositions && warnings.length === 0) {
    warnings.push('Some portfolio values are unavailable because trade valuation data is missing.');
  }

  return {
    botId,
    totalValueUsd,
    cashBalance,
    displayTotalValueUsd: totalValueUsd,
    displayCashBalance: cashBalance,
    warnings,
    hasUnpricedPositions,
    positions,
  };
}
