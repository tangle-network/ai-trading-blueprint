import { useBotTrades } from '~/lib/hooks/useBotApi';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Badge } from '~/components/ui/badge';

interface TradeHistoryTabProps {
  botId: string;
  botName?: string;
}

export function TradeHistoryTab({ botId, botName = '' }: TradeHistoryTabProps) {
  const { data: trades, isLoading } = useBotTrades(botId, botName);

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading trades...
      </div>
    );
  }

  if (!trades || trades.length === 0) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:swap text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No trades recorded for this bot.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Time</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Pair</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right hidden sm:table-cell">Score</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => (
          <TableRow key={trade.id}>
            <TableCell className="text-arena-elements-textTertiary text-xs font-data">
              {new Date(trade.timestamp).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </TableCell>
            <TableCell>
              <Badge variant={trade.action === 'buy' ? 'success' : 'destructive'}>
                {trade.action.toUpperCase()}
              </Badge>
            </TableCell>
            <TableCell className="font-display font-medium text-sm">
              {trade.tokenIn}/{trade.tokenOut}
            </TableCell>
            <TableCell className="text-right font-data text-sm">
              {trade.amountOut.toLocaleString()} {trade.tokenOut}
            </TableCell>
            <TableCell className="text-right font-data text-sm">
              {trade.priceUsd > 0 ? `$${trade.priceUsd.toLocaleString()}` : '—'}
            </TableCell>
            <TableCell className="text-right hidden sm:table-cell">
              {trade.validatorScore != null ? (
                <span className={`font-data text-xs font-bold ${
                  trade.validatorScore >= 80 ? 'text-emerald-400' :
                  trade.validatorScore >= 50 ? 'text-amber-400' : 'text-crimson-400'
                }`}>
                  {trade.validatorScore}
                </span>
              ) : (
                <span className="text-arena-elements-textTertiary font-data text-xs">-</span>
              )}
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  trade.status === 'executed' ? 'success' :
                  trade.status === 'rejected' ? 'destructive' :
                  trade.status === 'paper' ? 'secondary' : 'outline'
                }
              >
                {trade.status}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
