import { useRef, useEffect } from 'react';
import { Chart, registerables } from 'chart.js';
import { useChartTheme } from '~/lib/hooks/useChartTheme';

Chart.register(...registerables);

interface SparklineChartProps {
  data: number[];
  positive: boolean;
  width?: number;
  height?: number;
}

export function SparklineChart({ data, positive, width = 80, height = 30 }: SparklineChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const chartTheme = useChartTheme();

  useEffect(() => {
    if (!canvasRef.current || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    const ctx = canvasRef.current.getContext('2d')!;
    const color = positive ? chartTheme.positive : chartTheme.negative;

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, positive ? chartTheme.positiveGradientStart : chartTheme.negativeGradientStart);
    gradient.addColorStop(1, chartTheme.gradientEnd);

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: data.map((_, i) => i.toString()),
        datasets: [
          {
            data,
            borderColor: color,
            borderWidth: 1.5,
            fill: true,
            backgroundColor: gradient,
            pointRadius: 0,
            tension: 0.4,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false },
        },
        animation: false,
      },
    });

    return () => {
      chartRef.current?.destroy();
    };
  }, [data, positive, height, chartTheme]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-arena-elements-textTertiary" style={{ width, height }}>
        <span className="text-[10px] font-data">—</span>
      </div>
    );
  }

  return <canvas ref={canvasRef} width={width} height={height} />;
}
