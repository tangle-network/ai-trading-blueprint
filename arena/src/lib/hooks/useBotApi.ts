import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HyperliquidTradeMetadata,
  PredictionTradeMetadata,
  Trade,
  TradeExecutionDetails,
  TradeExecutionStatus,
  TradeSimulation,
  TradeValidation,
  ValidatorResponseDetail,
} from '~/lib/types/trade';
import { protocolToVenue } from '~/lib/types/trade';
import type { Portfolio } from '~/lib/types/portfolio';
import { mapApiPortfolioState, type RawPortfolioState } from '~/lib/portfolio';
import { parseTradeDisplayAmount, resolveAssetDisplay, type TokenMetadata } from '~/lib/tradeTokenMetadata';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { useOperatorDirectory } from '~/lib/operator/discovery';
import { useOperatorAuth } from './useOperatorAuth';
import { operatorJsonWithAuth } from '~/lib/operator/fetch';
import { OperatorRequestError } from '~/lib/operator/errors';
import type { Bot, BotOperatorKind } from '~/lib/types/bot';
import { tokenMetadataFromStrategyConfig } from '~/lib/assetUniverse';
import {
  buildPlatformVolumeSeries,
  buildPlatformVolumeSeriesFromBuckets,
  getPlatformVolumeRangeConfig,
  type PlatformVolumeBucketInput,
  type PlatformVolumeRange,
  type PlatformVolumeSeries,
} from '~/lib/platformVolume';
import {
  isPlatformVolumeCandidate,
  selectLatestTradeFallbackBots,
  shouldFetchOperatorFallback,
} from '~/lib/botVisibility';
import type { FillCountEvidence } from '~/lib/tradeEvidence';

interface ApiTrade {
  id: string;
  bot_id: string;
  timestamp: string;
  action: Trade['action'];
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  target_protocol: string;
  tx_hash?: string;
  block_number?: number;
  gas_used?: string;
  paper_trade: boolean;
  execution_status?: TradeExecutionStatus;
  clob_order_id?: string;
  validation?: {
    approved: boolean;
    aggregate_score: number;
    intent_hash: string;
    responses: Array<{
      validator: string;
      score: number;
      reasoning: string;
      signature: string;
      chain_id?: number;
      verifying_contract?: string;
      validated_at?: string;
    }>;
    simulation?: {
      success: boolean;
      gas_used: number;
      risk_score: number;
      warnings: string[];
      output_amount: string;
    };
  };
  status?: string;
  amount_out?: string;
  entry_price_usd?: string;
  notional_usd?: string;
  requested_price_usd?: string;
  filled_price_usd?: string;
  filled_amount?: string;
  slippage_bps?: string;
  execution_reason?: string;
  prediction_metadata?: {
    condition_id?: string;
    token_id?: string;
    market_question?: string;
    outcome_label?: string;
    outcome_index?: number;
    market_slug?: string;
  };
  hyperliquid_metadata?: {
    asset?: string;
    asset_size?: string;
    order_type?: string;
    reduce_only?: boolean;
  };
  valuation_status?: 'priced' | 'value_only' | 'unpriced';
  decision_source?: string;
  runner_signal?: unknown;
  agent_reasoning?: string;
  harness_version?: number;
  candidate_hash?: string;
  revision_id?: string;
}

type TradeStatusInput = {
  paper_trade: boolean;
  tx_hash?: string;
  target_protocol?: string;
  validation?: {
    approved: boolean;
    simulation?: {
      success: boolean;
    };
  };
};

type TradeAmountOutInput = {
  min_amount_out: string;
  amount_out?: string;
  validation?: {
    simulation?: {
      output_amount: string;
    };
  };
};

interface ApiTradeListResponse {
  trades: ApiTrade[];
  total?: number | string | null;
  total_count?: number | string | null;
  count?: number | string | null;
  limit?: number | string | null;
  offset?: number | string | null;
  evidence?: ApiTradeCountEvidence | null;
}

interface ApiTradeCountEvidence {
  source?: string | null;
  scope?: string | null;
  exact?: boolean | null;
  total_fills?: number | string | null;
  loaded_fills?: number | string | null;
  outside_page_fills?: number | string | null;
  priced_fills?: number | string | null;
  unpriced_fills?: number | string | null;
  valuation_coverage?: number | string | null;
  latest_indexed_at?: string | null;
  oldest_indexed_at?: string | null;
}

