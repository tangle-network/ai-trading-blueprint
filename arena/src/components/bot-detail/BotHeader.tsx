import { Link } from 'react-router';
import { m } from 'framer-motion';
import type { Address } from 'viem';
import type { Bot } from '~/lib/types/bot';
import { Badge, Button, Identicon } from '@tangle/blueprint-ui/components';
import { useBotDetail } from '~/lib/hooks/useBotDetail';

interface BotHeaderProps {
  bot: Bot;
}

export function BotHeader({ bot }: BotHeaderProps) {
  const { data: detail } = useBotDetail(bot.id);
  const validatorCount = detail?.validator_endpoints?.length ?? 0;

  const metrics = [
    {
      label: 'PnL',
      value: `${bot.pnlPercent >= 0 ? '+' : ''}${bot.pnlPercent.toFixed(1)}%`,
      color: bot.pnlPercent >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error',
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
      color: bot.avgValidatorScore >= 85 ? 'text-arena-elements-icon-success' : bot.avgValidatorScore >= 70 ? 'text-amber-700 dark:text-amber-400' : 'text-arena-elements-icon-error',
      glow: '',
    },
  ];

  return (
    <div className="mb-8">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-2">
        <h1 className="font-display font-bold text-3xl tracking-tight">{bot.name}</h1>
        <div className="flex items-center gap-2">
          <Badge variant={bot.status === 'active' ? 'success' : (bot.status === 'paused' || bot.status === 'needs_config') ? 'amber' : 'secondary'}>
            <div className={`w-1.5 h-1.5 rounded-full ${
              bot.status === 'active' ? 'bg-emerald-700 dark:bg-emerald-400 animate-glow-pulse' : (bot.status === 'paused' || bot.status === 'needs_config') ? 'bg-amber-400' : 'bg-arena-elements-textTertiary'
            }`} />
            {bot.status === 'needs_config' ? 'Needs Config' : bot.status}
          </Badge>
          <Badge variant="accent">{bot.strategyType}</Badge>
        </div>
      </div>

      <div className="flex items-center gap-4 text-sm text-arena-elements-textTertiary mb-6 font-data">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-arena-elements-textSecondary">Operator</span>
          <Identicon address={bot.operatorAddress as Address} size={16} />
          {bot.operatorAddress.slice(0, 6)}...{bot.operatorAddress.slice(-4)}
        </span>
        {validatorCount > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="i-ph:shield-check text-xs text-violet-500" />
            <span className="text-arena-elements-textSecondary">
              {validatorCount} validator{validatorCount !== 1 ? 's' : ''}
            </span>
          </span>
        )}
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
          <m.div
            key={stat.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.4 }}
            className={`glass-card rounded-xl p-4 ${stat.glow}`}
          >
            <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-1.5">
              {stat.label}
            </div>
            <div className={`text-xl font-display font-bold ${stat.color}`}>
              {stat.value}
            </div>
          </m.div>
        ))}
      </div>
    </div>
  );
}
