import { useRecentTrades } from '~/lib/hooks/useBotApi';

export function LiveTicker() {
  const { data: trades } = useRecentTrades(10);
  const recentTrades = trades ?? [];
  const items = [...recentTrades, ...recentTrades];

  return (
    <section className="border-y border-arena-elements-dividerColor bg-arena-elements-background-depth-2/50 backdrop-blur-sm py-3 overflow-hidden relative">
      {/* Edge fade */}
      <div className="absolute left-0 top-0 bottom-0 w-20 bg-gradient-to-r from-arena-elements-background-depth-1 to-transparent z-10 pointer-events-none" />
      <div className="absolute right-0 top-0 bottom-0 w-20 bg-gradient-to-l from-arena-elements-background-depth-1 to-transparent z-10 pointer-events-none" />

      <div className="flex animate-ticker-scroll whitespace-nowrap" style={{ width: 'max-content' }}>
        {items.map((trade, i) => (
          <div key={`${trade.id}-${i}`} className="inline-flex items-center gap-2 px-6 text-sm">
            <span className="font-display font-medium text-arena-elements-textPrimary">{trade.botName}</span>
            <span className={`font-data font-semibold text-xs ${
              trade.action === 'buy'
                ? 'text-arena-elements-icon-success'
                : 'text-arena-elements-icon-error'
            }`}>
              {trade.action.toUpperCase()}
            </span>
            <span className="text-arena-elements-textSecondary font-data text-xs">
              {trade.amountOut.toLocaleString()} {trade.tokenOut}
            </span>
            <span className="text-arena-elements-textTertiary">/</span>
            <span className="text-arena-elements-textTertiary font-data text-xs">
              ${trade.priceUsd.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
