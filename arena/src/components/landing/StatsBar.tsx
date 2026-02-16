import { motion } from 'framer-motion';
import { useBots } from '~/lib/hooks/useBots';
import { AnimatedNumber } from '~/components/motion/AnimatedNumber';

export function StatsBar() {
  const { bots } = useBots();

  const totalBots = bots.length;
  const totalTvl = bots.reduce((sum, b) => sum + b.tvl, 0);
  const totalTrades = bots.reduce((sum, b) => sum + b.totalTrades, 0);
  const avgScore = bots.length > 0
    ? Math.round(bots.reduce((sum, b) => sum + b.avgValidatorScore, 0) / bots.length)
    : 0;

  const stats = [
    { label: 'Active Bots', value: totalBots, prefix: '', suffix: '', decimals: 0, icon: 'i-ph:robot', color: 'emerald' },
    { label: 'Total TVL', value: totalTvl / 1000, prefix: '$', suffix: 'K', decimals: 0, icon: 'i-ph:coins', color: 'amber' },
    { label: 'Trades Executed', value: totalTrades, prefix: '', suffix: '', decimals: 0, icon: 'i-ph:swap', color: 'blue' },
    { label: 'Avg Validator Score', value: avgScore, prefix: '', suffix: '/100', decimals: 0, icon: 'i-ph:shield-check', color: 'violet' },
  ];

  const colorMap: Record<string, { icon: string; glow: string; bg: string }> = {
    emerald: { icon: 'text-arena-elements-icon-success', glow: 'shadow-[0_0_20px_rgba(0,255,136,0.06)]', bg: 'bg-emerald-500/8' },
    amber: { icon: 'text-amber-700 dark:text-amber-400', glow: 'shadow-[0_0_20px_rgba(255,184,0,0.06)]', bg: 'bg-amber-500/8' },
    blue: { icon: 'text-blue-700 dark:text-blue-400', glow: 'shadow-[0_0_20px_rgba(0,180,255,0.06)]', bg: 'bg-blue-500/8' },
    violet: { icon: 'text-violet-700 dark:text-violet-400', glow: 'shadow-[0_0_20px_rgba(139,92,246,0.06)]', bg: 'bg-violet-500/8' },
  };

  return (
    <section className="py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat, i) => {
            const c = colorMap[stat.color];
            return (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ delay: i * 0.08, duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
                className={`glass-card rounded-xl p-6 ${c.glow}`}
              >
                <div className={`inline-flex items-center justify-center w-10 h-10 rounded-lg ${c.bg} mb-4`}>
                  <div className={`${stat.icon} text-lg ${c.icon}`} />
                </div>
                <div className="text-3xl font-display font-bold text-arena-elements-textPrimary mb-1">
                  <AnimatedNumber
                    value={stat.value}
                    prefix={stat.prefix}
                    suffix={stat.suffix}
                    decimals={stat.decimals}
                  />
                </div>
                <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                  {stat.label}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
