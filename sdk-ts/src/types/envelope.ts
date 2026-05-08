import type { Address, Hex } from 'viem';

/**
 * Universal EIP-712 envelope wrapper. Mirrors `TradeValidator.Envelope` exactly.
 * `enforcementHash` is the keccak of the matching per-protocol enforcement struct,
 * computed by `hashEnforcement()` in `../encoding/enforcementHash.ts`.
 *
 * Source: contracts/src/TradeValidator.sol#400-413
 */
export type Envelope = {
  version: bigint;
  botIdHash: Hex;
  vault: Address;
  chainId: bigint;
  protocolHash: Hex;
  policyHash: Hex;
  enforcementHash: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: bigint;
  signersHash: Hex;
  minSignatures: bigint;
};

/** EIP-712 typehash strings — must match the Solidity constants byte-for-byte. */
export const ENVELOPE_TYPE =
  'Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)' as const;

// ── Per-protocol enforcement struct types ────────────────────────────────────
// Each maps 1:1 to a Solidity struct in TradeValidator.sol. Field ORDER matters
// because the on-chain enforcement-hash is `keccak256(abi.encode(TYPEHASH, ...fields))`
// in declaration order — matched by `../encoding/enforcementHash.ts`.

export type UniswapV3SwapEnforcement = {
  feeTier: bigint;
  maxSingleAmountIn: bigint;
  maxTotalAmountIn: bigint;
  maxValue: bigint;
  minOutputPerInput: bigint;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  sqrtPriceLimitX96: bigint;
};

export type UniswapV4SwapEnforcement = {
  currency0: Address;
  currency1: Address;
  fee: bigint;
  tickSpacing: bigint;
  hooks: Address;
  zeroForOne: boolean;
  maxSingleAmountIn: bigint;
  maxTotalAmountIn: bigint;
  maxValue: bigint;
  minOutputPerInput: bigint;
  universalRouter: Address;
  hookDataHash: Hex;
};

export type AerodromeSwapEnforcement = {
  maxSingleAmountIn: bigint;
  maxTotalAmountIn: bigint;
  maxValue: bigint;
  minOutputPerInput: bigint;
  router: Address;
  tickSpacing: bigint;
  tokenIn: Address;
  tokenOut: Address;
  sqrtPriceLimitX96: bigint;
};

export type PancakeswapV3SwapEnforcement = {
  feeTier: bigint;
  maxSingleAmountIn: bigint;
  maxTotalAmountIn: bigint;
  maxValue: bigint;
  minOutputPerInput: bigint;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  sqrtPriceLimitX96: bigint;
};

export type CurveStableSwapEnforcement = {
  i: bigint;
  j: bigint;
  maxSingleAmountIn: bigint;
  maxTotalAmountIn: bigint;
  maxValue: bigint;
  minOutputPerInput: bigint;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
};

export type AaveSupplyEnforcement = {
  asset: Address;
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  pool: Address;
};

export type AaveWithdrawEnforcement = {
  asset: Address;
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  minHealthFactor: bigint;
  pool: Address;
};

export type AaveBorrowEnforcement = {
  asset: Address;
  interestRateMode: bigint;
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  minHealthFactor: bigint;
  pool: Address;
};

export type AaveRepayEnforcement = {
  asset: Address;
  debtToken: Address;
  interestRateMode: bigint;
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  pool: Address;
};

export type MorphoSupplyEnforcement = {
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  marketId: Hex;
  morpho: Address;
};

export type MorphoWithdrawEnforcement = {
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  marketId: Hex;
  minCollateralRatio: bigint;
  morpho: Address;
};

export type MorphoBorrowEnforcement = {
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  marketId: Hex;
  minCollateralRatio: bigint;
  morpho: Address;
};

export type MorphoRepayEnforcement = {
  maxSingleAmount: bigint;
  maxTotalAmount: bigint;
  maxValue: bigint;
  marketId: Hex;
  morpho: Address;
};

/** Discriminated-union of every supported enforcement variant. */
export type EnforcementVariant =
  | { kind: 'uniswap_v3_swap'; enforcement: UniswapV3SwapEnforcement }
  | { kind: 'uniswap_v4_swap'; enforcement: UniswapV4SwapEnforcement }
  | { kind: 'aerodrome_swap'; enforcement: AerodromeSwapEnforcement }
  | { kind: 'pancakeswap_v3_swap'; enforcement: PancakeswapV3SwapEnforcement }
  | { kind: 'curve_stable_swap'; enforcement: CurveStableSwapEnforcement }
  | { kind: 'aave_supply'; enforcement: AaveSupplyEnforcement }
  | { kind: 'aave_withdraw'; enforcement: AaveWithdrawEnforcement }
  | { kind: 'aave_borrow'; enforcement: AaveBorrowEnforcement }
  | { kind: 'aave_repay'; enforcement: AaveRepayEnforcement }
  | { kind: 'morpho_supply'; enforcement: MorphoSupplyEnforcement }
  | { kind: 'morpho_withdraw'; enforcement: MorphoWithdrawEnforcement }
  | { kind: 'morpho_borrow'; enforcement: MorphoBorrowEnforcement }
  | { kind: 'morpho_repay'; enforcement: MorphoRepayEnforcement };

export type EnforcementKind = EnforcementVariant['kind'];

/** ExecuteParams — TradingVault.ExecuteParams. */
export type ExecuteParams = {
  target: Address;
  data: Hex;
  value: bigint;
  minOutput: bigint;
  outputToken: Address;
  intentHash: Hex;
  deadline: bigint;
};

/** DebtReductionParams — TradingVault.DebtReductionParams. */
export type DebtReductionParams = {
  target: Address;
  data: Hex;
  value: bigint;
  inputToken: Address;
  maxInput: bigint;
  debtToken: Address;
  minDebtDecrease: bigint;
  intentHash: Hex;
  deadline: bigint;
};

/** HealthFactorParams — TradingVault.HealthFactorParams. */
export type HealthFactorParams = {
  target: Address;
  data: Hex;
  value: bigint;
  minOutput: bigint;
  outputToken: Address;
  pool: Address;
  account: Address;
  minHealthFactor: bigint;
  intentHash: Hex;
  deadline: bigint;
};
