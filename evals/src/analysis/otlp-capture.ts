/**
 * OTLP capture — turn a completed eval run's cells into the OTLP-JSONL trace
 * dataset the SDK trace analyst reads via `OtlpFileTraceStore`.
 *
 * This is the data-capture half of the RLM analyst. The regex classifier read
 * one thin field of one file; the RLM analyst reads EVERYTHING we captured —
 * every conversation turn, the bot's work-product (trades/strategy/cycles),
 * and (when present) the deterministic-tick side effects (decisions.jsonl +
 * metrics) pulled out of the sandbox. Each cell becomes one OTLP trace; each
 * piece of raw data becomes a span the analyst can query and cite.
 *
 * Output format (matches `OtlpFileTraceStore`'s `readOtlpSpan` parser exactly):
 * ONE span object PER LINE — a flat record with `trace_id` / `span_id` /
 * `parent_span_id`, `name`, ISO `start_time` / `end_time`, a `status` object,
 * and a plain-object `attributes` map (NOT the OTLP `{key,value:{stringValue}}`
 * array form, and NOT wrapped in resourceSpans/scopeSpans). Spans that share a
 * `trace_id` are grouped into one trace by the store.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** One line of the OTLP-JSONL dataset — a flat span the store indexes. */
interface SpanLine {
  trace_id: string
  span_id: string
  parent_span_id?: string
  name: string
  start_time: string
  end_time: string
  status: { code: 'OK' | 'ERROR'; message?: string }
  /** Plain key→value map. Strings/numbers/bools pass through; the store reads
   *  `service.name` etc. from here. Complex values are JSON-stringified so they
   *  remain searchable text for the actor's regex tools. */
  attributes: Record<string, string | number | boolean>
}

/** Raw per-cell record captured by the eval. Conversation + work-product + the
 *  deterministic-tick side effects when the capture step pulled them. */
interface CachedCell {
  arm?: string
  cellId?: string
  scenarioId?: string
  rep?: number
  error?: string
  artifact?: {
    ended_by?: string
    turns?: Array<{ user_message?: string; bot_reply_text?: string }>
    bot_artifacts?: {
      execution?: { trades_total?: number; trades?: unknown[] }
      current_strategy?: { harness_version?: number; source?: string }
      self_improvement?: { cycles_fired?: number }
      flags?: string[]
    } | null
    /** Deterministic-tick side effects, pulled from the sandbox by the capture
     *  step. Absent when the tick never fired OR the eval never captured them —
     *  the analyst distinguishes the two via `tick.side_effects_captured`. */
    tick_side_effects?: {
      decisions_jsonl?: string
      metrics_latest?: unknown
      strategies?: Record<string, string>
    } | null
  } | null
  judgeScores?: Record<string, { composite?: number; dimensions?: Record<string, number> }>
}

function hexId(seed: string, bytes: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2)
}

/** Coerce any captured value into a searchable attribute scalar. */
function attrVal(value: unknown): string | number | boolean {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? null)
}

function buildAttrs(pairs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(pairs)) out[k] = attrVal(v)
  return out
}

// Deterministic, monotonically increasing ISO timestamps. The analyst orders
// spans by start_time; it does not need real wall-clock time. Fixed base keeps
// captures reproducible across runs.
const BASE_EPOCH_MS = 1_700_000_000_000
let tick = 0
function nextIso(): string {
  tick += 1000
  return new Date(BASE_EPOCH_MS + tick).toISOString()
}

