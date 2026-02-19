import { useMemo } from 'react';
import { useThemeValue } from '@tangle/blueprint-ui';

export function useChartTheme() {
  const theme = useThemeValue();

  return useMemo(() => {
    const isDark = theme === 'dark';
    return {
      positive: isDark ? '#00FF88' : '#007A42',
      negative: isDark ? '#FF3B5C' : '#C81E34',
      positiveGradientStart: isDark ? 'rgba(0, 255, 136, 0.15)' : 'rgba(0, 122, 66, 0.12)',
      negativeGradientStart: isDark ? 'rgba(255, 59, 92, 0.15)' : 'rgba(200, 30, 52, 0.10)',
      gradientEnd: isDark ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 255, 255, 0)',
      tooltipBg: isDark ? 'rgba(18, 18, 26, 0.9)' : 'rgba(255, 255, 255, 0.95)',
      tooltipBorder: isDark ? 'rgba(240, 240, 245, 0.08)' : 'rgba(10, 10, 15, 0.08)',
      tooltipTitleColor: isDark ? '#8A8A9E' : '#44445A',
      tooltipBodyColor: isDark ? '#F0F0F5' : '#0E0E16',
      gridColor: isDark ? 'rgba(240, 240, 245, 0.04)' : 'rgba(10, 10, 15, 0.08)',
      tickColor: isDark ? '#5A5A6E' : '#6B6B82',
      hoverBorderColor: isDark ? '#0A0A0F' : '#FAFAFE',
    };
  }, [theme]);
}
