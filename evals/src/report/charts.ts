/**
 * Vega-Lite SVG chart renderers.
 *
 * Each function takes typed eval data and returns a string of inline SVG
 * that GitHub-flavored markdown will render directly. No canvas dep, no
 * image files on disk, no external URLs.
 *
 * Chart vocabulary mirrors the S-tier per-bot report (SPEC.md §4):
 *   - equityCurveSvg       — line, cumulative return
 *   - drawdownSvg          — filled area, cap line + breach annotations
 *   - tradeScatterSvg      — price line + entry/exit markers sized by PnL
 *   - costDecompSvg        — stacked bar of fees/slippage/gas
 *   - latencyHistSvg       — histogram of decision latency
 *   - revisionLineageSvg   — timeline of revisions with PnL delta per
 *   - dimensionRadarSvg    — radar/spider of judge dimensions vs baselines
 *
 * All charts are 600-wide × 200-tall by default — large enough to read in
 * GitHub's markdown preview, small enough to inline several per section.
 */

import * as vega from 'vega'
import * as lite from 'vega-lite'
import type { TopLevelSpec } from 'vega-lite'

const DEFAULT_W = 600
const DEFAULT_H = 220

async function renderSvg(spec: TopLevelSpec): Promise<string> {
  const compiled = lite.compile(spec).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  const svg = await view.toSVG()
  // Strip the xml declaration — markdown's inline SVG doesn't need it.
  return svg.replace(/^<\?xml[^>]*\?>\s*/, '')
}

// ─── Equity curve ──────────────────────────────────────────────────────

export async function equityCurveSvg(
  days_pnl: Array<{ day: number; equity: number }>,
  opts: { title?: string; width?: number; height?: number } = {},
): Promise<string> {
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? DEFAULT_H,
    title: opts.title ?? 'Cumulative equity',
    data: { values: days_pnl },
    layer: [
      {
        mark: { type: 'line', strokeWidth: 2, color: '#0066cc' },
        encoding: {
          x: { field: 'day', type: 'quantitative', title: 'Day' },
          y: {
            field: 'equity',
            type: 'quantitative',
            title: 'Equity (start = 1.0)',
            scale: { zero: false },
          },
        },
      },
      {
        mark: { type: 'rule', strokeDash: [4, 2], color: '#aaa' },
        data: { values: [{ y: 1.0 }] },
        encoding: { y: { field: 'y', type: 'quantitative' } },
      },
    ],
    config: { view: { stroke: 'transparent' }, axis: { grid: true, gridOpacity: 0.2 } },
  }
  return renderSvg(spec)
}

// ─── Drawdown chart with cap line ──────────────────────────────────────

export async function drawdownSvg(
  days_pnl: Array<{ day: number; dd_pct: number }>,
  capPct: number,
  opts: { title?: string; width?: number; height?: number } = {},
): Promise<string> {
  const breachData = days_pnl.filter((d) => d.dd_pct >= capPct)
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? DEFAULT_H,
    title: opts.title ?? `Drawdown (cap = ${capPct}%)`,
    data: { values: days_pnl.map((d) => ({ ...d, dd_neg: -d.dd_pct })) },
    layer: [
      {
        mark: { type: 'area', color: '#cc4444', opacity: 0.6 },
        encoding: {
          x: { field: 'day', type: 'quantitative', title: 'Day' },
          y: { field: 'dd_neg', type: 'quantitative', title: 'Drawdown %', scale: { domain: [-Math.max(capPct * 1.5, 1), 0] } },
        },
      },
      {
        mark: { type: 'rule', strokeDash: [4, 2], color: '#000' },
        data: { values: [{ y: -capPct }] },
        encoding: { y: { field: 'y', type: 'quantitative' } },
      },
      ...(breachData.length > 0
        ? [{
            mark: { type: 'point', shape: 'triangle-down', color: '#000', size: 100 } as const,
            data: { values: breachData.map((d) => ({ day: d.day, y: -d.dd_pct })) },
            encoding: {
              x: { field: 'day', type: 'quantitative' as const },
              y: { field: 'y', type: 'quantitative' as const },
            },
          }]
        : []),
    ],
    config: { view: { stroke: 'transparent' }, axis: { grid: true, gridOpacity: 0.2 } },
  }
  return renderSvg(spec)
}

// ─── Cost decomposition (stacked bar) ──────────────────────────────────

