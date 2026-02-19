import { useRef, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Chart, registerables } from 'chart.js';
import type { Bot } from '~/lib/types/bot';
import { Card, CardHeader, CardTitle, CardContent } from '@tangle/blueprint-ui/components';
import { useChartTheme } from '~/lib/hooks/useChartTheme';
import { useBotMetrics } from '~/lib/hooks/useBotApi';

Chart.register(...registerables);

interface PerformanceTabProps {
  bot: Bot;
}

export function PerformanceTab({ bot }: PerformanceTabProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const chartTheme = useChartTheme();

  // Try loading real metrics from bot API
  const { data: apiMetrics } = useBotMetrics(bot.id);

  // Use API metrics for sparkline if available, otherwise use bot.sparklineData
  const sparklineData = useMemo(() => {
    if (apiMetrics && apiMetrics.length > 0) {
      return apiMetrics.map(m => m.account_value_usd);
    }
    return bot.sparklineData;
  }, [apiMetrics, bot.sparklineData]);

  useEffect(() => {
    if (!canvasRef.current || sparklineData.length === 0) return;

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    const ctx = canvasRef.current.getContext('2d')!;
    const labels = sparklineData.map((_, i) => `Day ${i + 1}`);
    const positive = bot.pnlPercent >= 0;
    const lineColor = positive ? chartTheme.positive : chartTheme.negative;

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, positive ? chartTheme.positiveGradientStart : chartTheme.negativeGradientStart);
    gradient.addColorStop(1, chartTheme.gradientEnd);

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Portfolio Value',
            data: sparklineData,
            borderColor: lineColor,
            backgroundColor: gradient,
            borderWidth: 2,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: lineColor,
            pointHoverBorderColor: chartTheme.hoverBorderColor,
            pointHoverBorderWidth: 2,
            tension: 0.4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: chartTheme.tooltipBg,
            borderColor: chartTheme.tooltipBorder,
            borderWidth: 1,
            titleColor: chartTheme.tooltipTitleColor,
            bodyColor: chartTheme.tooltipBodyColor,
            titleFont: { family: 'IBM Plex Mono', size: 11 },
            bodyFont: { family: 'IBM Plex Mono', size: 12, weight: 'bold' as const },
            padding: 10,
            cornerRadius: 8,
            displayColors: false,
          },
        },
        scales: {
          x: {
            display: true,
            grid: { display: false },
            border: { display: false },
            ticks: {
              maxTicksLimit: 7,
              color: chartTheme.tickColor,
              font: { family: 'IBM Plex Mono', size: 10 },
            },
          },
          y: {
            display: true,
            grid: {
              color: chartTheme.gridColor,
            },
            border: { display: false },
            ticks: {
              color: chartTheme.tickColor,
              font: { family: 'IBM Plex Mono', size: 10 },
            },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
    };
  }, [bot, sparklineData, chartTheme]);

  const summaryCards = [
    {
      label: 'Total Return',
      value: `$${bot.pnlAbsolute.toLocaleString()}`,
      color: bot.pnlPercent >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error',
    },
    {
      label: 'Total Trades',
      value: bot.totalTrades.toString(),
      color: '',
    },
    {
      label: 'Active Since',
      value: new Date(bot.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      color: '',
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Performance (30D)</CardTitle>
        </CardHeader>
        <CardContent>
          {sparklineData.length > 0 ? (
            <div className="h-[320px]">
              <canvas ref={canvasRef} />
            </div>
          ) : (
            <div className="h-[320px] flex items-center justify-center">
              <div className="text-center">
                <div className="i-ph:chart-line text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
                <p className="text-sm text-arena-elements-textSecondary">
                  No performance data available yet.
                  {bot.id.startsWith('service-') && ' Connect a bot API to see real metrics.'}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-3 gap-4">
        {summaryCards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + i * 0.06 }}
          >
            <Card className="p-5">
              <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary mb-2">
                {card.label}
              </div>
              <div className={`text-2xl font-display font-bold ${card.color}`}>
                {card.value}
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
