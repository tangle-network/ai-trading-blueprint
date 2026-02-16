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

export interface TradeValidation {
  approved: boolean;
  aggregateScore: number;
  intentHash: string;
  responses: ValidatorResponseDetail[];
}

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
  /** Aggregate score across all validators */
  validatorScore?: number;
  /** First validator's reasoning (convenience accessor) */
  validatorReasoning?: string;
  /** Full per-validator breakdown with signatures and EIP-712 domain metadata */
  validation?: TradeValidation;
}
