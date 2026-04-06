import { useRef, useEffect, useMemo } from 'react';
import { m } from 'framer-motion';
import type { Chart as ChartType } from 'chart.js';
import type { Bot } from '~/lib/types/bot';
import { Card, CardHeader, CardTitle, CardContent } from '@tangle-network/blueprint-ui/components';
import { useChartTheme } from '~/lib/hooks/useChartTheme';
import { useBotMetrics } from '~/lib/hooks/useBotApi';
import { Skeleton, SkeletonCard } from '~/components/ui/Skeleton';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { buildPerformanceChartPoints } from './performanceChart';

interface PerformanceTabProps {
  bot: Bot;
  isLive: boolean;
}

export function PerformanceTab({ bot, isLive }: PerformanceTabProps) {
  const operatorAuth = useOperatorAuth(bot.operatorApiUrl ?? '');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartType | null>(null);
  const chartTheme = useChartTheme();

  // Try loading real metrics from bot API
  const { data: apiMetrics, isLoading } = useBotMetrics(bot.id, 30, {
    operatorApiUrl: bot.operatorApiUrl,
    operatorKind: bot.operatorKind,
    refetchInterval: isLive ? 15_000 : false,
  });

  const chartPoints = useMemo(
    () => buildPerformanceChartPoints(apiMetrics, bot.sparklineData),
    [apiMetrics, bot.sparklineData],
  );

  useEffect(() => {
    if (!canvasRef.current || chartPoints.length === 0) return;

    let cancelled = false;

    import('chart.js').then(({ Chart, registerables }) => {
      if (cancelled || !canvasRef.current) return;
      Chart.register(...registerables);

      if (chartRef.current) {
        chartRef.current.destroy();
      }

      const ctx = canvasRef.current.getContext('2d')!;
      const labels = chartPoints.map((point) => point.label);
      const values = chartPoints.map((point) => point.value);
      const latestPoint = values[values.length - 1] ?? 0;
      const firstPoint = values[0] ?? latestPoint;
      const positive = latestPoint >= firstPoint;
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
              data: values,
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
              callbacks: {
                title: (tooltipItems) => {
                  const dataIndex = tooltipItems[0]?.dataIndex ?? 0;
                  return chartPoints[dataIndex]?.tooltipLabel ?? tooltipItems[0]?.label ?? '';
                },
              },
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
    });

    return () => {
      cancelled = true;
      chartRef.current?.destroy();
    };
  }, [chartPoints, chartTheme]);

  const latestMetrics = apiMetrics && apiMetrics.length > 0 ? apiMetrics[apiMetrics.length - 1] : null;
  const totalReturnValue = latestMetrics
    ? latestMetrics.realized_pnl + latestMetrics.unrealized_pnl
    : bot.pnlAbsolute;
  const totalTradesValue = latestMetrics?.trade_count ?? bot.totalTrades;

  const summaryCards = [
    {
      label: 'Total Return',
      value: `$${totalReturnValue.toLocaleString()}`,
      color: totalReturnValue >= 0 ? 'text-arena-elements-icon-success' : 'text-arena-elements-icon-error',
    },
    {
      label: 'Total Trades',
      value: totalTradesValue.toString(),
      color: '',
    },
    {
      label: 'Active Since',
      value: new Date(bot.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      color: '',
    },
  ];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Performance (30D)</CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[320px] w-full" />
          </CardContent>
        </Card>
        <div className="grid sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (bot.verificationState === 'unverified') {
    return (
      <OperatorAccessCard
        title="Live performance unavailable"
        description="This bot has not been verified against the operator yet, so performance data is hidden until a fresh sync succeeds."
        apiUrl={bot.operatorApiUrl ?? ''}
      />
    );
  }

  if (!operatorAuth.isAuthenticated) {
    return <OperatorAccessCard apiUrl={bot.operatorApiUrl ?? ''} />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Performance (30D)</CardTitle>
        </CardHeader>
        <CardContent>
          {chartPoints.length > 0 ? (
            <div className="h-[320px]">
              <canvas ref={canvasRef} />
            </div>
          ) : (
            <div className="h-[320px] flex items-center justify-center">
              <div className="text-center">
                <div className="i-ph:chart-line text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
                <p className="text-sm text-arena-elements-textSecondary">
                  No performance data available yet.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-3 gap-4">
        {summaryCards.map((card, i) => (
          <m.div
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
          </m.div>
        ))}
      </div>
    </div>
  );
}
