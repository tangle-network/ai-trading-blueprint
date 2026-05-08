import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type AbiParameter,
  type Hex,
} from 'viem';
import type {
  AaveBorrowEnforcement,
  AaveRepayEnforcement,
  AaveSupplyEnforcement,
  AaveWithdrawEnforcement,
  AerodromeSwapEnforcement,
  CurveStableSwapEnforcement,
  EnforcementVariant,
  Envelope,
  MorphoBorrowEnforcement,
  MorphoRepayEnforcement,
  MorphoSupplyEnforcement,
  MorphoWithdrawEnforcement,
  PancakeswapV3SwapEnforcement,
  UniswapV3SwapEnforcement,
  UniswapV4SwapEnforcement,
} from '../types/envelope.js';

// EIP-712 typehash strings — verbatim from contracts/src/TradeValidator.sol
// Exported so consumers/tests can pin them.

export const TYPE_STRINGS = {
  envelope:
    'Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)',
  uniswapV3Swap:
    'UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)',
  uniswapV4Swap:
    'UniswapV4SwapEnforcement(address currency0,address currency1,uint256 fee,int256 tickSpacing,address hooks,bool zeroForOne,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address universalRouter,bytes32 hookDataHash)',
  aerodromeSwap:
    'AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)',
  pancakeswapV3Swap:
    'PancakeswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut,uint160 sqrtPriceLimitX96)',
  curveStableSwap:
    'CurveStableSwapEnforcement(int128 i,int128 j,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 maxValue,uint256 minOutputPerInput,address pool,address tokenIn,address tokenOut)',
  aaveSupply:
    'AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)',
  aaveWithdraw:
    'AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)',
  aaveBorrow:
    'AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,uint256 minHealthFactor,address pool)',
  aaveRepay:
    'AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,address pool)',
  morphoSupply:
    'MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)',
  morphoWithdraw:
    'MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)',
  morphoBorrow:
    'MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,uint256 minCollateralRatio,address morpho)',
  morphoRepay:
    'MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 maxValue,bytes32 marketId,address morpho)',
} as const;

const typeHash = (s: string): Hex => keccak256(toHex(s));

export const TYPE_HASHES = {
  envelope: typeHash(TYPE_STRINGS.envelope),
  uniswapV3Swap: typeHash(TYPE_STRINGS.uniswapV3Swap),
  uniswapV4Swap: typeHash(TYPE_STRINGS.uniswapV4Swap),
  aerodromeSwap: typeHash(TYPE_STRINGS.aerodromeSwap),
  pancakeswapV3Swap: typeHash(TYPE_STRINGS.pancakeswapV3Swap),
  curveStableSwap: typeHash(TYPE_STRINGS.curveStableSwap),
  aaveSupply: typeHash(TYPE_STRINGS.aaveSupply),
  aaveWithdraw: typeHash(TYPE_STRINGS.aaveWithdraw),
  aaveBorrow: typeHash(TYPE_STRINGS.aaveBorrow),
  aaveRepay: typeHash(TYPE_STRINGS.aaveRepay),
  morphoSupply: typeHash(TYPE_STRINGS.morphoSupply),
  morphoWithdraw: typeHash(TYPE_STRINGS.morphoWithdraw),
  morphoBorrow: typeHash(TYPE_STRINGS.morphoBorrow),
  morphoRepay: typeHash(TYPE_STRINGS.morphoRepay),
} as const;

const BYTES32: AbiParameter = { type: 'bytes32' };
const UINT256: AbiParameter = { type: 'uint256' };
const INT256: AbiParameter = { type: 'int256' };
const ADDRESS: AbiParameter = { type: 'address' };
const BOOL: AbiParameter = { type: 'bool' };

const hashUniswapV3 = (e: UniswapV3SwapEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, UINT256, UINT256, ADDRESS, ADDRESS, ADDRESS, UINT256],
      [
        TYPE_HASHES.uniswapV3Swap,
        e.feeTier,
        e.maxSingleAmountIn,
        e.maxTotalAmountIn,
        e.maxValue,
        e.minOutputPerInput,
        e.router,
        e.tokenIn,
        e.tokenOut,
        e.sqrtPriceLimitX96,
      ],
    ),
  );

