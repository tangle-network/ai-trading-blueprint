import { useEffect, useState } from 'react'
import { ALL_TRADING_OPERATOR_API_URLS } from '~/lib/operator/meta'

/** Mirrors `BacktestSummary` from the operator's POST /api/create/preview. */
export interface CreatePreviewSummary {
  generated_at: number
  lookback_days: number
  candles_processed: number
  total_trades: number
  profitable_trades: number
  win_rate: number
  total_return_pct: number
  sharpe_ratio: number
  max_drawdown_pct: number
  realized_pnl: string
  tokens_traded: string[]
  harness_version: number
}

export interface CreatePreviewResponse {
  strategy_type: string
  supported: boolean
  summary?: CreatePreviewSummary
  error?: string
  /** Honest framing from the operator; must be rendered with the evidence. */
  note: string
}

/** Preview snapshot persisted into the create draft for the provision confirm. */
export interface CreateStrategyEvidence extends CreatePreviewResponse {
  capturedAt: number
}

export type CreatePreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; response: CreatePreviewResponse }
  | { status: 'unavailable' }

export interface CreatePreviewParams {
  strategyType: string
  lookbackDays?: number
  positionSizePct?: number | null
  maxDrawdownPct?: number | null
}

export const DEFAULT_PREVIEW_LOOKBACK_DAYS = 30

/**
 * Extract the first percentage from a mandate risk/sizing line
 * ("10% max position" → 10). Leverage-style lines ("3x max leverage")
 * carry no percentage and return null so the field is omitted upstream.
 */
export function parseMandatePercent(value: string): number | null {
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseSummary(value: unknown): CreatePreviewSummary | undefined {
  if (!isRecord(value)) return undefined
  const totalTrades = readFiniteNumber(value.total_trades)
  const winRate = readFiniteNumber(value.win_rate)
  const totalReturnPct = readFiniteNumber(value.total_return_pct)
  const maxDrawdownPct = readFiniteNumber(value.max_drawdown_pct)
  if (totalTrades === null || winRate === null || totalReturnPct === null || maxDrawdownPct === null) {
    return undefined
  }
  return {
    generated_at: readFiniteNumber(value.generated_at) ?? 0,
    lookback_days: readFiniteNumber(value.lookback_days) ?? DEFAULT_PREVIEW_LOOKBACK_DAYS,
    candles_processed: readFiniteNumber(value.candles_processed) ?? 0,
    total_trades: totalTrades,
    profitable_trades: readFiniteNumber(value.profitable_trades) ?? 0,
    win_rate: winRate,
    total_return_pct: totalReturnPct,
    sharpe_ratio: readFiniteNumber(value.sharpe_ratio) ?? 0,
    max_drawdown_pct: maxDrawdownPct,
    realized_pnl: typeof value.realized_pnl === 'string' ? value.realized_pnl : '',
    tokens_traded: Array.isArray(value.tokens_traded)
      ? value.tokens_traded.filter((token): token is string => typeof token === 'string')
      : [],
    harness_version: readFiniteNumber(value.harness_version) ?? 0,
  }
}

export function parseCreatePreviewResponse(value: unknown): CreatePreviewResponse | null {
  if (!isRecord(value)) return null
  if (
    typeof value.strategy_type !== 'string' ||
    typeof value.supported !== 'boolean' ||
    typeof value.note !== 'string'
  ) {
    return null
  }
  return {
    strategy_type: value.strategy_type,
    supported: value.supported,
    summary: parseSummary(value.summary),
    error: typeof value.error === 'string' ? value.error : undefined,
    note: value.note,
  }
}

export function toCreateStrategyEvidence(response: CreatePreviewResponse): CreateStrategyEvidence {
  return { ...response, capturedAt: Date.now() }
}

export function readStoredCreateStrategyEvidence(value: unknown): CreateStrategyEvidence | undefined {
  const parsed = parseCreatePreviewResponse(value)
  if (!parsed) return undefined
  const capturedAt = isRecord(value) ? readFiniteNumber(value.capturedAt) ?? 0 : 0
  return { ...parsed, capturedAt }
}

export async function fetchCreatePreview(
  params: CreatePreviewParams,
  signal?: AbortSignal,
  baseUrls: readonly string[] = ALL_TRADING_OPERATOR_API_URLS,
): Promise<CreatePreviewResponse | null> {
  const body = JSON.stringify({
    strategy_type: params.strategyType,
    lookback_days: params.lookbackDays ?? DEFAULT_PREVIEW_LOOKBACK_DAYS,
    ...(params.positionSizePct != null ? { position_size_pct: params.positionSizePct } : {}),
    ...(params.maxDrawdownPct != null ? { max_drawdown_pct: params.maxDrawdownPct } : {}),
  })

  for (const baseUrl of baseUrls) {
    try {
      const res = await fetch(`${baseUrl}/api/create/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal,
      })
      if (!res.ok) continue
      const parsed = parseCreatePreviewResponse(await res.json())
      if (parsed) return parsed
    } catch (err) {
      if (signal?.aborted) throw err
      // Unreachable operator — fall through to the next configured base URL.
    }
  }
  return null
}

const PREVIEW_DEBOUNCE_MS = 400
// Matches the operator's server-side cache TTL; toggling seeds back and
// forth should not refetch evidence the operator would serve from cache.
const PREVIEW_CLIENT_CACHE_TTL_MS = 10 * 60_000
const previewCache = new Map<string, { at: number; response: CreatePreviewResponse }>()

export function clearCreatePreviewCache(): void {
  previewCache.clear()
}

/**
 * Debounced preview fetch keyed on the material mandate parameters
 * (strategy family + parsed sizing/drawdown percents). Keystrokes only
 * trigger a fetch when the inferred parameters actually change.
 */
export function useCreatePreview(params: CreatePreviewParams): CreatePreviewState {
  const { strategyType } = params
  const lookbackDays = params.lookbackDays ?? DEFAULT_PREVIEW_LOOKBACK_DAYS
  const positionSizePct = params.positionSizePct ?? null
  const maxDrawdownPct = params.maxDrawdownPct ?? null
  const hasOperator = ALL_TRADING_OPERATOR_API_URLS.length > 0
  const cacheKey = `${strategyType}:${lookbackDays}:${positionSizePct ?? ''}:${maxDrawdownPct ?? ''}`
  const [state, setState] = useState<CreatePreviewState>({ status: hasOperator ? 'loading' : 'idle' })

  useEffect(() => {
    if (!hasOperator || !strategyType) {
      setState({ status: 'idle' })
      return
    }
    const cached = previewCache.get(cacheKey)
    if (cached && Date.now() - cached.at < PREVIEW_CLIENT_CACHE_TTL_MS) {
      setState({ status: 'ready', response: cached.response })
      return
    }
    setState({ status: 'loading' })
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchCreatePreview(
            { strategyType, lookbackDays, positionSizePct, maxDrawdownPct },
            controller.signal,
          )
          if (controller.signal.aborted) return
          if (response) {
            previewCache.set(cacheKey, { at: Date.now(), response })
            setState({ status: 'ready', response })
          } else {
            setState({ status: 'unavailable' })
          }
        } catch {
          if (!controller.signal.aborted) setState({ status: 'unavailable' })
        }
      })()
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [cacheKey, hasOperator, lookbackDays, maxDrawdownPct, positionSizePct, strategyType])

  return state
}
