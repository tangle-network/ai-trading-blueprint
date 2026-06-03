import { m } from 'framer-motion';
import { AnimatedNumber } from '~/components/motion/AnimatedNumber';
import { Skeleton } from '@tangle-network/blueprint-ui/components';

interface VaultStatsProps {
  tvl?: number;
  sharePrice?: number;
  totalShares?: number;
  assetSymbol: string;
  paused: boolean;
  isLoading: boolean;
  isConnected: boolean;
  approximateNav: boolean;
  userSharesFormatted?: number;
}

export function VaultStats({ tvl, sharePrice, totalShares, assetSymbol, paused, isLoading, isConnected, approximateNav, userSharesFormatted }: VaultStatsProps) {
  const stats = [
    {
      label: 'Total Value Locked',
      value: tvl,
      prefix: '',
      suffix: ` ${assetSymbol}`,
      decimals: 2,
      color: '',
      icon: 'i-ph:coins',
    },
    {
      label: 'Share Price',
      value: sharePrice,
      prefix: '',
      suffix: ` ${assetSymbol}`,
      decimals: 6,
      color: '',
      icon: 'i-ph:chart-line',
    },
    {
      label: 'Total Shares',
      value: totalShares,
      prefix: '',
      suffix: '',
      decimals: 0,
      color: '',
      icon: 'i-ph:wallet',
    },
    {
      label: 'Your Shares',
      value: isConnected ? (userSharesFormatted ?? 0) : undefined,
      prefix: '',
      suffix: '',
      decimals: 4,
      color: userSharesFormatted && userSharesFormatted > 0 ? 'text-arena-elements-icon-success' : '',
      icon: 'i-ph:user',
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat, i) => (
        <m.div
          key={stat.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06, duration: 0.4 }}
          className={`glass-card rounded-[6px] p-5 ${
            stat.label === 'Total Value Locked' && stat.value != null && stat.value > 0
              ? 'glow-emerald' : ''
          }${
            stat.label === 'Your Shares' && stat.value != null && stat.value > 0
              ? 'glow-emerald' : ''
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={`${stat.icon} text-base text-arena-elements-textTertiary`} />
            <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
              {stat.label}
            </div>
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : stat.value != null ? (
            <div className={`text-2xl font-display font-bold ${stat.color}`}>
              <AnimatedNumber
                value={stat.value}
                prefix={stat.prefix}
                suffix={stat.suffix}
                decimals={stat.decimals}
              />
              {approximateNav && (stat.label === 'Total Value Locked' || stat.label === 'Share Price') && (
                <span className="ml-1 align-middle text-sm text-amber-600 dark:text-amber-400">~</span>
              )}
            </div>
          ) : (
            <div className="text-2xl font-display font-bold text-arena-elements-textTertiary">—</div>
          )}
          {stat.label === 'Total Value Locked' && paused && (
            <div className="mt-1 text-xs font-data uppercase tracking-wider text-crimson-600 dark:text-crimson-400">Paused</div>
          )}
        </m.div>
      ))}
    </div>
  );
}
