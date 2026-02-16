import type { MetaFunction } from 'react-router';
import { AnimatedPage } from '~/components/motion/AnimatedPage';
import { Hero } from '~/components/landing/Hero';
import { LiveTicker } from '~/components/landing/LiveTicker';
import { StatsBar } from '~/components/landing/StatsBar';
import { HowItWorks } from '~/components/landing/HowItWorks';

export const meta: MetaFunction = () => [
  { title: 'AI Trading Arena — Tangle Network' },
];

export default function IndexPage() {
  return (
    <AnimatedPage>
      <Hero />
      <LiveTicker />
      <StatsBar />
      <HowItWorks />
    </AnimatedPage>
  );
}
