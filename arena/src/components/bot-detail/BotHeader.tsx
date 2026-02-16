import { Link } from 'react-router';
import { motion } from 'framer-motion';
import type { Bot } from '~/lib/types/bot';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';

interface BotHeaderProps {
  bot: Bot;
}

export function BotHeader({ bot }: BotHeaderProps) {
  const metrics = [
    {
      label: 'PnL',
      value: `${bot.pnlPercent >= 0 ? '+' : ''}${bot.pnlPercent.toFixed(1)}%`,
      color: bot.pnlPercent >= 0 ? 'text-emerald-400' : 'text-crimson-400',
      glow: bot.pnlPercent >= 0 ? 'glow-emerald' : 'glow-crimson',
    },
    { label: 'Sharpe', value: bot.sharpeRatio.toFixed(2), color: '', glow: '' },
    {
      label: 'Max DD',
      value: `${bot.maxDrawdown.toFixed(1)}%`,
      color: 'text-crimson-400',
      glow: '',
    },
    { label: 'Win Rate', value: `${bot.winRate}%`, color: '', glow: '' },
    { label: 'TVL', value: `$${(bot.tvl / 1000).toFixed(0)}K`, color: '', glow: '' },
    {
      label: 'Avg Score',
      value: `${bot.avgValidatorScore}`,
      color: bot.avgValidatorScore >= 85 ? 'text-emerald-400' : bot.avgValidatorScore >= 70 ? 'text-amber-400' : 'text-crimson-400',
      glow: '',
    },
  ];

  return (
    <div className="mb-8">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-2">
        <h1 className="font-display font-bold text-3xl tracking-tight">{bot.name}</h1>
        <div className="flex items-center gap-2">
          <Badge variant={bot.status === 'active' ? 'success' : bot.status === 'paused' ? 'amber' : 'destructive'}>
            <div className={`w-1.5 h-1.5 rounded-full ${
              bot.status === 'active' ? 'bg-emerald-400 animate-glow-pulse' : bot.status === 'paused' ? 'bg-amber-400' : 'bg-crimson-400'
            }`} />
            {bot.status}
          </Badge>
          <Badge variant="accent">{bot.strategyType}</Badge>
        </div>
      </div>

      <div className="flex items-center gap-4 text-sm text-arena-elements-textTertiary mb-6 font-data">
        <span>
          <span className="text-arena-elements-textSecondary">Operator</span>{' '}
          {bot.operatorAddress.slice(0, 6)}...{bot.operatorAddress.slice(-4)}
        </span>
        {bot.vaultAddress && bot.vaultAddress !== '0x0000000000000000000000000000000000000000' && (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/vault/${bot.vaultAddress}`}>
              <span className="i-ph:wallet text-xs" /> View Vault
            </Link>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {metrics.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.4 }}
            className={`glass-card rounded-xl p-4 ${stat.glow}`}
          >
            <div className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1.5">
              {stat.label}
            </div>
            <div className={`text-xl font-display font-bold ${stat.color}`}>
              {stat.value}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
