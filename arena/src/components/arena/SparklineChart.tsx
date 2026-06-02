import { useMemo } from 'react';
import { useChartTheme } from '~/lib/hooks/useChartTheme';

interface SparklineChartProps {
  data: number[];
  positive: boolean;
  width?: number;
  height?: number;
}

function buildPath(data: number[], width: number, height: number): string {
  const values = data.filter((value) => Number.isFinite(value));
  if (values.length === 0) return '';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const topPadding = 3;
  const bottomPadding = 3;
  const drawableHeight = Math.max(1, height - topPadding - bottomPadding);

  return values.map((value, index) => {
    const x = index * step;
    const y = topPadding + ((max - value) / span) * drawableHeight;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

export function SparklineChart({ data, positive, width = 80, height = 30 }: SparklineChartProps) {
  const chartTheme = useChartTheme();
  const color = positive ? chartTheme.positive : chartTheme.negative;
  const path = useMemo(() => buildPath(data, width, height), [data, height, width]);
  const gradientId = useMemo(
    () => `sparkline-${positive ? 'up' : 'down'}-${width}-${height}-${Math.abs(path.length)}`,
    [height, path.length, positive, width],
  );

  if (!path) {
    return (
      <div className="flex items-center justify-center text-arena-elements-textTertiary" style={{ width, height }}>
        <span className="font-data text-xs">—</span>
      </div>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={positive ? 'Positive return sparkline' : 'Negative return sparkline'}
      className="block overflow-visible"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${path} L${width},${height} L0,${height} Z`}
        fill={`url(#${gradientId})`}
        opacity="0.8"
      />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
