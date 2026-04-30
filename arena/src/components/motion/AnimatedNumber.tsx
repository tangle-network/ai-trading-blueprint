import { useEffect, useRef, useState } from 'react';
import { m, useInView, useSpring, useTransform } from 'framer-motion';
import { formatNumber } from '~/lib/format';

interface AnimatedNumberProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
  duration?: number;
}

export function AnimatedNumber({
  value,
  prefix = '',
  suffix = '',
  decimals = 0,
  className,
  duration = 1.5,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });
  const [displayed, setDisplayed] = useState('0');

  const spring = useSpring(0, {
    duration: duration * 1000,
    bounce: 0,
  });

  const display = useTransform(spring, (v) => {
    return formatNumber(v, { maximumFractionDigits: decimals });
  });

  useEffect(() => {
    if (isInView) {
      spring.set(value);
    }
  }, [isInView, value, spring]);

  useEffect(() => {
    const unsub = display.on('change', (v) => setDisplayed(v));
    return unsub;
  }, [display]);

  return (
    <m.span ref={ref} className={className}>
      {prefix}{displayed}{suffix}
    </m.span>
  );
}
