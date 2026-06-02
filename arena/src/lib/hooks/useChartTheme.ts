import { useMemo } from 'react';
import { useThemeValue } from '@tangle-network/blueprint-ui';

export function useChartTheme() {
  const theme = useThemeValue();

  return useMemo(() => {
    const isDark = theme === 'dark';
    return {
      positive: isDark ? '#50D2C1' : '#1FA67D',
      negative: isDark ? '#ED7088' : '#D94861',
      positiveGradientStart: isDark ? 'rgba(80, 210, 193, 0.16)' : 'rgba(31, 166, 125, 0.12)',
      negativeGradientStart: isDark ? 'rgba(237, 112, 136, 0.16)' : 'rgba(217, 72, 97, 0.10)',
      gradientEnd: isDark ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 255, 255, 0)',
      tooltipBg: isDark ? 'rgba(15, 26, 31, 0.94)' : 'rgba(255, 255, 255, 0.95)',
      tooltipBorder: isDark ? 'rgba(148, 158, 156, 0.18)' : 'rgba(10, 10, 15, 0.08)',
      tooltipTitleColor: isDark ? '#949E9C' : '#44445A',
      tooltipBodyColor: isDark ? '#F0F0F5' : '#0E0E16',
      gridColor: isDark ? 'rgba(148, 158, 156, 0.08)' : 'rgba(10, 10, 15, 0.08)',
      tickColor: isDark ? '#949E9C' : '#6B6B82',
      hoverBorderColor: isDark ? '#0A0A0F' : '#FAFAFE',
    };
  }, [theme]);
}
