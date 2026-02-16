import { useBotPortfolio } from '~/lib/hooks/useBotApi';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';

interface PositionsTabProps {
  botId: string;
}

export function PositionsTab({ botId }: PositionsTabProps) {
  const { data: portfolio, isLoading } = useBotPortfolio(botId);

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading positions...
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:wallet text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No portfolio data available for this bot.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-6 mb-4">
        <div className="glass-card rounded-lg px-4 py-2">
          <span className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">Total Value </span>
          <span className="font-display font-bold text-lg">${portfolio.totalValueUsd.toLocaleString()}</span>
        </div>
        <div className="glass-card rounded-lg px-4 py-2">
          <span className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">Cash </span>
          <span className="font-data font-medium">${portfolio.cashBalance.toLocaleString()}</span>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Token</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Entry</TableHead>
            <TableHead className="text-right">Current</TableHead>
            <TableHead className="text-right">PnL</TableHead>
            <TableHead className="text-right">Weight</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {portfolio.positions.map((pos) => (
            <TableRow key={pos.symbol}>
              <TableCell className="font-display font-semibold">{pos.symbol}</TableCell>
              <TableCell className="text-right font-data text-sm">{pos.amount.toLocaleString()}</TableCell>
              <TableCell className="text-right font-data text-sm">${pos.valueUsd.toLocaleString()}</TableCell>
              <TableCell className="text-right font-data text-sm text-arena-elements-textSecondary">${pos.entryPrice.toLocaleString()}</TableCell>
              <TableCell className="text-right font-data text-sm">${pos.currentPrice.toLocaleString()}</TableCell>
              <TableCell className={`text-right font-data text-sm font-bold ${pos.pnlPercent >= 0 ? 'text-emerald-400' : 'text-crimson-400'}`}>
                {pos.pnlPercent >= 0 ? '+' : ''}{pos.pnlPercent.toFixed(2)}%
              </TableCell>
              <TableCell className="text-right font-data text-sm text-arena-elements-textSecondary">{pos.weight.toFixed(1)}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
