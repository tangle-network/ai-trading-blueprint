import type { Portfolio, Position } from '~/lib/types/portfolio';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';

export interface RawPortfolioPosition {
  token: string;
  symbol?: string;
  amount: number | string;
  value_usd?: number | string | null;
  entry_price?: number | string | null;
  current_price?: number | string | null;
  pnl_percent?: number | string | null;
  unrealized_pnl?: number | string | null;
  weight?: number | string | null;
  valuation_status?: 'priced' | 'value_only' | 'unpriced';
  protocol?: string;
}

export interface RawPortfolioState {
  positions: RawPortfolioPosition[];
  total_value_usd?: number | string | null;
  cash_balance?: number | string | null;
  warnings?: string[];
  has_unpriced_positions?: boolean;
  has_value_only_positions?: boolean;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferValuationStatus(pos: RawPortfolioPosition): Position['valuationStatus'] {
  if (pos.valuation_status === 'priced') return 'priced';
  if (pos.valuation_status === 'value_only') return 'value_only';
  if (pos.valuation_status === 'unpriced') return 'unpriced';

  const hasPricedFields = [
    pos.value_usd,
    pos.current_price,
    pos.weight,
    pos.pnl_percent,
  ].some((value) => toFiniteNumber(value) != null);

  return hasPricedFields ? 'priced' : 'unpriced';
}

function mapApiPosition(pos: RawPortfolioPosition, chainId?: number): Position {
  const valuationStatus = inferValuationStatus(pos);
  const amount = toFiniteNumber(pos.amount) ?? 0;
  const resolvedFromToken = resolveAssetDisplay(pos.token, chainId);
  const asset = (!resolvedFromToken.isKnown && pos.symbol && pos.symbol !== pos.token)
    ? resolveAssetDisplay(pos.symbol, chainId)
    : resolvedFromToken;
  const isValueVisible = valuationStatus === 'priced' || valuationStatus === 'value_only';
  const valueUsd = isValueVisible ? toFiniteNumber(pos.value_usd) : null;
  const entryPrice = valuationStatus === 'priced' ? toFiniteNumber(pos.entry_price) : null;
  const currentPrice = isValueVisible ? toFiniteNumber(pos.current_price) : null;
  const pnlBase = toFiniteNumber(pos.pnl_percent);
  const pnlPercent = valuationStatus === 'priced'
    ? pnlBase
    : null;
  const weight = isValueVisible ? toFiniteNumber(pos.weight) : null;

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
  } else if (valuationStatus === 'value_only') {
    if (valueUsd == null) warnings.push('Current market value is unavailable.');
    if (currentPrice == null) warnings.push('Current price is unavailable.');
    warnings.push('Entry price and PnL are unavailable for this position.');
  } else {
    warnings.push('Valuation data is unavailable for this position.');
  }

  return {
    asset,
    token: pos.token,
    symbol: asset.symbol,
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

export function mapApiPortfolioState(p: RawPortfolioState, botId: string, chainId?: number): Portfolio {
  const positions = p.positions.map((pos) => mapApiPosition(pos, chainId));
  const hasUnpricedPositions = p.has_unpriced_positions ?? positions.some((pos) => pos.valuationStatus === 'unpriced');
  const hasValueOnlyPositions = p.has_value_only_positions ?? positions.some((pos) => pos.valuationStatus === 'value_only');
  const totalValueUsd = hasUnpricedPositions ? null : toFiniteNumber(p.total_value_usd);
  const cashBalance = toFiniteNumber(p.cash_balance);
  const warnings = [...(p.warnings ?? [])];

  if (hasUnpricedPositions && !warnings.some((warning) => warning.includes('no current market price') || warning.includes('total portfolio value is hidden'))) {
    warnings.push('Some positions still have no current market price, so total portfolio value is hidden.');
  }
  if (hasValueOnlyPositions && !warnings.some((warning) => warning.includes('entry price') || warning.includes('PnL'))) {
    warnings.push('Some positions have current market value, but entry price or PnL are unavailable.');
  }

  return {
    botId,
    totalValueUsd,
    cashBalance,
    displayTotalValueUsd: totalValueUsd,
    displayCashBalance: cashBalance,
    warnings,
    hasUnpricedPositions,
    hasValueOnlyPositions,
    positions,
  };
}
