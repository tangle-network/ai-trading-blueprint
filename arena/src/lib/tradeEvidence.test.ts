import { describe, expect, it } from 'vitest';
import {
  fillCountEvidenceSubvalue,
  resolveFillCountEvidence,
} from './tradeEvidence';

describe('trade evidence', () => {
  it('uses explicit trade-page totals and keeps loaded rows separate', () => {
    const evidence = resolveFillCountEvidence({
      tradePageTotal: 110,
      visibleTradeCount: 6,
      metricTradeCount: 1,
      rosterTradeCount: 1,
    });

    expect(evidence).toEqual({
      value: 110,
      source: 'trade-page-total',
      loaded: 6,
      total: 110,
      isExact: true,
    });
    expect(fillCountEvidenceSubvalue(evidence)).toBe('6 loaded');
  });

  it('does not under-report when visible trades exceed stale roster totals', () => {
    const evidence = resolveFillCountEvidence({
      visibleTradeCount: 12,
      rosterTradeCount: 1,
      metricTradeCount: 1,
    });

    expect(evidence.value).toBe(12);
    expect(evidence.source).toBe('visible-trades');
    expect(fillCountEvidenceSubvalue(evidence)).toBeNull();
  });

  it('prefers backend trade-store evidence over stale metric and roster counts', () => {
    const evidence = resolveFillCountEvidence({
      backendEvidence: {
        value: 49,
        source: 'trade-store',
        loaded: 12,
        total: 49,
        isExact: true,
        backendSource: 'trade_store',
        scope: 'bot',
        priced: 37,
        unpriced: 12,
        valuationCoverage: 37 / 49,
      },
      visibleTradeCount: 12,
      rosterTradeCount: 1,
      metricTradeCount: 1,
    });

    expect(evidence).toMatchObject({
      value: 49,
      source: 'trade-store',
      loaded: 12,
      total: 49,
      isExact: true,
      backendSource: 'trade_store',
      scope: 'bot',
      priced: 37,
      unpriced: 12,
    });
    expect(fillCountEvidenceSubvalue(evidence)).toBe('12 loaded');
  });

  it('raises backend totals to the visible floor when a page races a stale total', () => {
    expect(resolveFillCountEvidence({
      backendEvidence: {
        value: 3,
        source: 'trade-store',
        loaded: 3,
        total: 3,
        isExact: true,
      },
      visibleTradeCount: 4,
    })).toMatchObject({
      value: 4,
      loaded: 4,
      total: 4,
    });
  });

  it('uses the stronger stored count when no trade ledger has loaded', () => {
    expect(resolveFillCountEvidence({
      metricTradeCount: 12,
      rosterTradeCount: 49,
    })).toMatchObject({
      value: 49,
      source: 'roster',
    });

    expect(resolveFillCountEvidence({
      summaryTradeCount: 168,
      rosterTradeCount: 49,
    })).toMatchObject({
      value: 168,
      source: 'metrics',
    });
  });

  it('normalizes invalid counts to an empty evidence state', () => {
    expect(resolveFillCountEvidence({
      tradePageTotal: -1,
      visibleTradeCount: Number.NaN,
      metricTradeCount: 0,
      rosterTradeCount: null,
    })).toEqual({
      value: 0,
      source: 'none',
      loaded: 0,
      total: null,
      isExact: false,
    });
  });
});
