import { describe, expect, it } from 'vitest'
import {
  parseCreatePreviewResponse,
  parseMandatePercent,
  readStoredCreateStrategyEvidence,
} from './createPreview'
import {
  CREATE_STRATEGY_DRAFT_STORAGE_KEY,
  safeLoadStoredCreateStrategyDraft,
  saveCreateStrategyDraft,
  type CreateStrategyDraft,
} from './createStrategyDraft'

const SUMMARY = {
  generated_at: 1765500000,
  lookback_days: 30,
  candles_processed: 1440,
  total_trades: 18,
  profitable_trades: 11,
  win_rate: 0.611,
  total_return_pct: 4.2,
  sharpe_ratio: 1.3,
  max_drawdown_pct: 8.2,
  realized_pnl: '412.55',
  tokens_traded: ['ETH', 'BTC'],
  harness_version: 4,
}

describe('parseMandatePercent', () => {
  it('extracts the first percentage from mandate lines', () => {
    expect(parseMandatePercent('10% max position')).toBe(10)
    expect(parseMandatePercent('5% max market exposure')).toBe(5)
    expect(parseMandatePercent('2.5% rebalance loss guard')).toBe(2.5)
  })

  it('returns null for leverage-style lines with no percentage', () => {
    expect(parseMandatePercent('3x max leverage')).toBeNull()
    expect(parseMandatePercent('')).toBeNull()
    expect(parseMandatePercent('0% max drawdown')).toBeNull()
  })
})

describe('parseCreatePreviewResponse', () => {
  it('parses a supported preview with summary', () => {
    const parsed = parseCreatePreviewResponse({
      strategy_type: 'perp',
      supported: true,
      summary: SUMMARY,
      note: 'historical evidence, not a forecast',
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.summary).toMatchObject({ total_trades: 18, max_drawdown_pct: 8.2 })
  })

  it('parses an unsupported family without a summary', () => {
    const parsed = parseCreatePreviewResponse({
      strategy_type: 'prediction',
      supported: false,
      note: 'no public kline source',
    })
    expect(parsed).toEqual({
      strategy_type: 'prediction',
      supported: false,
      summary: undefined,
      error: undefined,
      note: 'no public kline source',
    })
  })

  it('rejects malformed payloads and summaries missing core metrics', () => {
    expect(parseCreatePreviewResponse(null)).toBeNull()
    expect(parseCreatePreviewResponse({ supported: true, note: 'x' })).toBeNull()
    const parsed = parseCreatePreviewResponse({
      strategy_type: 'dex',
      supported: true,
      summary: { total_trades: 'NaN' },
      note: 'x',
    })
    expect(parsed!.summary).toBeUndefined()
  })
})

describe('create draft evidence persistence', () => {
  function baseDraft(): CreateStrategyDraft {
    return {
      name: 'ETH Perp Breakout',
      strategyType: 'perp',
      provisionStrategyType: 'hyperliquid_perp',
      market: 'ETH-PERP',
      venue: 'Hyperliquid',
      sizing: '3x max leverage',
      drawdown: '5% max drawdown',
      mode: 'Paper start',
      prompt: 'Trade ETH perps with strict risk.',
      updatedAt: 0,
    }
  }

  it('round-trips evidence through localStorage', () => {
    saveCreateStrategyDraft({
      ...baseDraft(),
      evidence: {
        strategy_type: 'perp',
        supported: true,
        summary: SUMMARY,
        note: 'historical evidence, not a forecast',
        capturedAt: 1765500001000,
      },
    })

    const loaded = safeLoadStoredCreateStrategyDraft()
    expect(loaded).not.toBeNull()
    expect(loaded!.evidence).toMatchObject({
      strategy_type: 'perp',
      supported: true,
      capturedAt: 1765500001000,
      summary: { total_return_pct: 4.2, win_rate: 0.611 },
    })
  })

  it('stays backward compatible with drafts saved before evidence existed', () => {
    window.localStorage.setItem(
      CREATE_STRATEGY_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...baseDraft(), updatedAt: 123 }),
    )

    const loaded = safeLoadStoredCreateStrategyDraft()
    expect(loaded).not.toBeNull()
    expect(loaded!.evidence).toBeUndefined()
    expect(loaded!.name).toBe('ETH Perp Breakout')
  })

  it('drops malformed stored evidence instead of failing the whole draft', () => {
    window.localStorage.setItem(
      CREATE_STRATEGY_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...baseDraft(), evidence: { bogus: true }, updatedAt: 123 }),
    )

    const loaded = safeLoadStoredCreateStrategyDraft()
    expect(loaded).not.toBeNull()
    expect(loaded!.evidence).toBeUndefined()
  })

  it('readStoredCreateStrategyEvidence defaults capturedAt for legacy payloads', () => {
    const evidence = readStoredCreateStrategyEvidence({
      strategy_type: 'dex',
      supported: true,
      note: 'n',
    })
    expect(evidence).toMatchObject({ strategy_type: 'dex', capturedAt: 0 })
  })
})