function spansForCell(cell: CachedCell, traceId: string): SpanLine[] {
  const a = cell.artifact
  const ba = a?.bot_artifacts
  const tickFx = a?.tick_side_effects
  const rootId = hexId(`${traceId}:root`, 8)
  const spans: SpanLine[] = []
  const service = { 'service.name': 'ai-trading-eval' }

  const trades = ba?.execution?.trades_total ?? 0
  const sv = ba?.current_strategy?.harness_version ?? 0
  const cycles = ba?.self_improvement?.cycles_fired ?? 0
  const decisionsText = tickFx?.decisions_jsonl ?? ''
  const decisionLines = decisionsText.trim() ? decisionsText.trim().split('\n').filter(Boolean) : []
  const tickFired = decisionLines.length > 0 || tickFx?.metrics_latest != null
  // Provenance: did the eval even attempt to pull the tick side effects out of
  // the sandbox? When false, tick.fired=false means "not captured", NOT "did
  // not run" — the analyst must not infer fabrication from it.
  const sideEffectsCaptured = tickFx != null

  const rootStart = nextIso()
  spans.push({
    trace_id: traceId,
    span_id: rootId,
    name: `cell:${cell.scenarioId ?? cell.cellId ?? 'unknown'}`,
    start_time: rootStart,
    end_time: nextIso(),
    status: cell.error ? { code: 'ERROR', message: cell.error.slice(0, 200) } : { code: 'OK' },
    attributes: buildAttrs({
      ...service,
      'cell.arm': cell.arm ?? 'real',
      'cell.scenario_id': cell.scenarioId ?? cell.cellId ?? '',
      'cell.rep': cell.rep ?? 0,
      'cell.ended_by': a?.ended_by ?? 'unknown',
      'cell.error': cell.error ?? '',
      'bot.trades_total': trades,
      'bot.strategy_version': sv,
      'bot.self_improve_cycles': cycles,
      'bot.flags': ba?.flags ?? [],
      'tick.side_effects_captured': sideEffectsCaptured,
      'tick.fired': tickFired,
      'tick.decision_count': decisionLines.length,
      'tick.metrics_present': tickFx?.metrics_latest != null,
      'judge.composite': cell.judgeScores?.['user-sim-outcome']?.composite ?? 0,
    }),
  })

  for (const [i, t] of (a?.turns ?? []).entries()) {
    spans.push({
      trace_id: traceId,
      span_id: hexId(`${traceId}:turn:${i}`, 8),
      parent_span_id: rootId,
      name: `turn.${i}`,
      start_time: nextIso(),
      end_time: nextIso(),
      status: { code: 'OK' },
      attributes: buildAttrs({
        ...service,
        'turn.index': i,
        'turn.user_message': t.user_message ?? '',
        'turn.bot_reply_text': t.bot_reply_text ?? '',
      }),
    })
  }

  for (const [i, line] of decisionLines.entries()) {
    spans.push({
      trace_id: traceId,
      span_id: hexId(`${traceId}:decision:${i}`, 8),
      parent_span_id: rootId,
      name: `tick.decision.${i}`,
      start_time: nextIso(),
      end_time: nextIso(),
      status: { code: 'OK' },
      attributes: buildAttrs({ ...service, 'decision.index': i, 'decision.json': line }),
    })
  }

  if (tickFx?.metrics_latest != null) {
    spans.push({
      trace_id: traceId,
      span_id: hexId(`${traceId}:metrics`, 8),
      parent_span_id: rootId,
      name: 'tick.metrics',
      start_time: nextIso(),
      end_time: nextIso(),
      status: { code: 'OK' },
      attributes: buildAttrs({ ...service, 'metrics.latest': tickFx.metrics_latest }),
    })
  }

  for (const [name, src] of Object.entries(tickFx?.strategies ?? {})) {
    spans.push({
      trace_id: traceId,
      span_id: hexId(`${traceId}:strategy:${name}`, 8),
      parent_span_id: rootId,
      name: `strategy.${name}`,
      start_time: nextIso(),
      end_time: nextIso(),
      status: { code: 'OK' },
      attributes: buildAttrs({ ...service, 'strategy.name': name, 'strategy.source': src }),
    })
  }

  return spans
}

function readCells(runDir: string): CachedCell[] {
  const out: CachedCell[] = []
  const multishot = join(runDir, 'multishot')
  if (!existsSync(multishot)) return out
  for (const arm of readdirSync(multishot)) {
    const armDir = join(multishot, arm)
    let cellDirs: string[]
    try {
      cellDirs = readdirSync(armDir)
    } catch {
      continue
    }
    for (const cellDir of cellDirs) {
      const file = join(armDir, cellDir, 'cached-result.json')
      if (!existsSync(file)) continue
      try {
        const cell = JSON.parse(readFileSync(file, 'utf8')) as CachedCell
        if (!cell.arm) cell.arm = arm
        if (!cell.cellId) cell.cellId = cellDir
        out.push(cell)
      } catch {
        // Skip malformed cells — same tolerance the SDK stores apply.
      }
    }
  }
  return out
}

export interface CaptureResult {
  otlpPath: string
  cellCount: number
  realCellCount: number
  spanCount: number
}

/**
 * Read every cell under `runDir/multishot/<arm>/<cell>/cached-result.json`,
 * convert each to a group of OTLP spans (one shared trace per cell), and write
 * the OTLP-JSONL dataset — one span per line — to `runDir/traces.otlp.jsonl`.
 * Returns the path for `OtlpFileTraceStore`.
 */
export function captureRunToOtlp(runDir: string): CaptureResult {
  // Capture ALL arms (real + null/stall baselines). The analyst's question
  // tells it to report the adversarial baseline arms separately — keeping them
  // in the dataset gives the analyst the control contrast.
  const cells = readCells(runDir)
  const lines: string[] = []
  for (const cell of cells) {
    const traceId = hexId(`${cell.arm}:${cell.cellId ?? cell.scenarioId}`, 16)
    for (const span of spansForCell(cell, traceId)) lines.push(JSON.stringify(span))
  }
  const otlpPath = join(runDir, 'traces.otlp.jsonl')
  writeFileSync(otlpPath, lines.join('\n') + (lines.length ? '\n' : ''))
  return {
    otlpPath,
    cellCount: cells.length,
    realCellCount: cells.filter((c) => c.arm === 'real').length,
    spanCount: lines.length,
  }
}
