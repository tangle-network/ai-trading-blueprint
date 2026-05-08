import { encodeFunctionData, type Address, type Hex } from 'viem';
import { TRADING_VAULT_ABI } from './abi/tradingVault.js';
import type {
  Envelope,
  ExecuteParams,
  HealthFactorParams,
  DebtReductionParams,
  AaveBorrowEnforcement,
  AaveRepayEnforcement,
  AaveSupplyEnforcement,
  AaveWithdrawEnforcement,
  AerodromeSwapEnforcement,
  CurveStableSwapEnforcement,
  MorphoBorrowEnforcement,
  MorphoRepayEnforcement,
  MorphoSupplyEnforcement,
  MorphoWithdrawEnforcement,
  PancakeswapV3SwapEnforcement,
  UniswapV3SwapEnforcement,
  UniswapV4SwapEnforcement,
} from './types/envelope.js';
import type { ValidatorSignature } from './validator/types.js';

/**
 * The raw transaction the SDK hands back to the caller. The caller is
 * responsible for actually broadcasting via viem `walletClient.sendTransaction`
 * or wagmi `useSendTransaction`.
 */
export type PreparedTx = {
  to: Address;
  data: Hex;
  value: bigint;
  validatorSignatures: readonly Hex[];
  validatorSigners: readonly Address[];
  validatorScores: readonly bigint[];
  /** Adapter-predicted output (for swaps) or amount (for lend/borrow). */
  predictedOutput: bigint;
};

