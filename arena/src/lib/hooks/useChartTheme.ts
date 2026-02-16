import { useMemo } from 'react';
import { useThemeValue } from './useThemeValue';

export function useChartTheme() {
  const theme = useThemeValue();

  return useMemo(() => {
    const isDark = theme === 'dark';
    return {
      positive: isDark ? '#00FF88' : '#00AA5C',
      negative: isDark ? '#FF3B5C' : '#E5223E',
      positiveGradientStart: isDark ? 'rgba(0, 255, 136, 0.15)' : 'rgba(0, 170, 92, 0.10)',
      negativeGradientStart: isDark ? 'rgba(255, 59, 92, 0.15)' : 'rgba(229, 34, 62, 0.10)',
      gradientEnd: isDark ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 255, 255, 0)',
      tooltipBg: isDark ? 'rgba(18, 18, 26, 0.9)' : 'rgba(255, 255, 255, 0.95)',
      tooltipBorder: isDark ? 'rgba(240, 240, 245, 0.08)' : 'rgba(10, 10, 15, 0.08)',
      tooltipTitleColor: isDark ? '#8A8A9E' : '#5A5A6E',
      tooltipBodyColor: isDark ? '#F0F0F5' : '#0E0E16',
      gridColor: isDark ? 'rgba(240, 240, 245, 0.04)' : 'rgba(10, 10, 15, 0.06)',
      tickColor: isDark ? '#5A5A6E' : '#8A8A9E',
      hoverBorderColor: isDark ? '#0A0A0F' : '#FAFAFE',
    };
  }, [theme]);
}
