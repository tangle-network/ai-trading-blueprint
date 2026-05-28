import type { ResolvedAssetDisplay } from '~/lib/tradeTokenMetadata';

export type TradeAction =
  | 'buy'
  | 'sell'
  | 'swap'
  | 'open_long'
  | 'open_short'
  | 'close_long'
  | 'close_short';
export type TradeStatus = 'executed' | 'pending' | 'rejected' | 'paper' | 'failed';
export type TradeExecutionStatus = 'paper' | 'submitted' | 'confirmed' | 'filled' | 'partial' | 'no_fill';

export interface ValidatorResponseDetail {
  validator: string;
  score: number;
  reasoning: string;
  signature: string;
  chainId?: number;
  verifyingContract?: string;
  validatedAt?: string;
}

export interface TradeSimulation {
  success: boolean;
  gasUsed: number;
  riskScore: number;
  warnings: string[];
  outputAmount: string;
}

export interface TradeValidation {
  approved: boolean;
  aggregateScore: number;
  intentHash: string;
  responses: ValidatorResponseDetail[];
  simulation?: TradeSimulation;
}

export interface TradeExecutionDetails {
  status: TradeExecutionStatus;
  clobOrderId?: string;
  requestedPriceUsd?: number | null;
  filledPriceUsd?: number | null;
  filledAmount?: number | null;
  slippageBps?: number | null;
  reason?: string;
}

export interface PredictionTradeMetadata {
  conditionId?: string;
  tokenId?: string;
  marketQuestion?: string;
  outcomeLabel?: string;
  outcomeIndex?: number;
  marketSlug?: string;
}

export interface HyperliquidTradeMetadata {
  asset?: string;
  assetSize?: string;
  orderType?: string;
  reduceOnly?: boolean;
}

export type TradeDecisionSource =
  | 'agent_execution'
  | 'code_strategy'
  | 'manual'
  | 'backtest'
  | 'unknown'
  | string;

/** Trade venue derived from target_protocol. */
export type TradeVenue = 'clob' | 'dex' | 'perp' | 'yield' | 'prediction' | 'paper' | 'unknown';

export interface Trade {
  id: string;
  botId: string;
  botName: string;
  action: TradeAction;
  assetIn: ResolvedAssetDisplay;
  assetOut: ResolvedAssetDisplay;
  tokenIn: string;
  tokenOut: string;
  rawTokenIn?: string;
  rawTokenOut?: string;
  amountIn: number;
  amountOut: number;
  priceUsd: number | null;
  notionalUsd?: number | null;
  timestamp: number;
  status: TradeStatus;
  txHash?: string;
  paperTrade?: boolean;
  /** Protocol used for this trade (e.g. uniswap_v3, polymarket_clob, aave_v3). */
  targetProtocol?: string;
  /** Derived trade venue for display badges. */
  venue: TradeVenue;
  /** Chain ID for explorer links. */
  chainId?: number;
  /** On-chain block number for executed trades (when available). */
  blockNumber?: number;
  /** On-chain gas used for executed trades (when available). */
  gasUsed?: string;
  /** Aggregate score across all validators */
  validatorScore?: number;
  /** First validator's reasoning (convenience accessor) */
  validatorReasoning?: string;
  /** Full per-validator breakdown with signatures and EIP-712 domain metadata */
  validation?: TradeValidation;
  /** Execution metadata for QA and replay/debugging. */
  execution?: TradeExecutionDetails;
  /** Persisted Polymarket metadata for human-readable trade history labels. */
  predictionMetadata?: PredictionTradeMetadata;
  /** Persisted Hyperliquid metadata for perp-specific trade history labels. */
  hyperliquidMetadata?: HyperliquidTradeMetadata;
  /** Mechanism that produced the trade: agent execution, generated code strategy, manual, etc. */
  decisionSource?: TradeDecisionSource;
  /** Generated strategy module id or other strategy-level mechanism id. */
  strategyModuleId?: string;
  /** Sandbox revision that produced the trade, when known. */
  revisionId?: string;
  /** Candidate hash under paper evaluation, when known. */
  candidateHash?: string;
  /** Agent-supplied reason from trade metadata. */
  agentReasoning?: string;
  /** Machine-readable signal emitted by a strategy runner. */
  runnerSignal?: unknown;
  /** Harness version active when the trade was submitted. */
  harnessVersion?: number;
}

/** Map target_protocol string to a display venue. */
export function protocolToVenue(protocol?: string, paperTrade?: boolean): TradeVenue {
  if (paperTrade) return 'paper';
  switch (protocol) {
    case 'polymarket_clob': return 'clob';
    case 'polymarket': return 'prediction';
    case 'uniswap_v3': return 'dex';
    case 'gmx_v2':
    case 'hyperliquid':
    case 'vertex': return 'perp';
    case 'aave_v3':
    case 'morpho_vault': return 'yield';
    default: return protocol ? 'unknown' : 'paper';
  }
}

/** Label + icon class for each venue. */
export const VENUE_CONFIG: Record<TradeVenue, { label: string; icon: string; color: string }> = {
  clob: { label: 'CLOB', icon: 'i-ph:book-open', color: 'text-purple-600 dark:text-purple-400' },
  dex: { label: 'DEX', icon: 'i-ph:swap', color: 'text-blue-600 dark:text-blue-400' },
  perp: { label: 'PERP', icon: 'i-ph:chart-line-up', color: 'text-orange-600 dark:text-orange-400' },
  yield: { label: 'YIELD', icon: 'i-ph:coins', color: 'text-green-600 dark:text-green-400' },
  prediction: { label: 'CTF', icon: 'i-ph:target', color: 'text-pink-600 dark:text-pink-400' },
  paper: { label: 'PAPER', icon: 'i-ph:notepad', color: 'text-arena-elements-textTertiary' },
  unknown: { label: '?', icon: 'i-ph:question', color: 'text-arena-elements-textTertiary' },
};

export function getTradePairLabel(trade: Pick<Trade, 'targetProtocol' | 'predictionMetadata' | 'tokenIn' | 'tokenOut'>): string {
  if (trade.targetProtocol !== 'polymarket_clob') {
    return `${trade.tokenIn}/${trade.tokenOut}`;
  }

  const parts = [
    trade.predictionMetadata?.marketQuestion?.trim(),
    trade.predictionMetadata?.outcomeLabel?.trim(),
  ].filter((value): value is string => Boolean(value));

  if (parts.length > 0) {
    return parts.join(' - ');
  }

  return `${trade.tokenIn}/${trade.tokenOut}`;
}