const sortValidatorBundle = (sigs: readonly ValidatorSignature[]): {
  signers: readonly Address[];
  signatures: readonly Hex[];
  scores: readonly bigint[];
} => {
  const sorted = [...sigs].sort((a, b) => {
    const av = BigInt(a.signer);
    const bv = BigInt(b.signer);
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  });
  return {
    signers: sorted.map((s) => s.signer),
    signatures: sorted.map((s) => s.signature),
    scores: sorted.map((s) => s.score),
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// Per-variant calldata encoders. These are the low-level escape hatches: a
// power-user that already has an envelope + enforcement struct can call them
// directly to skip routing.
// ──────────────────────────────────────────────────────────────────────────────

export type RawCallParams<TEnf, TParams = ExecuteParams> = {
  vault: Address;
  params: TParams;
  envelope: Envelope;
  enforcement: TEnf;
  validatorSignatures: readonly ValidatorSignature[];
  /** Adapter-predicted output amount, surfaced in the returned PreparedTx. */
  predictedOutput: bigint;
};

const buildPreparedTx = <TEnf>(
  fnName:
    | 'executeUniswapV3SwapEnvelope'
    | 'executeUniswapV4SwapEnvelope'
    | 'executeAerodromeSwapEnvelope'
    | 'executePancakeswapV3SwapEnvelope'
    | 'executeCurveStableSwapEnvelope'
    | 'executeAaveSupplyEnvelope'
    | 'executeAaveWithdrawEnvelope'
    | 'executeAaveBorrowEnvelope'
    | 'executeAaveRepayEnvelope'
    | 'executeMorphoSupplyEnvelope'
    | 'executeMorphoWithdrawEnvelope'
    | 'executeMorphoBorrowEnvelope'
    | 'executeMorphoRepayEnvelope',
  args: readonly unknown[],
  raw: RawCallParams<TEnf, ExecuteParams | HealthFactorParams | DebtReductionParams>,
): PreparedTx => {
  const data = encodeFunctionData({
    abi: TRADING_VAULT_ABI,
    functionName: fnName,
    args,
  });
  const bundle = sortValidatorBundle(raw.validatorSignatures);
  return {
    to: raw.vault,
    data,
    value: raw.params.value,
    validatorSignatures: bundle.signatures,
    validatorSigners: bundle.signers,
    validatorScores: bundle.scores,
    predictedOutput: raw.predictedOutput,
  };
};

const swapArgs = <TEnf>(raw: RawCallParams<TEnf, ExecuteParams>) => {
  const bundle = sortValidatorBundle(raw.validatorSignatures);
  return [
    raw.params,
    raw.envelope,
    raw.enforcement,
    bundle.signers,
    bundle.signatures,
    bundle.scores,
  ] as const;
};

const healthArgs = <TEnf>(raw: RawCallParams<TEnf, HealthFactorParams>) => {
  const bundle = sortValidatorBundle(raw.validatorSignatures);
  return [
    raw.params,
    raw.envelope,
    raw.enforcement,
    bundle.signers,
    bundle.signatures,
    bundle.scores,
  ] as const;
};

const debtArgs = <TEnf>(raw: RawCallParams<TEnf, DebtReductionParams>) => {
  const bundle = sortValidatorBundle(raw.validatorSignatures);
  return [
    raw.params,
    raw.envelope,
    raw.enforcement,
    bundle.signers,
    bundle.signatures,
    bundle.scores,
  ] as const;
};

export const executeUniswapV3SwapEnvelope = (
  raw: RawCallParams<UniswapV3SwapEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executeUniswapV3SwapEnvelope', swapArgs(raw), raw);

export const executeUniswapV4SwapEnvelope = (
  raw: RawCallParams<UniswapV4SwapEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executeUniswapV4SwapEnvelope', swapArgs(raw), raw);

export const executeAerodromeSwapEnvelope = (
  raw: RawCallParams<AerodromeSwapEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executeAerodromeSwapEnvelope', swapArgs(raw), raw);

export const executePancakeswapV3SwapEnvelope = (
  raw: RawCallParams<PancakeswapV3SwapEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executePancakeswapV3SwapEnvelope', swapArgs(raw), raw);

export const executeCurveStableSwapEnvelope = (
  raw: RawCallParams<CurveStableSwapEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executeCurveStableSwapEnvelope', swapArgs(raw), raw);

export const executeAaveSupplyEnvelope = (
  raw: RawCallParams<AaveSupplyEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executeAaveSupplyEnvelope', swapArgs(raw), raw);

export const executeAaveWithdrawEnvelope = (
  raw: RawCallParams<AaveWithdrawEnforcement, HealthFactorParams>,
): PreparedTx => buildPreparedTx('executeAaveWithdrawEnvelope', healthArgs(raw), raw);

export const executeAaveBorrowEnvelope = (
  raw: RawCallParams<AaveBorrowEnforcement, HealthFactorParams>,
): PreparedTx => buildPreparedTx('executeAaveBorrowEnvelope', healthArgs(raw), raw);

export const executeAaveRepayEnvelope = (
  raw: RawCallParams<AaveRepayEnforcement, DebtReductionParams>,
): PreparedTx => buildPreparedTx('executeAaveRepayEnvelope', debtArgs(raw), raw);

export const executeMorphoSupplyEnvelope = (
  raw: RawCallParams<MorphoSupplyEnforcement, ExecuteParams>,
): PreparedTx => buildPreparedTx('executeMorphoSupplyEnvelope', swapArgs(raw), raw);

export const executeMorphoWithdrawEnvelope = (
  raw: RawCallParams<MorphoWithdrawEnforcement, HealthFactorParams>,
): PreparedTx => buildPreparedTx('executeMorphoWithdrawEnvelope', healthArgs(raw), raw);

export const executeMorphoBorrowEnvelope = (
  raw: RawCallParams<MorphoBorrowEnforcement, HealthFactorParams>,
): PreparedTx => buildPreparedTx('executeMorphoBorrowEnvelope', healthArgs(raw), raw);

export const executeMorphoRepayEnvelope = (
  raw: RawCallParams<MorphoRepayEnforcement, DebtReductionParams>,
): PreparedTx => buildPreparedTx('executeMorphoRepayEnvelope', debtArgs(raw), raw);

/** Public namespace for the low-level escape hatch surfaced on `vault.raw`. */
export type RawApi = {
  executeUniswapV3SwapEnvelope: typeof executeUniswapV3SwapEnvelope;
  executeUniswapV4SwapEnvelope: typeof executeUniswapV4SwapEnvelope;
  executeAerodromeSwapEnvelope: typeof executeAerodromeSwapEnvelope;
  executePancakeswapV3SwapEnvelope: typeof executePancakeswapV3SwapEnvelope;
  executeCurveStableSwapEnvelope: typeof executeCurveStableSwapEnvelope;
  executeAaveSupplyEnvelope: typeof executeAaveSupplyEnvelope;
  executeAaveWithdrawEnvelope: typeof executeAaveWithdrawEnvelope;
  executeAaveBorrowEnvelope: typeof executeAaveBorrowEnvelope;
  executeAaveRepayEnvelope: typeof executeAaveRepayEnvelope;
  executeMorphoSupplyEnvelope: typeof executeMorphoSupplyEnvelope;
  executeMorphoWithdrawEnvelope: typeof executeMorphoWithdrawEnvelope;
  executeMorphoBorrowEnvelope: typeof executeMorphoBorrowEnvelope;
  executeMorphoRepayEnvelope: typeof executeMorphoRepayEnvelope;
};

export const RAW_API: RawApi = {
  executeUniswapV3SwapEnvelope,
  executeUniswapV4SwapEnvelope,
  executeAerodromeSwapEnvelope,
  executePancakeswapV3SwapEnvelope,
  executeCurveStableSwapEnvelope,
  executeAaveSupplyEnvelope,
  executeAaveWithdrawEnvelope,
  executeAaveBorrowEnvelope,
  executeAaveRepayEnvelope,
  executeMorphoSupplyEnvelope,
  executeMorphoWithdrawEnvelope,
  executeMorphoBorrowEnvelope,
  executeMorphoRepayEnvelope,
};