export async function costDecompSvg(
  data: { fees: number; slippage: number; gas: number; total_gross: number },
  opts: { width?: number; height?: number } = {},
): Promise<string> {
  const values = [
    { component: 'fees', usd: data.fees },
    { component: 'slippage', usd: data.slippage },
    { component: 'gas', usd: data.gas },
  ]
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? 120,
    title: `Cost decomposition — total $${(data.fees + data.slippage + data.gas).toFixed(2)} on $${data.total_gross.toFixed(2)} gross`,
    data: { values },
    mark: { type: 'bar', cornerRadius: 2 },
    encoding: {
      x: { field: 'usd', type: 'quantitative', title: 'USD' },
      y: { field: 'component', type: 'nominal', title: null, sort: ['fees', 'slippage', 'gas'] },
      color: {
        field: 'component',
        type: 'nominal',
        scale: { domain: ['fees', 'slippage', 'gas'], range: ['#0066cc', '#cc4444', '#888'] },
        legend: null,
      },
    },
    config: { view: { stroke: 'transparent' }, axis: { grid: true, gridOpacity: 0.2 } },
  }
  return renderSvg(spec)
}

// ─── Decision latency histogram ────────────────────────────────────────

export async function latencyHistSvg(
  latencies_ms: number[],
  opts: { width?: number; height?: number } = {},
): Promise<string> {
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? DEFAULT_H,
    title: 'Decision latency histogram',
    data: { values: latencies_ms.map((v) => ({ ms: v })) },
    mark: { type: 'bar', color: '#0066cc', cornerRadius: 1 },
    encoding: {
      x: { field: 'ms', type: 'quantitative', bin: { maxbins: 30 }, title: 'Latency (ms)' },
      y: { aggregate: 'count', title: 'Count' },
    },
    config: { view: { stroke: 'transparent' }, axis: { grid: true, gridOpacity: 0.2 } },
  }
  return renderSvg(spec)
}

// ─── Revision lineage (timeline) ───────────────────────────────────────

export async function revisionLineageSvg(
  revisions: Array<{ day: number; reason: string; sharpe_delta?: number }>,
  totalDays: number,
  opts: { width?: number; height?: number } = {},
): Promise<string> {
  if (revisions.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width ?? DEFAULT_W}" height="80"><text x="20" y="40" font-family="sans-serif" font-size="13" fill="#888">No revisions in this period.</text></svg>`
  }
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? 140,
    title: 'Strategy revisions over the period',
    data: { values: revisions.map((r) => ({ day: r.day, sharpe_delta: r.sharpe_delta ?? 0, reason: r.reason.slice(0, 80) })) },
    layer: [
      {
        mark: { type: 'rule', color: '#bbb' },
        data: { values: [{ y: 0 }] },
        encoding: { y: { field: 'y', type: 'quantitative' } },
      },
      {
        mark: { type: 'bar', cornerRadius: 2 },
        encoding: {
          x: { field: 'day', type: 'quantitative', scale: { domain: [0, totalDays] }, title: 'Day of period' },
          y: { field: 'sharpe_delta', type: 'quantitative', title: 'Forward Sharpe Δ' },
          color: {
            condition: { test: 'datum.sharpe_delta > 0', value: '#22aa55' },
            value: '#cc4444',
          },
          tooltip: [
            { field: 'day', type: 'quantitative' },
            { field: 'sharpe_delta', type: 'quantitative', format: '.2f' },
            { field: 'reason', type: 'nominal' },
          ],
        },
      },
    ],
    config: { view: { stroke: 'transparent' }, axis: { grid: true, gridOpacity: 0.2 } },
  }
  return renderSvg(spec)
}

// ─── Dimension radar (judge dimensions vs baselines) ───────────────────

export async function dimensionBarsSvg(
  series: Array<{
    label: string
    dimensions: Record<string, number>
  }>,
  opts: { width?: number; height?: number } = {},
): Promise<string> {
  // Vega-Lite radar charts are awkward; the bar grouping makes the same
  // comparison crisper on small canvases.
  const flat: Array<{ series: string; dimension: string; score: number }> = []
  for (const s of series) {
    for (const [dim, score] of Object.entries(s.dimensions)) {
      flat.push({ series: s.label, dimension: dim, score })
    }
  }
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? 260,
    title: 'Judge dimension scores — this bot vs baselines',
    data: { values: flat },
    mark: { type: 'bar', cornerRadius: 2 },
    encoding: {
      y: { field: 'dimension', type: 'nominal', title: null },
      x: { field: 'score', type: 'quantitative', scale: { domain: [0, 1] }, title: 'Score (0..1)' },
      color: { field: 'series', type: 'nominal', title: null },
      yOffset: { field: 'series', type: 'nominal' },
    },
    config: { view: { stroke: 'transparent' }, axis: { grid: true, gridOpacity: 0.2 } },
  }
  return renderSvg(spec)
}