const hashUniswapV4 = (e: UniswapV4SwapEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        BYTES32,
        ADDRESS,
        ADDRESS,
        UINT256,
        INT256,
        ADDRESS,
        BOOL,
        UINT256,
        UINT256,
        UINT256,
        UINT256,
        ADDRESS,
        BYTES32,
      ],
      [
        TYPE_HASHES.uniswapV4Swap,
        e.currency0,
        e.currency1,
        e.fee,
        e.tickSpacing,
        e.hooks,
        e.zeroForOne,
        e.maxSingleAmountIn,
        e.maxTotalAmountIn,
        e.maxValue,
        e.minOutputPerInput,
        e.universalRouter,
        e.hookDataHash,
      ],
    ),
  );

const hashAerodrome = (e: AerodromeSwapEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, UINT256, ADDRESS, INT256, ADDRESS, ADDRESS, UINT256],
      [
        TYPE_HASHES.aerodromeSwap,
        e.maxSingleAmountIn,
        e.maxTotalAmountIn,
        e.maxValue,
        e.minOutputPerInput,
        e.router,
        e.tickSpacing,
        e.tokenIn,
        e.tokenOut,
        e.sqrtPriceLimitX96,
      ],
    ),
  );

const hashPancakeV3 = (e: PancakeswapV3SwapEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, UINT256, UINT256, ADDRESS, ADDRESS, ADDRESS, UINT256],
      [
        TYPE_HASHES.pancakeswapV3Swap,
        e.feeTier,
        e.maxSingleAmountIn,
        e.maxTotalAmountIn,
        e.maxValue,
        e.minOutputPerInput,
        e.router,
        e.tokenIn,
        e.tokenOut,
        e.sqrtPriceLimitX96,
      ],
    ),
  );

const hashCurveStable = (e: CurveStableSwapEnforcement): Hex =>
  // Solidity abi.encode promotes int128 → int256, so we use INT256 here too.
  keccak256(
    encodeAbiParameters(
      [BYTES32, INT256, INT256, UINT256, UINT256, UINT256, UINT256, ADDRESS, ADDRESS, ADDRESS],
      [
        TYPE_HASHES.curveStableSwap,
        e.i,
        e.j,
        e.maxSingleAmountIn,
        e.maxTotalAmountIn,
        e.maxValue,
        e.minOutputPerInput,
        e.pool,
        e.tokenIn,
        e.tokenOut,
      ],
    ),
  );

const hashAaveSupply = (e: AaveSupplyEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, ADDRESS, UINT256, UINT256, UINT256, ADDRESS],
      [TYPE_HASHES.aaveSupply, e.asset, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.pool],
    ),
  );

const hashAaveWithdraw = (e: AaveWithdrawEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, ADDRESS, UINT256, UINT256, UINT256, UINT256, ADDRESS],
      [
        TYPE_HASHES.aaveWithdraw,
        e.asset,
        e.maxSingleAmount,
        e.maxTotalAmount,
        e.maxValue,
        e.minHealthFactor,
        e.pool,
      ],
    ),
  );

const hashAaveBorrow = (e: AaveBorrowEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, ADDRESS, UINT256, UINT256, UINT256, UINT256, UINT256, ADDRESS],
      [
        TYPE_HASHES.aaveBorrow,
        e.asset,
        e.interestRateMode,
        e.maxSingleAmount,
        e.maxTotalAmount,
        e.maxValue,
        e.minHealthFactor,
        e.pool,
      ],
    ),
  );

const hashAaveRepay = (e: AaveRepayEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, ADDRESS, ADDRESS, UINT256, UINT256, UINT256, UINT256, ADDRESS],
      [
        TYPE_HASHES.aaveRepay,
        e.asset,
        e.debtToken,
        e.interestRateMode,
        e.maxSingleAmount,
        e.maxTotalAmount,
        e.maxValue,
        e.pool,
      ],
    ),
  );

const hashMorphoSupply = (e: MorphoSupplyEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, BYTES32, ADDRESS],
      [TYPE_HASHES.morphoSupply, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.marketId, e.morpho],
    ),
  );

const hashMorphoWithdraw = (e: MorphoWithdrawEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, BYTES32, UINT256, ADDRESS],
      [
        TYPE_HASHES.morphoWithdraw,
        e.maxSingleAmount,
        e.maxTotalAmount,
        e.maxValue,
        e.marketId,
        e.minCollateralRatio,
        e.morpho,
      ],
    ),
  );