interface ApiCandle {
  timestamp: number | string;
  token: string;
  source?: string | null;
  interval?: string | null;
  fetched_at_ms?: number | string | null;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface ApiCandleListResponse {
  candles: ApiCandle[];
  total: number;
  source?: string | null;
  interval?: string | null;
  backfilled?: boolean;
  fetched?: number;
  backfill_error?: string | null;
}

interface ApiChartStudyPoint {
  timestamp_ms: number | string;
  value: number | string;
}

type ApiChartOverlayKind = 'line' | 'level';

interface ApiChartOverlay {
  overlay_id: string;
  kind: ApiChartOverlayKind;
  label: string;
  color?: string | null;
  confidence?: string | null;
  value?: number | string | null;
  points?: ApiChartStudyPoint[];
}

interface ApiChartStudy {
  schema_version: number;
  study_id: string;
  bot_id: string;
  token: string;
  venue?: string | null;
  interval?: string | null;
  title: string;
  summary?: string | null;
  author: string;
  created_at_ms: number | string;
  valid_from_ms?: number | string | null;
  valid_to_ms?: number | string | null;
  run_id?: string | null;
  decision_id?: string | null;
  trace_id?: string | null;
  overlays?: ApiChartOverlay[];
}

interface ApiChartStudyListResponse {
  studies: ApiChartStudy[];
  total: number;
  limit: number;
}

interface ApiPlatformVolumeResponse {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  buckets: Array<{
    timestamp: string;
    bucket_usd: number;
    paper_usd: number;
    live_usd: number;
    priced_trade_count: number;
    total_trade_count: number;
  }>;
  summary: {
    total_usd: number;
    paper_usd: number;
    live_usd: number;
    priced_trade_count: number;
    total_trade_count: number;
  };
}

interface ApiMetricsSnapshot {
  timestamp: string;
  bot_id: string;
  account_value_usd: number;
  unrealized_pnl: number;
  realized_pnl: number;
  high_water_mark: number;
  drawdown_pct: number;
  positions_count: number;
  trade_count: number;
}

interface ApiMetricsHistoryResponse {
  snapshots: ApiMetricsSnapshot[];
}

interface ApiBotMetricsSummary {
  portfolio_value_usd: number;
  total_pnl: number;
  trade_count: number;
}

export type RevisionRunMode =
  | 'live'
  | 'canary'
  | 'paper'
  | 'shadow'
  | 'backtest'
  | 'research';

export interface RevisionArenaEntry {
  revision_id: string;
  display_name: string;
  source: string;
  status: string;
  run_mode: RevisionRunMode;
  can_execute_live: boolean;
  parent_revision_id?: string | null;
  run_id?: string | null;
  created_at?: string | null;
  user_intent: string;
  patch_sha256?: string | null;
  files_changed: string[];
  tests: string[];
  promotion_approved?: boolean | null;
  promotion_blockers: string[];
  rejection?: {
    revision_id?: string;
    reason?: string;
    rejected_at?: string;
  } | null;
  paper_evidence?: {
    trades?: number;
    total_return_pct?: number;
    max_drawdown_pct?: number;
    candidate_hash?: string | null;
    revision_id?: string | null;
  } | null;
}

export interface RevisionModeCapability {
  mode: RevisionRunMode;
  can_touch_funds: boolean;
  description: string;
}

export interface RevisionArena {
  bot_id: string;
  invariant: string;
  active_revision_id: string;
  live_revision_id?: string | null;
  revisions: RevisionArenaEntry[];
  modes: RevisionModeCapability[];
}

export interface ObservatoryUsageSummary {
  event_count: number;
  reporting_status: 'not_applicable' | 'reported' | 'unreported' | string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  providers: string[];
  models: string[];
}

export interface ObservatoryDelegationPressure {
  unique_sessions: number;
  active_sessions: number;
  terminal_sessions: number;
  duplicate_rows_removed: number;
  by_status: Record<string, number>;
  by_source: Record<string, number>;
  usage_reporting_status: string;
  usage_event_count: number;
  total_tokens: number;
  cost_usd: number;
  system?: {
    load_1m?: number;
    cpu_count?: number;
    cpu_pressure?: number;
    memory_free_mb?: number;
    memory_total_mb?: number;
  };
  limits?: {
    max_active_delegations?: number;
    max_cpu_pressure?: number;
    min_free_memory_mb?: number;
  };
  pressure_level: 'low' | 'medium' | 'high' | string;
  allows_new_delegation?: boolean;
  deny_reasons?: string[];
}

export interface ObservatoryWorldSignalDigest {
  digest_id: string;
  bot_id: string;
  created_at: string;
  source_status: string;
  freshness?: string | null;
  confidence: string;
  source_count: number;
  signals: Array<{
    kind: string;
    count?: number;
    summary: string;
  }>;
  unavailable_reason?: string | null;
  evidence_ref?: string | null;
}

export interface ObservatoryFinding {
  code: string;
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  summary: string;
  source?: string;
}

export interface ObservatoryReflectionRun {
  run_id: string;
  bot_id: string;
  bot_name?: string;
  created_at: string;
  trigger: string;
  requested_by?: string | null;
  mode: string;
  world_model_questions: string[];
  evidence: Record<string, unknown>;
  conclusions: string[];
  uncertainties: string[];
  findings: ObservatoryFinding[];
  idea_ids: string[];
  delegated_session_ids: string[];
  delegation_pressure?: ObservatoryDelegationPressure;
  usage_summary: ObservatoryUsageSummary;
}

export interface ObservatoryIdea {
  idea_id: string;
  bot_id: string;
  created_at: string;
  category?: string;
  finding_code?: string;
  finding_severity?: string;
  title: string;
  thesis: string;
  evidence_refs: string[];
  expected_value: string;
  risk: string;
  proposed_action: 'delegate_research' | 'delegate_build' | string;
  status: string;
  source_run_id: string;
}

export interface ObservatoryDelegatedWorkSession {
  session_id: string;
  bot_id: string;
  source: string;
  status: string;
  created_at?: string | null;
  idea_id?: string | null;
  task_id?: string | null;
  summary: string;
  artifact_ref?: string | null;
}

export interface ObservatoryResearchTask {
  task_id: string;
  bot_id: string;
  idea_id?: string | null;
  feedback_id?: string | null;
  owner?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  status: string;
  worker?: string | null;
  worker_launch?: string | null;
  title: string;
  thesis?: string | null;
  evidence_refs?: string[];
  prompt?: string;
  acceptance_criteria?: string[];
  safety_limits?: Record<string, unknown>;
  result_ref?: string | null;
  result_summary?: string | null;
}

export interface ObservatoryOwnerFeedback {
  feedback_id: string;
  bot_id: string;
  idea_id: string;
  action: string;
  note?: string | null;
  owner?: string | null;
  created_at: string;
}

export interface ObservatoryRecords {
  schema_version: number;
  world_signal_digests: ObservatoryWorldSignalDigest[];
  reflection_runs: ObservatoryReflectionRun[];
  ideas: ObservatoryIdea[];
  research_tasks?: ObservatoryResearchTask[];
  delegated_work_sessions: ObservatoryDelegatedWorkSession[];
  owner_feedback: ObservatoryOwnerFeedback[];
  delegation_pressure?: ObservatoryDelegationPressure;
}

export interface BotObservatoryResponse {
  schema_version: number;
  bot_id: string;
  bot_name: string;
  strategy_type: string;
  trading_active: boolean;
  paper_trade: boolean;
  records: ObservatoryRecords;
}

export interface ObservatoryOverviewBot {
  bot_id: string;
  bot_name: string;
  strategy_type: string;
  trading_active: boolean;
  paper_trade: boolean;
  records: ObservatoryRecords;
  error?: string | null;
}

export interface ObservatoryOverviewResponse {
  schema_version: number;
  bot_count: number;
  totals: {
    reflection_runs: number;
    ideas: number;
    delegated_work_sessions: number;
  };
  bots: ObservatoryOverviewBot[];
}

export interface ObservatoryTriggerResponse {
  schema_version: number;
  status: string;
  bot_id: string;
  run_id: string;
  started_at: number;
  completed_at: number;
  workflow_id?: number | null;
  records: {
    schema_version: number;
    bot_id: string;
    created_at: string;
    trigger: string;
    records_written: {
      world_signal_digest_id: string;
      reflection_run_id: string;
      idea_ids: string[];
      delegated_session_ids: string[];
    };
    records: ObservatoryRecords & {
      usage_summary?: ObservatoryUsageSummary;
    };
  };
}

export interface MarketCandle {
  timestamp: number;
  token: string;
  source?: string | null;
  interval?: string | null;
  fetchedAtMs?: number | null;
  backfilled?: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartStudyPoint {
  timestampMs: number;
  value: number;
}

export type ChartOverlayKind = 'line' | 'level';

export interface ChartOverlay {
  id: string;
  kind: ChartOverlayKind;
  label: string;
  color?: string | null;
  confidence?: string | null;
  value?: number | null;
  points: ChartStudyPoint[];
}

export interface ChartStudy {
  id: string;
  schemaVersion: number;
  botId: string;
  token: string;
  venue?: string | null;
  interval?: string | null;
  title: string;
  summary?: string | null;
  author: string;
  createdAtMs: number;
  validFromMs?: number | null;
  validToMs?: number | null;
  runId?: string | null;
  decisionId?: string | null;
  traceId?: string | null;
  overlays: ChartOverlay[];
}

type FetchOperatorBotApiOptions = {
  auth?: boolean;
};

async function fetchOperatorBotApi<T>(
  apiUrl: string,
  auth: Pick<ReturnType<typeof useOperatorAuth>, 'getCachedToken' | 'getToken'>,
  path: string,
  options: FetchOperatorBotApiOptions = {},
): Promise<T> {
  return operatorJsonWithAuth<T>(apiUrl, path, auth, options);
}

const OPERATOR_PUBLIC_FETCH_TIMEOUT_MS = 5_000;

async function fetchOperatorPublicJson<T>(apiUrl: string, path: string): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(OPERATOR_PUBLIC_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Operator request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function fleetReadRequiresAuth(
  deploymentKind: ReturnType<typeof getDeploymentKindForOperatorKind>,
): boolean {
  return deploymentKind !== 'fleet';
}

function mapApiSimulation(trade: ApiTrade): TradeSimulation | undefined {
  const simulation = trade.validation?.simulation;
  if (!simulation) return undefined;

  return {
    success: simulation.success,
    gasUsed: simulation.gas_used,
    riskScore: simulation.risk_score,
    warnings: simulation.warnings,
    outputAmount: simulation.output_amount,
  };
}

function mapApiValidation(trade: ApiTrade): TradeValidation | undefined {
  const validation = trade.validation;
  if (!validation) return undefined;

  return {
    approved: validation.approved,
    aggregateScore: validation.aggregate_score,
    intentHash: validation.intent_hash,
    responses: validation.responses.map((response): ValidatorResponseDetail => ({
      validator: response.validator,
      score: response.score,
      reasoning: response.reasoning,
      signature: response.signature,
      chainId: response.chain_id,
      verifyingContract: response.verifying_contract,
      validatedAt: response.validated_at,
    })),
    simulation: mapApiSimulation(trade),
  };
}

function parseTradeAmount(value: string | undefined): number {
  return Number(value ?? 0);
}

function parseHumanAmount(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getTradeStatus(trade: TradeStatusInput): Trade['status'] {
  if (trade.validation?.approved === false) return 'rejected';
  if (trade.target_protocol === 'hyperliquid' && trade.tx_hash === 'hl:err') return 'rejected';
  if (trade.paper_trade && trade.validation?.simulation?.success === false) return 'failed';
  if (trade.paper_trade) return 'paper';
  if (trade.tx_hash) return 'executed';
  return 'pending';
}

export function deriveTradeAmountOut(trade: TradeAmountOutInput): number {
  return parseTradeAmount(
    trade.amount_out ?? trade.validation?.simulation?.output_amount ?? trade.min_amount_out,
  );
}

function getTradePriceUsd(trade: ApiTrade): number | null {
  if (trade.valuation_status !== 'priced') return null;
  const priceUsd = parseTradeAmount(trade.entry_price_usd);
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

function getTradeNotionalUsd(trade: ApiTrade): number | null {
  const notionalUsd = parseTradeAmount(trade.notional_usd);
  return Number.isFinite(notionalUsd) && notionalUsd > 0 ? notionalUsd : null;
}

function mapExecutionDetails(trade: ApiTrade): TradeExecutionDetails | undefined {
  if (
    !trade.execution_status &&
    !trade.clob_order_id &&
    !trade.requested_price_usd &&
    !trade.filled_price_usd &&
    !trade.filled_amount &&
    !trade.slippage_bps &&
    !trade.execution_reason
  ) {
    return undefined;
  }

  return {
    status: trade.execution_status ?? (trade.paper_trade ? 'paper' : 'confirmed'),
    clobOrderId: trade.clob_order_id,
    requestedPriceUsd: trade.requested_price_usd != null
      ? parseTradeAmount(trade.requested_price_usd)
      : null,
    filledPriceUsd: trade.filled_price_usd != null
      ? parseTradeAmount(trade.filled_price_usd)
      : null,
    filledAmount: trade.filled_amount != null
      ? parseTradeAmount(trade.filled_amount)
      : null,
    slippageBps: trade.slippage_bps != null
      ? parseTradeAmount(trade.slippage_bps)
      : null,
    reason: trade.execution_reason,
  };
}

function mapPredictionMetadata(trade: ApiTrade): PredictionTradeMetadata | undefined {
  const metadata = trade.prediction_metadata;
  if (!metadata) return undefined;

  if (
    !metadata.condition_id &&
    !metadata.token_id &&
    !metadata.market_question &&
    !metadata.outcome_label &&
    metadata.outcome_index == null &&
    !metadata.market_slug
  ) {
    return undefined;
  }

  return {
    conditionId: metadata.condition_id,
    tokenId: metadata.token_id,
    marketQuestion: metadata.market_question,
    outcomeLabel: metadata.outcome_label,
    outcomeIndex: metadata.outcome_index,
    marketSlug: metadata.market_slug,
  };
}

function mapHyperliquidMetadata(trade: ApiTrade): HyperliquidTradeMetadata | undefined {
  const metadata = trade.hyperliquid_metadata;
  if (!metadata) return undefined;

  if (!metadata.asset && !metadata.asset_size && !metadata.order_type && metadata.reduce_only == null) {
    return undefined;
  }

  return {
    asset: metadata.asset,
    assetSize: metadata.asset_size,
    orderType: metadata.order_type,
    reduceOnly: metadata.reduce_only,
  };
}

export function mapApiTrade(
  trade: ApiTrade,
  botName: string,
  fallbackChainId?: number,
  assetMetadata: TokenMetadata[] = [],
): Trade {
  const validation = mapApiValidation(trade);
  const execution = mapExecutionDetails(trade);
  const predictionMetadata = mapPredictionMetadata(trade);
  const hyperliquidMetadata = mapHyperliquidMetadata(trade);
  const isHyperliquid = trade.target_protocol === 'hyperliquid';
  const amountOut = deriveTradeAmountOut(trade);
  const chainId = trade.validation?.responses?.[0]?.chain_id ?? fallbackChainId;
  const assetIn = resolveAssetDisplay(trade.token_in, chainId, assetMetadata);
  const assetOut = resolveAssetDisplay(trade.token_out, chainId, assetMetadata);

  return {
    id: trade.id,
    botId: trade.bot_id,
    botName,
    action: trade.action,
    assetIn,
    assetOut,
    tokenIn: assetIn.symbol,
    tokenOut: assetOut.symbol,
    rawTokenIn: trade.token_in,
    rawTokenOut: trade.token_out,
    amountIn: isHyperliquid
      ? parseHumanAmount(trade.amount_in)
      : parseTradeDisplayAmount(trade.amount_in, trade.token_in, chainId, assetMetadata),
    amountOut,
    priceUsd: getTradePriceUsd(trade),
    notionalUsd: getTradeNotionalUsd(trade),
    timestamp: new Date(trade.timestamp).getTime(),
    status: getTradeStatus(trade),
    txHash: trade.tx_hash,
    paperTrade: trade.paper_trade,
    targetProtocol: trade.target_protocol || undefined,
    venue: protocolToVenue(trade.target_protocol, trade.paper_trade),
    chainId,
    blockNumber: trade.block_number,
    gasUsed: trade.gas_used,
    validatorScore: trade.validation?.aggregate_score,
    validatorReasoning: trade.validation?.responses?.[0]?.reasoning,
    validation,
    execution,
    predictionMetadata,
    hyperliquidMetadata,
    decisionSource: trade.decision_source,
    strategyModuleId: extractStrategyModuleId(trade.runner_signal),
    revisionId: trade.revision_id,
    candidateHash: trade.candidate_hash,
    agentReasoning: trade.agent_reasoning,
    runnerSignal: trade.runner_signal,
    harnessVersion: trade.harness_version,
  };
}

function extractStrategyModuleId(signal: unknown): string | undefined {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return undefined;
  const record = signal as Record<string, unknown>;
  const value = record.strategy_module_id ?? record.strategy_id ?? record.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface TradePage {
  trades: Trade[];
  total: number | null;
  evidence: FillCountEvidence | null;
  loaded: number;
  limit: number;
  offset: number;
  hasTotal: boolean;
  isCapped: boolean;
  legacyArray: boolean;
}

interface NormalizedApiTradePage {
  trades: ApiTrade[];
  total: number | null;
  evidence: ApiTradeCountEvidence | null;
  limit: number;
  offset: number;
  legacyArray: boolean;
}

function toNonNegativeInteger(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function normalizeTradePage(
  data: ApiTrade[] | ApiTradeListResponse,
  requestedLimit: number,
  requestedOffset = 0,
): NormalizedApiTradePage {
  if (Array.isArray(data)) {
    return {
      trades: data,
      total: null,
      evidence: null,
      limit: requestedLimit,
      offset: requestedOffset,
      legacyArray: true,
    };
  }

  const trades = Array.isArray(data.trades) ? data.trades : [];
  const offset = toNonNegativeInteger(data.offset) ?? requestedOffset;
  const limit = toNonNegativeInteger(data.limit) ?? requestedLimit;
  const explicitTotal = toNonNegativeInteger(data.total)
    ?? toNonNegativeInteger(data.total_count)
    ?? toNonNegativeInteger(data.count);
  const visibleFloor = offset + trades.length;

  return {
    trades,
    total: explicitTotal == null ? null : Math.max(explicitTotal, visibleFloor),
    evidence: data.evidence ?? null,
    limit,
    offset,
    legacyArray: false,
  };
}

function unixTimestampMs(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  const abs = Math.abs(parsed);
  if (abs >= 1e17) return parsed / 1_000_000;
  if (abs >= 1e14) return parsed / 1_000;
  if (abs >= 1e11) return parsed;
  return parsed * 1000;
}

function parseOptionalTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function mapApiTradeCountEvidence(
  evidence: ApiTradeCountEvidence | null,
  fallbackTotal: number | null,
  loaded: number,
): FillCountEvidence | null {
  if (!evidence) return null;

  const totalFills = toNonNegativeInteger(evidence.total_fills) ?? fallbackTotal ?? 0;
  const loadedFills = toNonNegativeInteger(evidence.loaded_fills) ?? loaded;
  if (totalFills <= 0 && loadedFills <= 0) return null;

  const total = Math.max(totalFills, loadedFills, loaded);
  const rawValuationCoverage = typeof evidence.valuation_coverage === 'number'
    ? evidence.valuation_coverage
    : evidence.valuation_coverage != null
      ? Number(evidence.valuation_coverage)
      : null;
  return {
    value: total,
    source: 'trade-store',
    loaded: Math.max(loadedFills, loaded),
    total,
    isExact: evidence.exact !== false,
    backendSource: evidence.source ?? undefined,
    scope: evidence.scope ?? undefined,
    outsidePage: toNonNegativeInteger(evidence.outside_page_fills),
    priced: toNonNegativeInteger(evidence.priced_fills),
    unpriced: toNonNegativeInteger(evidence.unpriced_fills),
    valuationCoverage: rawValuationCoverage != null && Number.isFinite(rawValuationCoverage)
      ? rawValuationCoverage
      : null,
    latestIndexedAt: parseOptionalTimestampMs(evidence.latest_indexed_at),
    oldestIndexedAt: parseOptionalTimestampMs(evidence.oldest_indexed_at),
  };
}

export function mapApiTradePage(
  data: ApiTrade[] | ApiTradeListResponse,
  botName: string,
  fallbackChainId: number | undefined,
  assetMetadata: TokenMetadata[],
  requestedLimit: number,
  requestedOffset = 0,
): TradePage {
  const page = normalizeTradePage(data, requestedLimit, requestedOffset);
  const trades = page.trades.map((t) => mapApiTrade(t, botName, fallbackChainId, assetMetadata));
  const loaded = trades.length;
  const hasTotal = page.total != null;
  const evidence = mapApiTradeCountEvidence(page.evidence, page.total, loaded);

  return {
    trades,
    total: page.total,
    evidence,
    loaded,
    limit: page.limit,
    offset: page.offset,
    hasTotal,
    isCapped: hasTotal ? page.offset + loaded < page.total! : page.legacyArray && loaded >= page.limit,
    legacyArray: page.legacyArray,
  };
}

function normalizeTrades(data: ApiTrade[] | ApiTradeListResponse): ApiTrade[] {
  return normalizeTradePage(data, Number.MAX_SAFE_INTEGER).trades;
}

export function normalizeCandles(
  data: ApiCandle[] | ApiCandleListResponse,
  window?: { fromMs?: number; toMs?: number },
): MarketCandle[] {
  const candles = Array.isArray(data) ? data : data.candles;
  const responseSource = Array.isArray(data) ? null : data.source ?? null;
  const responseInterval = Array.isArray(data) ? null : data.interval ?? null;
  const responseBackfilled = Array.isArray(data) ? false : Boolean(data.backfilled);
  return candles
    .map((candle) => ({
      timestamp: unixTimestampMs(candle.timestamp),
      token: candle.token,
      source: candle.source ?? responseSource,
      interval: candle.interval ?? responseInterval,
      fetchedAtMs: candle.fetched_at_ms == null ? null : unixTimestampMs(candle.fetched_at_ms),
      backfilled: responseBackfilled,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
    }))
    .filter((candle) =>
      Number.isFinite(candle.timestamp)
      && Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
      && candle.open > 0
      && candle.high > 0
      && candle.low > 0
      && candle.close > 0,
    )
    .filter((candle) =>
      (window?.fromMs == null || candle.timestamp >= window.fromMs)
      && (window?.toMs == null || candle.timestamp <= window.toMs),
    )
    .sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeChartStudies(
  data: ApiChartStudy[] | ApiChartStudyListResponse,
  token?: string | null,
  window?: { fromMs?: number; toMs?: number },
): ChartStudy[] {
  const studies = Array.isArray(data) ? data : data.studies;
  const normalizedToken = token?.trim();

  return studies
    .map((study) => {
      const createdAtMs = Number(study.created_at_ms);
      const validFromMs = study.valid_from_ms == null ? null : Number(study.valid_from_ms);
      const validToMs = study.valid_to_ms == null ? null : Number(study.valid_to_ms);
      const overlays = (study.overlays ?? [])
        .map((overlay): ChartOverlay => {
          const value = overlay.value == null ? null : Number(overlay.value);
          const points = (overlay.points ?? [])
            .map((point) => ({
              timestampMs: Number(point.timestamp_ms),
              value: Number(point.value),
            }))
            .filter((point) =>
              Number.isFinite(point.timestampMs)
              && point.timestampMs > 0
              && Number.isFinite(point.value),
            )
            .sort((left, right) => left.timestampMs - right.timestampMs);

          return {
            id: overlay.overlay_id,
            kind: overlay.kind,
            label: overlay.label,
            color: overlay.color ?? null,
            confidence: overlay.confidence ?? null,
            value: value != null && Number.isFinite(value) ? value : null,
            points,
          };
        })
        .filter((overlay) =>
          Boolean(overlay.id)
          && Boolean(overlay.label)
          && (overlay.kind === 'line' || overlay.kind === 'level')
          && (
            (overlay.kind === 'line' && overlay.points.length >= 2)
            || (overlay.kind === 'level' && overlay.value != null)
          ),
        );

      return {
        id: study.study_id,
        schemaVersion: Number(study.schema_version) || 1,
        botId: study.bot_id,
        token: study.token,
        venue: study.venue ?? null,
        interval: study.interval ?? null,
        title: study.title,
        summary: study.summary ?? null,
        author: study.author,
        createdAtMs,
        validFromMs: validFromMs != null && Number.isFinite(validFromMs) ? validFromMs : null,
        validToMs: validToMs != null && Number.isFinite(validToMs) ? validToMs : null,
        runId: study.run_id ?? null,
        decisionId: study.decision_id ?? null,
        traceId: study.trace_id ?? null,
        overlays,
      };
    })
    .filter((study) =>
      Boolean(study.id)
      && Boolean(study.botId)
      && Boolean(study.token)
      && Boolean(study.title)
      && Number.isFinite(study.createdAtMs)
      && study.overlays.length > 0
      && (normalizedToken == null || study.token.toLowerCase() === normalizedToken.toLowerCase())
      && (window?.fromMs == null || (study.validToMs ?? study.createdAtMs) >= window.fromMs)
      && (window?.toMs == null || (study.validFromMs ?? study.createdAtMs) <= window.toMs),
    );
}

function normalizePlatformVolumeBuckets(data: ApiPlatformVolumeResponse): PlatformVolumeBucketInput[] {
  return data.buckets.map((bucket) => ({
    timestamp: new Date(bucket.timestamp).getTime(),
    bucketUsd: Number(bucket.bucket_usd) || 0,
    paperUsd: Number(bucket.paper_usd) || 0,
    liveUsd: Number(bucket.live_usd) || 0,
    pricedTradeCount: Number(bucket.priced_trade_count) || 0,
    totalTradeCount: Number(bucket.total_trade_count) || 0,
  }));
}

export function normalizeMetrics(data: ApiMetricsSnapshot[] | ApiMetricsHistoryResponse): ApiMetricsSnapshot[] {
  const snapshots = Array.isArray(data) ? data : data.snapshots;
  return snapshots
    .map((snapshot) => ({
      ...snapshot,
      account_value_usd: Number(snapshot.account_value_usd),
      unrealized_pnl: Number(snapshot.unrealized_pnl),
      realized_pnl: Number(snapshot.realized_pnl),
      high_water_mark: Number(snapshot.high_water_mark),
      drawdown_pct: Number(snapshot.drawdown_pct),
      positions_count: Number(snapshot.positions_count),
      trade_count: Number(snapshot.trade_count),
    }))
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

export function metricHistoryLimitForDays(days: number): number {
  if (days <= 1) return 500;
  if (days <= 7) return 2_500;
  return 10_000;
}

interface BotApiQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  chainId?: number;
  assetMetadata?: TokenMetadata[];
  offset?: number;
  pages?: number;
  stopAtTimestampMs?: number;
}

/**
 * keepPreviousData scoped to the same bot on the same operator. Range/window
 * segments of the query key (days, limit, page count, …) change when the user
 * flips a chart range; keeping the previous series visible while the new
 * window loads prevents the loaded chart from collapsing back to a skeleton.
 * Switching bots still starts clean — another bot's series is worse than a
 * skeleton. Relies on the `[name, apiUrl, botId, …]` key convention shared by
 * every bot-scoped query in this module.
 */
function keepPreviousDataForSameBot<T>(apiUrl: string, botId: string) {
  return (
    previousData: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined => {
    const key = previousQuery?.queryKey;
    if (!key || key[1] !== apiUrl || key[2] !== botId) return undefined;
    return previousData;
  };
}

export function useBotTradePage(
  botId: string,
  botName: string = '',
  limit = 50,
  options: BotApiQueryOptions = {},
) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const pageSize = Math.min(Math.max(1, Math.floor(limit)), 200);
  const pages = Math.max(1, Math.floor(options.pages ?? 1));
  const stopAtTimestampMs = options.stopAtTimestampMs;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';

  return useQuery<TradePage>({
    queryKey: ['bot-trade-page', apiUrl, botId, pageSize, offset, pages, stopAtTimestampMs, deploymentKind, options.chainId, options.assetMetadata, authKey],
    queryFn: async () => {
      const trades: ApiTrade[] = [];
      let total: number | null = null;
      let evidence: ApiTradeCountEvidence | null = null;

      for (let page = 0; page < pages; page += 1) {
        const pageOffset = offset + page * pageSize;
        const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/trades')}?limit=${pageSize}&offset=${pageOffset}`;
        const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(
          apiUrl,
          auth,
          path,
          { auth: needsAuth },
        );
        const normalized = normalizeTradePage(data, pageSize, pageOffset);
        trades.push(...normalized.trades);
        total = total == null
          ? normalized.total
          : normalized.total == null
            ? total
            : Math.max(total, normalized.total);
        evidence = evidence ?? normalized.evidence;

        const effectiveLimit = Math.max(1, normalized.limit || pageSize);
        if (normalized.trades.length < effectiveLimit) break;
        if (total != null && pageOffset + normalized.trades.length >= total) break;

        if (stopAtTimestampMs != null) {
          const oldestTimestamp = normalized.trades.reduce((oldest, trade) => {
            const timestamp = new Date(trade.timestamp).getTime();
            return Number.isFinite(timestamp) ? Math.min(oldest, timestamp) : oldest;
          }, Number.POSITIVE_INFINITY);
          if (oldestTimestamp <= stopAtTimestampMs) break;
        }
      }

      return mapApiTradePage({
        trades,
        total,
        limit: pageSize * pages,
        offset,
        evidence: evidence
          ? {
              ...evidence,
              loaded_fills: trades.length,
              outside_page_fills: total == null ? evidence.outside_page_fills : Math.max(0, total - trades.length),
            }
          : null,
      }, botName, options.chainId, options.assetMetadata ?? [], pageSize * pages, offset);
    },
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchInterval: options.refetchInterval,
    placeholderData: keepPreviousDataForSameBot<TradePage>(apiUrl, botId),
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useBotTrades(
  botId: string,
  botName: string = '',
  limit = 50,
  options: BotApiQueryOptions = {},
) {
  const query = useBotTradePage(botId, botName, limit, options);
  return {
    ...query,
    data: query.data?.trades,
  };
}

export interface LatestAgentTrade {
  trade: Trade;
  bot?: Bot;
  botId: string;
  botName: string;
  operatorApiUrl?: string | null;
}

export function shouldFallbackLatestTradesToBotLedgers({
  operatorCount,
  aggregateReturnedNoTrades,
  aggregateAllErrored,
}: {
  operatorCount: number;
  aggregateReturnedNoTrades: boolean;
  aggregateAllErrored: boolean;
}): boolean {
  return operatorCount === 0 || aggregateReturnedNoTrades || (operatorCount > 0 && aggregateAllErrored);
}

function fallbackBotName(botId: string): string {
  if (!botId) return 'Unknown Agent';
  return `Agent ${botId.slice(0, 8)}`;
}

export function useLatestAgentTrades(
  bots: Bot[],
  {
    enabled = true,
    limit = 10,
    perBotLimit = 4,
    maxBots = 32,
  }: {
    enabled?: boolean;
    limit?: number;
    perBotLimit?: number;
    maxBots?: number;
  } = {},
) {
  const botFingerprint = bots.map((bot) => [
    bot.id,
    bot.name,
    bot.status,
    bot.totalTrades,
    bot.operatorKind ?? 'none',
    bot.operatorApiUrl ?? 'none',
    bot.chainId ?? 'none',
  ].join(':')).join('|');

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [botFingerprint, bots]); // eslint-disable-line react-hooks/exhaustive-deps

  const { apiUrls: directoryApiUrls } = useOperatorDirectory();
  const operatorUrls = useMemo(() => {
    const urls = new Set<string>();
    directoryApiUrls.forEach((url) => {
      if (url) urls.add(url);
    });
    bots.forEach((bot) => {
      if (bot.operatorApiUrl) urls.add(bot.operatorApiUrl);
    });
    return Array.from(urls);
  }, [botFingerprint, bots, directoryApiUrls]); // eslint-disable-line react-hooks/exhaustive-deps

  const operatorResults = useQueries({
    queries: operatorUrls.map((apiUrl) => ({
      queryKey: ['latest-platform-trades', apiUrl, limit] as const,
      queryFn: async (): Promise<ApiTrade[]> => {
        const data = await fetchOperatorPublicJson<ApiTrade[] | ApiTradeListResponse>(
          apiUrl,
          `/api/platform/trades?limit=${Math.min(Math.max(limit * 2, 10), 200)}`,
        );
        return normalizeTrades(data);
      },
      staleTime: 10_000,
      refetchOnMount: 'always' as const,
      refetchInterval: 15_000,
      retry: 1,
      enabled: enabled && !!apiUrl,
    })),
  });

  const aggregateStateFingerprint = operatorResults.map((result, index) => {
    const apiUrl = operatorUrls[index] ?? '';
    if (result.isError) return `${apiUrl}:error`;
    if (result.isSuccess) return `${apiUrl}:success:${result.data?.length ?? 0}`;
    return `${apiUrl}:pending`;
  }).join('|');
  const aggregateReturnedNoTrades = operatorResults.length > 0
    && operatorResults.every((result) => result.isSuccess && (result.data?.length ?? 0) === 0);
  const fallbackAllOperators = shouldFallbackLatestTradesToBotLedgers({
    operatorCount: operatorUrls.length,
    aggregateReturnedNoTrades,
    aggregateAllErrored: operatorResults.length > 0 && operatorResults.every((result) => result.isError),
  });
  const failedAggregateFingerprint = operatorResults.map((result, index) =>
    result.isError ? operatorUrls[index] : '',
  ).join('|');
  const failedAggregateUrls = new Set(
    operatorResults.flatMap((result, index) =>
      result.isError && operatorUrls[index] ? [operatorUrls[index]] : [],
    ),
  );

  const candidates = useMemo(() => {
    return selectLatestTradeFallbackBots(
      bots,
      failedAggregateUrls,
      fallbackAllOperators,
      maxBots,
    )
      .map((bot) => ({
        bot,
        deploymentKind: getDeploymentKindForOperatorKind(bot.operatorKind),
        assetMetadata: tokenMetadataFromStrategyConfig(bot.strategyConfig),
      }));
  }, [
    botFingerprint,
    bots,
    aggregateStateFingerprint,
    failedAggregateFingerprint,
    fallbackAllOperators,
    maxBots,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const authByUrl = {
    cloud: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'cloud')?.operatorApiUrl ?? ''),
    instance: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'instance')?.operatorApiUrl ?? ''),
    tee: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'tee')?.operatorApiUrl ?? ''),
  } as const;

  const results = useQueries({
    queries: candidates.map(({ bot, deploymentKind, assetMetadata }) => {
      const auth = authByUrl[bot.operatorKind ?? 'cloud'];
      const needsAuth = fleetReadRequiresAuth(deploymentKind);
      const authKey = needsAuth ? auth.authCacheKey : 'public';

      return {
        queryKey: [
          'latest-agent-trades',
          bot.operatorApiUrl,
          bot.id,
          perBotLimit,
          deploymentKind,
          bot.chainId,
          authKey,
        ] as const,
        queryFn: async (): Promise<LatestAgentTrade[]> => {
          const path = `${buildBotScopedPathForDeploymentKind(
            deploymentKind,
            bot.id,
            '/trades',
          )}?limit=${perBotLimit}`;
          const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(
            bot.operatorApiUrl ?? '',
            auth,
            path,
            { auth: needsAuth },
          );
          return normalizeTrades(data).map((trade) => ({
            trade: mapApiTrade(trade, bot.name, bot.chainId, assetMetadata),
            bot,
            botId: bot.id,
            botName: bot.name,
            operatorApiUrl: bot.operatorApiUrl,
          }));
        },
        staleTime: 10_000,
        refetchOnMount: 'always' as const,
        refetchInterval: 15_000,
        retry: 1,
        enabled: enabled && !!bot.operatorApiUrl && (!needsAuth || !!auth.getCachedToken()),
      };
    }),
  });

  const aggregateFingerprint = operatorResults.map((result) =>
    result.data ? result.data.map((trade) => `${trade.bot_id}:${trade.id}:${trade.timestamp}`).join(',') : 'x',
  ).join('|');
  const dataFingerprint = results.map((result) =>
    result.data ? result.data.map((item) => `${item.trade.id}:${item.trade.timestamp}`).join(',') : 'x',
  ).join('|');

  const aggregateTrades = useMemo<LatestAgentTrade[]>(() => {
    const seen = new Set<string>();
    return operatorResults
      .flatMap((result, index) => {
        const apiUrl = operatorUrls[index];
        return (result.data ?? []).flatMap((apiTrade) => {
          const key = `${apiTrade.bot_id}:${apiTrade.id}`;
          if (seen.has(key)) return [];
          seen.add(key);

          const bot = botById.get(apiTrade.bot_id);
          const botName = bot?.name ?? fallbackBotName(apiTrade.bot_id);
          return [{
            trade: mapApiTrade(
              apiTrade,
              botName,
              bot?.chainId,
              tokenMetadataFromStrategyConfig(bot?.strategyConfig),
            ),
            bot,
            botId: apiTrade.bot_id,
            botName,
            operatorApiUrl: apiUrl,
          }];
        });
      })
      .sort((a, b) => b.trade.timestamp - a.trade.timestamp)
      .slice(0, limit);
  }, [aggregateFingerprint, botById, limit, operatorResults, operatorUrls]); // eslint-disable-line react-hooks/exhaustive-deps

  const trades = useMemo(() => {
    const fallbackTrades = results
      .flatMap((result) => result.data ?? [])
      .sort((a, b) => b.trade.timestamp - a.trade.timestamp)
      .slice(0, limit);
    return aggregateTrades.length > 0 ? aggregateTrades : fallbackTrades;
  }, [aggregateTrades, dataFingerprint, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    trades,
    isLoading: (
      operatorResults.some((result) => result.isLoading)
      || results.some((result) => result.isLoading)
    ) && trades.length === 0,
    isFetching: operatorResults.some((result) => result.isFetching)
      || results.some((result) => result.isFetching),
    isError: operatorResults.length > 0
      && operatorResults.every((result) => result.isError)
      && (results.length === 0 || results.every((result) => result.isError)),
    candidateCount: operatorUrls.length > 0 ? operatorUrls.length : candidates.length,
  };
}

export interface PlatformVolumeCoverage {
  candidateBots: number;
  fetchedBots: number;
  candidateOperators: number;
  fetchedOperators: number;
  maxBots: number;
}

export function usePlatformVolumeSeries(
  bots: Bot[],
  range: PlatformVolumeRange,
  {
    maxBots = 48,
    refetchInterval = 30_000,
  }: {
    maxBots?: number;
    refetchInterval?: number | false;
  } = {},
) {
  const config = getPlatformVolumeRangeConfig(range);
  const rangeStartMs = Date.now() - config.days * 24 * 60 * 60 * 1000;
  const botFingerprint = bots.map((bot) => [
    bot.id,
    bot.name,
    bot.status,
    bot.totalTrades,
    bot.operatorKind ?? 'none',
    bot.operatorApiUrl ?? 'none',
    bot.chainId ?? 'none',
  ].join(':')).join('|');

  const { apiUrls: directoryApiUrls } = useOperatorDirectory();
  const operatorUrls = useMemo(() => {
    const urls = new Set<string>();
    directoryApiUrls.forEach((url) => {
      if (url) urls.add(url);
    });
    bots.forEach((bot) => {
      if (bot.operatorApiUrl) urls.add(bot.operatorApiUrl);
    });
    return Array.from(urls);
  }, [botFingerprint, bots, directoryApiUrls]); // eslint-disable-line react-hooks/exhaustive-deps

  const operatorResults = useQueries({
    queries: operatorUrls.map((apiUrl) => ({
      queryKey: ['platform-volume-aggregate', apiUrl, range] as const,
      queryFn: async (): Promise<PlatformVolumeBucketInput[]> => {
        const toMs = Date.now();
        const fromMs = toMs - config.days * 24 * 60 * 60 * 1000;
        const params = new URLSearchParams({
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          bucket: config.bucketMs <= 60 * 60 * 1000 ? 'hour' : 'day',
        });
        const data = await fetchOperatorPublicJson<ApiPlatformVolumeResponse>(
          apiUrl,
          `/api/platform/volume?${params}`,
        );
        return normalizePlatformVolumeBuckets(data);
      },
      staleTime: 15_000,
      refetchOnMount: 'always' as const,
      refetchInterval,
      retry: 1,
      enabled: !!apiUrl,
    })),
  });

  const operatorFingerprint = operatorUrls.join('|');
  const failedAggregateFingerprint = operatorResults.map((result, index) =>
    result.isError ? operatorUrls[index] : '',
  ).join('|');
  const failedAggregateUrls = new Set(
    operatorResults.flatMap((result, index) =>
      result.isError && operatorUrls[index] ? [operatorUrls[index]] : [],
    ),
  );
  const fallbackAllOperators = operatorUrls.length === 0
    || (operatorResults.length > 0 && operatorResults.every((result) => result.isError));

  const candidates = useMemo(() => {
    return bots
      .filter(isPlatformVolumeCandidate)
      .filter((bot) => shouldFetchOperatorFallback(bot, failedAggregateUrls, fallbackAllOperators))
      .sort((left, right) => {
        if (right.totalTrades !== left.totalTrades) return right.totalTrades - left.totalTrades;
        if (left.status === 'active' && right.status !== 'active') return -1;
        if (right.status === 'active' && left.status !== 'active') return 1;
        return right.createdAt - left.createdAt;
      })
      .slice(0, maxBots)
      .map((bot) => ({
        bot,
        deploymentKind: getDeploymentKindForOperatorKind(bot.operatorKind),
        assetMetadata: tokenMetadataFromStrategyConfig(bot.strategyConfig),
      }));
  }, [
    botFingerprint,
    bots,
    failedAggregateFingerprint,
    fallbackAllOperators,
    maxBots,
    operatorFingerprint,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const authByUrl = {
    cloud: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'cloud')?.operatorApiUrl ?? ''),
    instance: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'instance')?.operatorApiUrl ?? ''),
    tee: useOperatorAuth(bots.find((bot) => bot.operatorKind === 'tee')?.operatorApiUrl ?? ''),
  } as const;

  const results = useQueries({
    queries: candidates.map(({ bot, deploymentKind, assetMetadata }) => {
      const auth = authByUrl[bot.operatorKind ?? 'cloud'];
      const needsAuth = fleetReadRequiresAuth(deploymentKind);
      const authKey = needsAuth ? auth.authCacheKey : 'public';

      return {
        queryKey: [
          'platform-volume-trades',
          bot.operatorApiUrl,
          bot.id,
          range,
          config.fetchPages,
          deploymentKind,
          bot.chainId,
          authKey,
        ] as const,
        queryFn: async (): Promise<Trade[]> => {
          const pageSize = 200;
          const trades: ApiTrade[] = [];

          for (let page = 0; page < config.fetchPages; page += 1) {
            const offset = page * pageSize;
            const path = `${buildBotScopedPathForDeploymentKind(
              deploymentKind,
              bot.id,
              '/trades',
            )}?limit=${pageSize}&offset=${offset}`;
            const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(
              bot.operatorApiUrl ?? '',
              auth,
              path,
              { auth: needsAuth },
            );
            const pageTrades = normalizeTrades(data);
            trades.push(...pageTrades);

            if (pageTrades.length < pageSize) break;

            const oldestTimestamp = pageTrades.reduce((oldest, trade) => {
              const timestamp = new Date(trade.timestamp).getTime();
              return Number.isFinite(timestamp) ? Math.min(oldest, timestamp) : oldest;
            }, Number.POSITIVE_INFINITY);
            if (oldestTimestamp <= rangeStartMs) break;
          }

          return trades.map((trade) => mapApiTrade(trade, bot.name, bot.chainId, assetMetadata));
        },
        staleTime: 15_000,
        refetchOnMount: 'always' as const,
        refetchInterval,
        retry: 1,
        enabled: !!bot.operatorApiUrl && (!needsAuth || !!auth.getCachedToken()),
      };
    }),
  });

  const dataFingerprint = results.map((result) =>
    result.data ? result.data.map((trade) => `${trade.id}:${trade.timestamp}:${trade.notionalUsd ?? 'x'}`).join(',') : 'x',
  ).join('|');
  const aggregateDataFingerprint = operatorResults.map((result) =>
    result.data ? result.data.map((bucket) =>
      `${bucket.timestamp}:${bucket.bucketUsd}:${bucket.totalTradeCount}`,
    ).join(',') : 'x',
  ).join('|');

  const fetchedTrades = useMemo(() => results.flatMap((result) => result.data ?? []), [dataFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = useMemo<PlatformVolumeSeries>(() => {
    const aggregateBuckets = operatorResults.flatMap((result) => result.data ?? []);
    const fallbackSeries = buildPlatformVolumeSeries(
      fetchedTrades.map((trade) => ({
        timestamp: trade.timestamp,
        notionalUsd: trade.notionalUsd,
        paperTrade: trade.paperTrade,
      })),
      range,
    );
    const fallbackBuckets: PlatformVolumeBucketInput[] = fallbackSeries.buckets
      .filter((bucket) => bucket.bucketUsd > 0 || bucket.totalTradeCount > 0)
      .map((bucket) => ({
        timestamp: bucket.timestamp,
        bucketUsd: bucket.bucketUsd,
        paperUsd: bucket.paperUsd,
        liveUsd: bucket.liveUsd,
        pricedTradeCount: bucket.tradeCount,
        totalTradeCount: bucket.totalTradeCount,
      }));
    return buildPlatformVolumeSeriesFromBuckets(
      [...aggregateBuckets, ...fallbackBuckets],
      range,
    );
  }, [aggregateDataFingerprint, dataFingerprint, fetchedTrades, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidateOperators = new Set(operatorUrls);
  const aggregateFetchedOperatorUrls = operatorResults.flatMap((result, index) => {
    if (!result.data) return [];
    return operatorUrls[index] ? [operatorUrls[index]] : [];
  });
  const fetchedOperatorUrls = results.flatMap((result, index) => {
    if (!result.data) return [];
    return candidates[index]?.bot.operatorApiUrl ? [candidates[index].bot.operatorApiUrl] : [];
  });
  const fetchedOperators = new Set([...aggregateFetchedOperatorUrls, ...fetchedOperatorUrls]);
  const fetchedBotCount = results.filter((result) => result.data).length;
  const coverage: PlatformVolumeCoverage = {
    candidateBots: bots.filter(isPlatformVolumeCandidate).length,
    fetchedBots: fetchedBotCount,
    candidateOperators: candidateOperators.size,
    fetchedOperators: fetchedOperators.size,
    maxBots,
  };

  return {
    series,
    coverage,
    isLoading: (
      operatorResults.some((result) => result.isLoading)
      || results.some((result) => result.isLoading)
    ) && series.summary.totalTradeCount === 0,
    isFetching: operatorResults.some((result) => result.isFetching)
      || results.some((result) => result.isFetching),
    isError: operatorResults.length > 0
      && operatorResults.every((result) => result.isError)
      && (results.length === 0 || results.every((result) => result.isError)),
  };
}

export function useBotRecentValidations(
  botId: string,
  botName: string = '',
  options: BotApiQueryOptions = {},
) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';

  return useQuery<Trade[]>({
    queryKey: ['bot-recent-validations', apiUrl, botId, deploymentKind, options.chainId, options.assetMetadata, authKey],
    queryFn: async () => {
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/trades')}?limit=5`;
      const data = await fetchOperatorBotApi<ApiTrade[] | ApiTradeListResponse>(
        apiUrl,
        auth,
        path,
        { auth: needsAuth },
      );
      return normalizeTrades(data).map((t) => mapApiTrade(t, botName, options.chainId, options.assetMetadata));
    },
    refetchInterval: options.refetchInterval ?? 5_000,
    staleTime: 3_000,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 3_000,
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useBotPortfolio(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';

  return useQuery<Portfolio | null>({
    queryKey: ['bot-portfolio', apiUrl, botId, deploymentKind, options.chainId, options.assetMetadata, authKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/portfolio/state');
      const data = await fetchOperatorBotApi<RawPortfolioState>(
        apiUrl,
        auth,
        path,
        { auth: needsAuth },
      );
      return mapApiPortfolioState(data, botId, options.chainId, options.assetMetadata);
    },
    staleTime: 10_000,
    gcTime: 60_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useBotMetrics(botId: string, days = 30, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';
  const limit = metricHistoryLimitForDays(days);

  return useQuery<ApiMetricsSnapshot[]>({
    queryKey: ['bot-metrics', apiUrl, botId, days, limit, deploymentKind, authKey],
    queryFn: async () => {
      const from = new Date(Date.now() - days * 86400000).toISOString();
      const to = new Date().toISOString();
      const path = `${buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/metrics/history')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`;
      const data = await fetchOperatorBotApi<ApiMetricsSnapshot[] | ApiMetricsHistoryResponse>(
        apiUrl,
        auth,
        path,
        { auth: needsAuth },
      );
      return normalizeMetrics(data);
    },
    staleTime: 15_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    placeholderData: keepPreviousDataForSameBot<ApiMetricsSnapshot[]>(apiUrl, botId),
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useBotMarketCandles(
  botId: string,
  token: string | null | undefined,
  days = 30,
  options: BotApiQueryOptions & {
    backfill?: boolean;
    interval?: string;
    limit?: number;
    source?: string | null;
  } = {},
) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';
  const normalizedToken = token?.trim();
  const source = options.source?.trim() || undefined;
  const interval = options.interval?.trim() || undefined;
  const backfill = options.backfill ?? false;

  return useQuery<MarketCandle[]>({
    queryKey: [
      'bot-market-candles',
      apiUrl,
      botId,
      normalizedToken,
      days,
      options.limit ?? 500,
      source ?? null,
      interval ?? null,
      backfill,
      deploymentKind,
      authKey,
    ],
    queryFn: async () => {
      if (!normalizedToken) return [];
      const to = Math.floor(Date.now() / 1000);
      const from = to - days * 24 * 60 * 60;
      const params = new URLSearchParams({
        token: normalizedToken,
        from: String(from),
        to: String(to),
        limit: String(options.limit ?? 500),
      });
      if (source) params.set('source', source);
      if (interval) params.set('interval', interval);
      if (backfill) params.set('backfill', 'true');
      const path = `${buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/market-data/candles',
      )}?${params}`;
      const data = await fetchOperatorBotApi<ApiCandle[] | ApiCandleListResponse>(
        apiUrl,
        auth,
        path,
        { auth: needsAuth },
      );
      return normalizeCandles(data, { fromMs: from * 1000, toMs: to * 1000 });
    },
    staleTime: 30_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    placeholderData: keepPreviousDataForSameBot<MarketCandle[]>(apiUrl, botId),
    enabled: enabled && !!apiUrl && !!normalizedToken && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useBotChartStudies(
  botId: string,
  token: string | null | undefined,
  window: { fromMs: number; toMs: number },
  options: BotApiQueryOptions & { limit?: number } = {},
) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';
  const normalizedToken = token?.trim();
  const limit = options.limit ?? 12;

  return useQuery<ChartStudy[]>({
    queryKey: [
      'bot-chart-studies',
      apiUrl,
      botId,
      normalizedToken,
      window.fromMs,
      window.toMs,
      limit,
      deploymentKind,
      authKey,
    ],
    queryFn: async () => {
      if (!normalizedToken) return [];
      const params = new URLSearchParams({
        token: normalizedToken,
        from: String(Math.floor(window.fromMs)),
        to: String(Math.floor(window.toMs)),
        limit: String(limit),
      });
      const path = `${buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/chart/studies',
      )}?${params}`;
      const data = await fetchOperatorBotApi<ApiChartStudy[] | ApiChartStudyListResponse>(
        apiUrl,
        auth,
        path,
        { auth: needsAuth },
      );
      return normalizeChartStudies(data, normalizedToken, window);
    },
    staleTime: 30_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    placeholderData: keepPreviousDataForSameBot<ChartStudy[]>(apiUrl, botId),
    enabled: enabled && !!apiUrl && !!normalizedToken && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useBotMetricsSummary(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';

  return useQuery<ApiBotMetricsSummary>({
    queryKey: ['bot-metrics-summary', apiUrl, botId, deploymentKind, authKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/metrics');
      return fetchOperatorBotApi<ApiBotMetricsSummary>(
        apiUrl,
        auth,
        path,
        { auth: needsAuth },
      );
    },
    staleTime: 15_000,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

interface ApiBotPerformanceSummary {
  bot_id?: string;
  return_pct?: number | null;
  benchmark_buy_hold_return_pct?: number | null;
  alpha_pct?: number | null;
  max_drawdown_pct?: number | null;
  nav_latest_usd?: number | null;
  initial_capital_usd?: number | null;
  window?: { from?: string | number | null; to?: string | number | null } | null;
}

export interface BotPerformanceSummary {
  returnPct: number | null;
  benchmarkBuyHoldReturnPct: number | null;
  alphaPct: number | null;
  maxDrawdownPct: number | null;
  navLatestUsd: number | null;
  initialCapitalUsd: number | null;
  windowFromMs: number | null;
  windowToMs: number | null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readWindowEdgeMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds vs milliseconds.
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapApiBotPerformanceSummary(data: ApiBotPerformanceSummary): BotPerformanceSummary {
  return {
    returnPct: readFiniteNumber(data.return_pct),
    benchmarkBuyHoldReturnPct: readFiniteNumber(data.benchmark_buy_hold_return_pct),
    alphaPct: readFiniteNumber(data.alpha_pct),
    maxDrawdownPct: readFiniteNumber(data.max_drawdown_pct),
    navLatestUsd: readFiniteNumber(data.nav_latest_usd),
    initialCapitalUsd: readFiniteNumber(data.initial_capital_usd),
    windowFromMs: readWindowEdgeMs(data.window?.from),
    windowToMs: readWindowEdgeMs(data.window?.to),
  };
}

export function useBotPerformanceSummary(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';

  return useQuery<BotPerformanceSummary | null>({
    queryKey: ['bot-performance-summary', apiUrl, botId, deploymentKind, authKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/performance');
      try {
        const data = await fetchOperatorBotApi<ApiBotPerformanceSummary>(
          apiUrl,
          auth,
          path,
          { auth: needsAuth },
        );
        return mapApiBotPerformanceSummary(data);
      } catch (error) {
        // Older operators do not expose /performance; callers hide the strip.
        if (
          error instanceof OperatorRequestError
          && (error.status === 404 || error.status === 405 || error.status === 501)
        ) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 30_000,
    retry: false,
    refetchOnMount: false,
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

/**
 * Owner acknowledgement of a drawdown-breaker halt. The operator rebases the
 * risk baseline to current NAV (`POST /risk/acknowledge-drawdown`, submitter
 * only), so future drawdown is measured from the acknowledged loss instead of
 * the old high-water mark. Invalidate the metrics history so the halted state
 * derived from the latest snapshot clears as soon as the rebased data lands.
 */
export function useAcknowledgeDrawdown(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const queryClient = useQueryClient();

  return useMutation<{ status: string }, Error, void>({
    mutationFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/risk/acknowledge-drawdown',
      );
      return operatorJsonWithAuth<{ status: string }>(apiUrl, path, auth, {
        method: 'POST',
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bot-metrics', apiUrl, botId] }),
        queryClient.invalidateQueries({ queryKey: ['bot-performance-summary', apiUrl, botId] }),
      ]);
    },
  });
}

export function useRevisionArena(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;
  const needsAuth = fleetReadRequiresAuth(deploymentKind);
  const authKey = needsAuth ? auth.authCacheKey : 'public';

  return useQuery<RevisionArena>({
    queryKey: ['revision-arena', apiUrl, botId, deploymentKind, authKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/evolution/revision-arena',
      );
      return fetchOperatorBotApi<RevisionArena>(apiUrl, auth, path, { auth: needsAuth });
    },
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && (!needsAuth || !!auth.getCachedToken()),
  });
}

export function useRevisionDecision(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (decision: {
      revisionId: string;
      action: 'approve' | 'reject';
      reason?: string;
      confirmLive?: boolean;
    }) => {
      const path = buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        '/evolution/revision-arena/decision',
      );
      return operatorJsonWithAuth<unknown>(apiUrl, path, auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision_id: decision.revisionId,
          action: decision.action,
          reason: decision.reason,
          confirm_live: decision.confirmLive ?? (decision.action === 'approve'),
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['revision-arena', apiUrl, botId, deploymentKind, auth.authCacheKey],
      });
    },
  });
}

export function useObservatoryOverview(options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const enabled = options.enabled ?? true;

  return useQuery<ObservatoryOverviewResponse>({
    queryKey: ['observatory-overview', apiUrl, auth.authCacheKey],
    queryFn: async () => {
      return operatorJsonWithAuth<ObservatoryOverviewResponse>(
        apiUrl,
        '/api/observatory/overview',
        auth,
        { auth: true },
      );
    },
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!auth.getCachedToken(),
  });
}

export function useBotObservatory(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const enabled = options.enabled ?? true;

  return useQuery<BotObservatoryResponse>({
    queryKey: ['bot-observatory', apiUrl, botId, deploymentKind, auth.authCacheKey],
    queryFn: async () => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/observatory');
      return fetchOperatorBotApi<BotObservatoryResponse>(apiUrl, auth, path, { auth: true });
    },
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchInterval: options.refetchInterval,
    enabled: enabled && !!apiUrl && !!botId && !!auth.getCachedToken(),
  });
}

export function useTriggerBotObservatory(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const queryClient = useQueryClient();

  return useMutation<ObservatoryTriggerResponse, Error, string>({
    mutationFn: async (reason = 'manual') => {
      const path = buildBotScopedPathForDeploymentKind(deploymentKind, botId, '/observatory/trigger');
      return operatorJsonWithAuth<ObservatoryTriggerResponse>(apiUrl, path, auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['bot-observatory', apiUrl, botId, deploymentKind, auth.authCacheKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ['observatory-overview', apiUrl, auth.authCacheKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ['bot-runs'],
        }),
      ]);
    },
  });
}

export function useObservatoryIdeaFeedback(botId: string, options: BotApiQueryOptions = {}) {
  const apiUrl = options.operatorApiUrl ?? '';
  const auth = useOperatorAuth(apiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(options.operatorKind);
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, {
    ideaId: string;
    action: 'interesting' | 'rejected' | 'delegate_research' | 'delegate_build' | 'mute';
    note?: string;
  }>({
    mutationFn: async (feedback: {
      ideaId: string;
      action: 'interesting' | 'rejected' | 'delegate_research' | 'delegate_build' | 'mute';
      note?: string;
    }) => {
      const path = buildBotScopedPathForDeploymentKind(
        deploymentKind,
        botId,
        `/observatory/ideas/${encodeURIComponent(feedback.ideaId)}/feedback`,
      );
      return operatorJsonWithAuth<unknown>(apiUrl, path, auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: feedback.action,
          note: feedback.note,
        }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['bot-observatory', apiUrl, botId, deploymentKind, auth.authCacheKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ['observatory-overview', apiUrl, auth.authCacheKey],
        }),
      ]);
    },
  });
}
