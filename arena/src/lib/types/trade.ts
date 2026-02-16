export type TradeAction = 'buy' | 'sell';
export type TradeStatus = 'executed' | 'pending' | 'rejected' | 'paper';

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
  validatorScore?: number;
  validatorReasoning?: string;
}