const hashMorphoBorrow = (e: MorphoBorrowEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, BYTES32, UINT256, ADDRESS],
      [
        TYPE_HASHES.morphoBorrow,
        e.maxSingleAmount,
        e.maxTotalAmount,
        e.maxValue,
        e.marketId,
        e.minCollateralRatio,
        e.morpho,
      ],
    ),
  );

const hashMorphoRepay = (e: MorphoRepayEnforcement): Hex =>
  keccak256(
    encodeAbiParameters(
      [BYTES32, UINT256, UINT256, UINT256, BYTES32, ADDRESS],
      [TYPE_HASHES.morphoRepay, e.maxSingleAmount, e.maxTotalAmount, e.maxValue, e.marketId, e.morpho],
    ),
  );

/**
 * Compute the EIP-712 struct-hash of an enforcement variant. Result MUST equal
 * the on-chain `_hash<X>Enforcement` for the matching Solidity struct — this is
 * what gets stored in `Envelope.enforcementHash`.
 */
export const hashEnforcement = (variant: EnforcementVariant): Hex => {
  switch (variant.kind) {
    case 'uniswap_v3_swap':
      return hashUniswapV3(variant.enforcement);
    case 'uniswap_v4_swap':
      return hashUniswapV4(variant.enforcement);
    case 'aerodrome_swap':
      return hashAerodrome(variant.enforcement);
    case 'pancakeswap_v3_swap':
      return hashPancakeV3(variant.enforcement);
    case 'curve_stable_swap':
      return hashCurveStable(variant.enforcement);
    case 'aave_supply':
      return hashAaveSupply(variant.enforcement);
    case 'aave_withdraw':
      return hashAaveWithdraw(variant.enforcement);
    case 'aave_borrow':
      return hashAaveBorrow(variant.enforcement);
    case 'aave_repay':
      return hashAaveRepay(variant.enforcement);
    case 'morpho_supply':
      return hashMorphoSupply(variant.enforcement);
    case 'morpho_withdraw':
      return hashMorphoWithdraw(variant.enforcement);
    case 'morpho_borrow':
      return hashMorphoBorrow(variant.enforcement);
    case 'morpho_repay':
      return hashMorphoRepay(variant.enforcement);
  }
};

/**
 * Compute the EIP-712 struct-hash of the universal Envelope wrapper.
 * Mirrors `TradeValidator._hashEnvelope`.
 */
export const hashEnvelope = (env: Envelope): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        BYTES32,
        UINT256,
        BYTES32,
        ADDRESS,
        UINT256,
        BYTES32,
        BYTES32,
        BYTES32,
        UINT256,
        UINT256,
        UINT256,
        BYTES32,
        UINT256,
      ],
      [
        TYPE_HASHES.envelope,
        env.version,
        env.botIdHash,
        env.vault,
        env.chainId,
        env.protocolHash,
        env.policyHash,
        env.enforcementHash,
        env.issuedAt,
        env.expiresAt,
        env.nonce,
        env.signersHash,
        env.minSignatures,
      ],
    ),
  );

/**
 * Hash the sorted approval-signer set as the on-chain validator does.
 * Off-chain Rust sorts addresses ascending then concatenates the raw 20-byte
 * representations; this MUST match exactly. See `_hashApprovalSigners` in
 * TradeValidator.sol#615.
 */
export const hashApprovalSigners = (signers: readonly `0x${string}`[]): Hex => {
  if (signers.length === 0) {
    return keccak256('0x');
  }
  const sorted = [...signers].sort((a, b) => {
    const av = BigInt(a);
    const bv = BigInt(b);
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  });
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    if (cur === undefined) continue;
    if (BigInt(cur) === 0n) {
      throw new Error('hashApprovalSigners: zero address');
    }
    if (i > 0 && prev !== undefined && BigInt(cur) === BigInt(prev)) {
      throw new Error('hashApprovalSigners: duplicate signer');
    }
  }
  const joined: Hex = `0x${sorted.map((s) => s.slice(2).toLowerCase()).join('')}`;
  return keccak256(joined);
};
