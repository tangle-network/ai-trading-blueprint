import { formatNumber } from '~/lib/format';
import { getTradePairLabel, type Trade, type TradeAction } from '~/lib/types/trade';

export function isBuySideTradeAction(action: TradeAction): boolean {
  return action === 'buy' || action === 'open_long' || action === 'close_short';
}

export function isSellSideTradeAction(action: TradeAction): boolean {
  return action === 'sell' || action === 'close_long' || action === 'open_short';
}

export function formatTradeActionLabel(action: TradeAction): string {
  if (action === 'open_long') return 'LONG';
  if (action === 'close_long') return 'CLOSE LONG';
  if (action === 'open_short') return 'SHORT';
  if (action === 'close_short') return 'CLOSE SHORT';
  return action.replace(/_/g, ' ').toUpperCase();
}

export function getTradeActionToneClass(action: TradeAction): string {
  if (isBuySideTradeAction(action)) return 'text-arena-elements-icon-success';
  if (isSellSideTradeAction(action)) return 'text-arena-elements-icon-error';
  return 'text-amber-600 dark:text-amber-300';
}

export function getTradeActionPillClass(action: TradeAction): string {
  if (isBuySideTradeAction(action)) {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (isSellSideTradeAction(action)) {
    return 'bg-crimson-500/10 text-crimson-700 dark:text-crimson-300';
  }
  return 'bg-violet-500/10 text-violet-700 dark:text-violet-300';
}

export function getTradeActionBadgeVariant(action: TradeAction): 'success' | 'destructive' | 'accent' {
  if (isBuySideTradeAction(action)) return 'success';
  if (isSellSideTradeAction(action)) return 'destructive';
  return 'accent';
}

export function getHyperliquidAssetSymbol(trade: Trade): string | null {
  const asset = trade.hyperliquidMetadata?.asset?.trim();
  return asset ? asset.toUpperCase() : null;
}

export function getHyperliquidMarketLabel(trade: Trade): string | null {
  const asset = getHyperliquidAssetSymbol(trade);
  return asset ? `${asset}-PERP` : null;
}

export function getHyperliquidSizeLabel(trade: Trade): string | null {
  const asset = getHyperliquidAssetSymbol(trade);
  const size = trade.hyperliquidMetadata?.assetSize?.trim();
  if (!asset || !size) return null;
  return `${size} ${asset}`;
}

export function getTradeMarketLabel(trade: Trade): string {
  if (trade.targetProtocol === 'hyperliquid') {
    return getHyperliquidMarketLabel(trade) ?? 'Hyperliquid';
  }
  return getTradePairLabel(trade);
}

export function formatTradeModeLabel(trade: Trade): string {
  return trade.paperTrade || trade.status === 'paper' ? 'Paper' : 'Live';
}

export function formatTradeUsd(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return `$${formatNumber(value, { maximumFractionDigits: 0 })}`;
  return `$${formatNumber(value, { maximumFractionDigits: 2 })}`;
}

export function formatTradeAmount(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 4 });
}

export function formatTradeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
