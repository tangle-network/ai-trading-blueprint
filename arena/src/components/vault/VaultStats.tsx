import { motion } from 'framer-motion';
import { AnimatedNumber } from '~/components/motion/AnimatedNumber';
import { Skeleton } from '~/components/ui/skeleton';

interface VaultStatsProps {
  tvl?: number;
  sharePrice?: number;
  totalShares?: number;
  assetSymbol: string;
  paused: boolean;
  isLoading: boolean;
  userSharesFormatted?: number;
}

export function VaultStats({ tvl, sharePrice, totalShares, assetSymbol, paused, isLoading, userSharesFormatted }: VaultStatsProps) {
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
      value: userSharesFormatted ?? 0,
      prefix: '',
      suffix: '',
      decimals: 4,
      color: userSharesFormatted && userSharesFormatted > 0 ? 'text-emerald-400' : '',
      icon: 'i-ph:user',
    },
  ];

  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {stats.map((stat, i) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06, duration: 0.4 }}
          className="glass-card rounded-xl p-5"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={`${stat.icon} text-sm text-arena-elements-textTertiary`} />
            <div className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
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
            </div>
          ) : (
            <div className="text-2xl font-display font-bold text-arena-elements-textTertiary">—</div>
          )}
          {stat.label === 'Total Value Locked' && paused && (
            <div className="mt-1 text-[10px] font-data uppercase tracking-wider text-crimson-400">Paused</div>
          )}
        </motion.div>
      ))}
    </div>
  );
}
