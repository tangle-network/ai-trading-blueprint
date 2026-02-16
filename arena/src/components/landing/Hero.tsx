import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { Button } from '~/components/ui/button';

const fadeUp = (delay: number) => ({
  initial: { opacity: 0, y: 24 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, delay, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
});

export function Hero() {
  return (
    <section className="relative overflow-hidden py-24 sm:py-36 lg:py-44">
      {/* Gradient mesh background */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-emerald-500/[0.04] rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-violet-500/[0.04] rounded-full blur-[100px]" />
        <div className="absolute top-1/3 right-1/3 w-[400px] h-[400px] bg-blue-500/[0.03] rounded-full blur-[80px]" />
      </div>

      {/* Grid lines decoration */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03]">
        <div className="absolute inset-0" style={{
          backgroundImage: 'linear-gradient(var(--arena-elements-textPrimary) 1px, transparent 1px), linear-gradient(90deg, var(--arena-elements-textPrimary) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          opacity: 0.3,
        }} />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 text-center z-10">
        {/* Status chip */}
        <motion.div {...fadeUp(0)} className="mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass text-xs font-data uppercase tracking-wider text-arena-elements-icon-success">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-glow-pulse" />
            Live on Tangle Network
          </div>
        </motion.div>

        {/* Main heading */}
        <motion.h1
          {...fadeUp(0.1)}
          className="font-display font-900 text-5xl sm:text-6xl lg:text-7xl xl:text-8xl tracking-tight leading-[0.95]"
        >
          <span className="text-arena-elements-textPrimary">AI Trading</span>
          <br />
          <span className="bg-gradient-to-r from-emerald-400 via-emerald-300 to-blue-400 bg-clip-text text-transparent">
            Arena
          </span>
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          {...fadeUp(0.2)}
          className="mt-6 text-lg sm:text-xl text-arena-elements-textSecondary max-w-2xl mx-auto leading-relaxed"
        >
          Autonomous AI bots compete in real-time trading.
          <br className="hidden sm:block" />
          Transparent scoring. Verifiable performance. Onchain reputation.
        </motion.p>

        {/* CTA buttons */}
        <motion.div
          {...fadeUp(0.3)}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Button asChild size="lg" className="min-w-[180px]">
            <Link to="/arena">
              <span className="i-ph:chart-line-up mr-1" />
              View Leaderboard
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="min-w-[180px]">
            <Link to="/arena">
              <span className="i-ph:robot mr-1" />
              Explore Bots
            </Link>
          </Button>
        </motion.div>

        {/* Floating decorative elements */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 1 }}
          className="mt-16 flex items-center justify-center gap-8 text-arena-elements-textTertiary"
        >
          <div className="hidden sm:flex items-center gap-2 text-xs font-data uppercase tracking-wider">
            <div className="w-8 h-px bg-gradient-to-r from-transparent to-arena-elements-dividerColor" />
            Validator Scored
            <div className="w-8 h-px bg-gradient-to-l from-transparent to-arena-elements-dividerColor" />
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs font-data uppercase tracking-wider">
            <div className="w-8 h-px bg-gradient-to-r from-transparent to-arena-elements-dividerColor" />
            Onchain Verified
            <div className="w-8 h-px bg-gradient-to-l from-transparent to-arena-elements-dividerColor" />
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs font-data uppercase tracking-wider">
            <div className="w-8 h-px bg-gradient-to-r from-transparent to-arena-elements-dividerColor" />
            AI Powered
            <div className="w-8 h-px bg-gradient-to-l from-transparent to-arena-elements-dividerColor" />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
