import type { Address } from 'viem';
import type { EnforcementVariant, ExecuteParams } from '../types/envelope.js';
import type { LendingProtocol, SwapProtocol } from '../types/protocols.js';

/** Caller-supplied swap intent, before adapter routing. */
export type SwapIntent = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Caller-supplied minimum-out floor (slippage); the SDK takes max(this, perInputFloor). */
  minOut: bigint;
  /** Unix-seconds deadline used both off-chain and inside the router calldata. */
  deadline: bigint;
  /** Optional override of the default routing slippage tolerance (basis points). */
  slippageBps?: bigint;
};

/** A single adapter's quote for a swap intent. */
export type SwapQuote = {
  protocol: SwapProtocol;
  /** Adapter-predicted output amount in `tokenOut` units. */
  amountOut: bigint;
  /** Optional gas-cost estimate (wei). The router prefers higher gas-adjusted output. */
  gasEstimate?: bigint;
  /**
   * The on-chain artifacts the SDK will sign + submit on this adapter's behalf.
   * The adapter is responsible for producing both `params.data` (router calldata)
   * and the matching enforcement struct so the SDK can hash + envelope it.
   */
  execute: ExecuteParams;
  enforcement: EnforcementVariant;
};

/** A swap-quote adapter. One adapter per (protocol, chain) combo. */
export type SwapAdapter = {
  protocol: SwapProtocol;
  /** Returns `null` when the adapter doesn't have a route for this pair. */
  quote: (intent: SwapIntent) => Promise<SwapQuote | null>;
};

/** Caller-supplied lending intent (supply / withdraw). */
export type LendIntent = {
  protocol: LendingProtocol;
  asset: Address;
  amount: bigint;
  deadline: bigint;
};

export type WithdrawIntent = LendIntent & {
  /** Aave/Morpho-style health-factor floor (1e18-scaled). */
  minHealthFactor: bigint;
};

export type BorrowIntent = WithdrawIntent;

export type RepayIntent = LendIntent & {
  debtToken: Address;
};

/** A single adapter's lending plan for a lend / withdraw / borrow / repay intent. */
export type LendingPlan = {
  protocol: LendingProtocol;
  /** Final on-chain ExecuteParams or HealthFactorParams or DebtReductionParams. */
  execute: ExecuteParams;
  enforcement: EnforcementVariant;
};

export type LendingAdapter = {
  protocol: LendingProtocol;
  supply: (intent: LendIntent) => Promise<LendingPlan | null>;
  withdraw: (intent: WithdrawIntent) => Promise<LendingPlan | null>;
  borrow: (intent: BorrowIntent) => Promise<LendingPlan | null>;
  repay: (intent: RepayIntent) => Promise<LendingPlan | null>;
};
