import { formatNumber } from './format';

export type FillCountEvidenceSource =
  | 'trade-store'
  | 'trade-page-total'
  | 'visible-trades'
  | 'metrics'
  | 'roster'
  | 'none';

export interface FillCountEvidence {
  value: number;
  source: FillCountEvidenceSource;
  loaded: number;
  total: number | null;
  isExact: boolean;
  backendSource?: string;
  scope?: string;
  outsidePage?: number | null;
  priced?: number | null;
  unpriced?: number | null;
  valuationCoverage?: number | null;
  latestIndexedAt?: number | null;
  oldestIndexedAt?: number | null;
}

export interface FillCountEvidenceInput {
  backendEvidence?: FillCountEvidence | null;
  tradePageTotal?: number | null;
  visibleTradeCount?: number | null;
  metricTradeCount?: number | null;
  summaryTradeCount?: number | null;
  rosterTradeCount?: number | null;
}

function normalizedCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function resolveFillCountEvidence(input: FillCountEvidenceInput): FillCountEvidence {
  const loaded = normalizedCount(input.visibleTradeCount);
  if (input.backendEvidence && input.backendEvidence.value > 0) {
    const total = Math.max(input.backendEvidence.total ?? 0, input.backendEvidence.value, loaded);
    return {
      ...input.backendEvidence,
      value: total,
      loaded: Math.max(input.backendEvidence.loaded, loaded),
      total,
      isExact: input.backendEvidence.isExact,
    };
  }

  const explicitTotal = normalizedCount(input.tradePageTotal);
  const metricCount = Math.max(
    normalizedCount(input.metricTradeCount),
    normalizedCount(input.summaryTradeCount),
  );
  const rosterCount = normalizedCount(input.rosterTradeCount);

  if (explicitTotal > 0) {
    const total = Math.max(explicitTotal, loaded);
    return {
      value: total,
      source: 'trade-page-total',
      loaded,
      total,
      isExact: true,
    };
  }

  if (loaded > 0) {
    return {
      value: loaded,
      source: 'visible-trades',
      loaded,
      total: null,
      isExact: false,
    };
  }

  const bestStoredCount = Math.max(metricCount, rosterCount);
  if (bestStoredCount > 0) {
    return {
      value: bestStoredCount,
      source: metricCount >= rosterCount ? 'metrics' : 'roster',
      loaded,
      total: null,
      isExact: false,
    };
  }

  return {
    value: 0,
    source: 'none',
    loaded,
    total: null,
    isExact: false,
  };
}

export function fillCountEvidenceSubvalue(evidence: FillCountEvidence): string | null {
  if (evidence.total != null && evidence.loaded > 0 && evidence.loaded < evidence.total) {
    return `${formatNumber(evidence.loaded, { maximumFractionDigits: 0 })} loaded`;
  }
  return null;
}

export function fillCountEvidenceTitle(evidence: FillCountEvidence): string {
  switch (evidence.source) {
    case 'trade-store':
      return 'Exact fill count from the operator trade ledger.';
    case 'trade-page-total':
      return 'Total fills from the trade ledger.';
    case 'visible-trades':
      return 'Visible fills from the latest fetched trade ledger.';
    case 'metrics':
      return 'Fill count from the latest metrics checkpoint.';
    case 'roster':
      return 'Fill count from the agent roster.';
    case 'none':
      return 'No fills reported.';
  }
}
