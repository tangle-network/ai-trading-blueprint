import { motion } from 'framer-motion';

const steps = [
  {
    icon: 'i-ph:rocket-launch-fill',
    title: 'Deploy',
    description: 'Deploy an AI trading bot as a Tangle Blueprint. Choose your strategy, configure risk parameters, and fund your vault.',
    color: 'emerald',
    number: '01',
  },
  {
    icon: 'i-ph:shield-check-fill',
    title: 'Validate',
    description: 'Every trade is scored by independent validator nodes using AI reasoning. Transparent scoring ensures full accountability.',
    color: 'violet',
    number: '02',
  },
  {
    icon: 'i-ph:trophy-fill',
    title: 'Compete',
    description: 'Bots compete on risk-adjusted returns. Climb the leaderboard, build on-chain reputation, and attract deposits.',
    color: 'amber',
    number: '03',
  },
];

const colorMap: Record<string, { icon: string; bg: string; border: string; number: string }> = {
  emerald: {
    icon: 'text-emerald-400',
    bg: 'bg-emerald-500/8',
    border: 'border-emerald-500/20',
    number: 'text-emerald-500/20',
  },
  violet: {
    icon: 'text-violet-400',
    bg: 'bg-violet-500/8',
    border: 'border-violet-500/20',
    number: 'text-violet-500/20',
  },
  amber: {
    icon: 'text-amber-400',
    bg: 'bg-amber-500/8',
    border: 'border-amber-500/20',
    number: 'text-amber-500/20',
  },
};

export function HowItWorks() {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="font-display font-bold text-3xl sm:text-4xl tracking-tight">
            How It Works
          </h2>
          <p className="mt-3 text-arena-elements-textSecondary max-w-lg mx-auto">
            Three steps from deployment to competition
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6">
          {steps.map((step, i) => {
            const c = colorMap[step.color];
            return (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ delay: i * 0.1, duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="glass-card rounded-xl p-8 relative overflow-hidden group"
              >
                {/* Large background number */}
                <div className={`absolute -top-4 -right-2 font-display font-900 text-[120px] leading-none ${c.number} select-none pointer-events-none`}>
                  {step.number}
                </div>

                <div className="relative z-10">
                  <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl ${c.bg} border ${c.border} mb-5`}>
                    <div className={`${step.icon} text-xl ${c.icon}`} />
                  </div>
                  <h3 className="font-display font-bold text-lg mb-3 text-arena-elements-textPrimary">
                    {step.title}
                  </h3>
                  <p className="text-sm text-arena-elements-textSecondary leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
