export type TradeAction = 'buy' | 'sell';
export type TradeStatus = 'executed' | 'pending' | 'rejected' | 'paper';

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

/** Trade venue derived from target_protocol. */
export type TradeVenue = 'clob' | 'dex' | 'perp' | 'yield' | 'prediction' | 'paper' | 'unknown';

export interface Trade {
  id: string;
  botId: string;
  botName: string;
  action: TradeAction;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  priceUsd: number;
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
  /** Aggregate score across all validators */
  validatorScore?: number;
  /** First validator's reasoning (convenience accessor) */
  validatorReasoning?: string;
  /** Full per-validator breakdown with signatures and EIP-712 domain metadata */
  validation?: TradeValidation;
}

/** Map target_protocol string to a display venue. */
export function protocolToVenue(protocol?: string, paperTrade?: boolean): TradeVenue {
  if (paperTrade) return 'paper';
  switch (protocol) {
    case 'polymarket_clob': return 'clob';
    case 'polymarket': return 'prediction';
    case 'uniswap_v3': return 'dex';
    case 'gmx_v2':
    case 'vertex': return 'perp';
    case 'aave_v3':
    case 'morpho': return 'yield';
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
