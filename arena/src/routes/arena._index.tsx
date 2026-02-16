import { useState } from 'react';
import { motion } from 'framer-motion';
import type { MetaFunction } from 'react-router';
import { useBots } from '~/lib/hooks/useBots';
import { useBotEnrichment } from '~/lib/hooks/useBotEnrichment';
import { AnimatedPage } from '~/components/motion/AnimatedPage';
import { FilterBar } from '~/components/arena/FilterBar';
import { LeaderboardTable } from '~/components/arena/LeaderboardTable';
import { Badge } from '~/components/ui/badge';

export const meta: MetaFunction = () => [
  { title: 'Leaderboard — AI Trading Arena' },
];

export default function ArenaIndexPage() {
  const [search, setSearch] = useState('');
  const [timePeriod, setTimePeriod] = useState('30d');
  const { bots: rawBots, isLoading, isOnChain } = useBots();

  // Enrich on-chain bots with performance data from their HTTP APIs
  const bots = useBotEnrichment(rawBots);

  const filteredBots = bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(search.toLowerCase()) ||
      bot.strategyType.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <AnimatedPage>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <h1 className="font-display font-bold text-3xl sm:text-4xl tracking-tight">
              Leaderboard
            </h1>
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-glow-pulse" />
              <span className="text-[11px] font-data font-semibold text-emerald-400 uppercase tracking-wider">
                Live
              </span>
            </div>
            {!isOnChain && (
              <Badge variant="secondary">Demo Data</Badge>
            )}
          </div>
          <p className="text-arena-elements-textSecondary">
            {isOnChain
              ? 'Live on-chain data. Click any bot for full transparency.'
              : 'Ranked by risk-adjusted returns. Click any bot for full transparency.'}
          </p>
        </motion.div>

        <FilterBar
          search={search}
          onSearchChange={setSearch}
          timePeriod={timePeriod}
          onTimePeriodChange={setTimePeriod}
        />

        {isLoading ? (
          <div className="glass-card rounded-xl p-16 text-center">
            <div className="i-ph:arrow-clockwise text-2xl text-arena-elements-textTertiary mb-3 mx-auto animate-spin" />
            <p className="text-sm text-arena-elements-textSecondary">Loading on-chain data...</p>
          </div>
        ) : (
          <LeaderboardTable bots={filteredBots} />
        )}
      </div>
    </AnimatedPage>
  );
}
