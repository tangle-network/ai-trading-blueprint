import {
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';

// ──────────────────────────────────────────────────────────────────────────────
// Encoders for the inner router calldata (`params.data`) of each on-chain
// envelope variant. The TradingVault decodes `params.data` and verifies it
// against the signed enforcement struct, so these encoders must match the
// exact ABI shape expected by `_decode<X>` in TradingVault.sol.
// ──────────────────────────────────────────────────────────────────────────────

// ── Uniswap V3 / PancakeSwap V3 ───────────────────────────────────────────────

const UNI_V3_EXACT_INPUT_SINGLE_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export type UniswapV3ExactInputSingleArgs = {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
};

export const encodeUniswapV3ExactInputSingle = (args: UniswapV3ExactInputSingleArgs): Hex =>
  encodeFunctionData({
    abi: UNI_V3_EXACT_INPUT_SINGLE_ABI,
    functionName: 'exactInputSingle',
    args: [args],
  });

/**
 * PancakeSwap V3 reuses the Uniswap V3 ABI — only the router address differs.
 * Audit note in TradingVault.sol#1488 confirms the on-chain executor reuses
 * `_decodeExactInputSingle` for both.
 */
export const encodePancakeswapV3ExactInputSingle = encodeUniswapV3ExactInputSingle;

// ── Aerodrome Slipstream ──────────────────────────────────────────────────────

const AERODROME_EXACT_INPUT_SINGLE_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export type AerodromeExactInputSingleArgs = {
  tokenIn: Address;
  tokenOut: Address;
  tickSpacing: number;
  recipient: Address;
  deadline: bigint;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
};

export const encodeAerodromeExactInputSingle = (args: AerodromeExactInputSingleArgs): Hex =>
  encodeFunctionData({
    abi: AERODROME_EXACT_INPUT_SINGLE_ABI,
    functionName: 'exactInputSingle',
    args: [args],
  });

// ── Curve StableSwap ──────────────────────────────────────────────────────────

const CURVE_EXCHANGE_SELECTOR = toFunctionSelector('exchange(int128,int128,uint256,uint256)');

export const encodeCurveExchange = (i: bigint, j: bigint, dx: bigint, minDy: bigint): Hex => {
  const params = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }, { type: 'uint256' }],
    [i, j, dx, minDy],
  );
  return `${CURVE_EXCHANGE_SELECTOR}${params.slice(2)}`;
};

// ── Aave V3 ───────────────────────────────────────────────────────────────────

const AAVE_POOL_ABI = [
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'borrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'repay',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const encodeAaveSupply = (asset: Address, amount: bigint, onBehalfOf: Address): Hex =>
  encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: 'supply',
    args: [asset, amount, onBehalfOf, 0],
  });

export const encodeAaveWithdraw = (asset: Address, amount: bigint, to: Address): Hex =>
  encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: 'withdraw', args: [asset, amount, to] });

export const encodeAaveBorrow = (
  asset: Address,
  amount: bigint,
  interestRateMode: bigint,
  onBehalfOf: Address,
): Hex =>
  encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: 'borrow',
    args: [asset, amount, interestRateMode, 0, onBehalfOf],
  });

export const encodeAaveRepay = (
  asset: Address,
  amount: bigint,
  interestRateMode: bigint,
  onBehalfOf: Address,
): Hex =>
  encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: 'repay',
    args: [asset, amount, interestRateMode, onBehalfOf],
  });

// ── Morpho Blue ───────────────────────────────────────────────────────────────

const MORPHO_MARKET_PARAMS = {
  type: 'tuple',
  components: [
    { name: 'loanToken', type: 'address' },
    { name: 'collateralToken', type: 'address' },
    { name: 'oracle', type: 'address' },
    { name: 'irm', type: 'address' },
    { name: 'lltv', type: 'uint256' },
  ],
} as const;

const MORPHO_ABI = [
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      MORPHO_MARKET_PARAMS,
      { name: 'assets', type: 'uint256' },
      { name: 'shares', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [
      { type: 'uint256' },
      { type: 'uint256' },
    ],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      MORPHO_MARKET_PARAMS,
      { name: 'assets', type: 'uint256' },
      { name: 'shares', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [
      { type: 'uint256' },
      { type: 'uint256' },
    ],
  },
  {
    name: 'borrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      MORPHO_MARKET_PARAMS,
      { name: 'assets', type: 'uint256' },
      { name: 'shares', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [
      { type: 'uint256' },
      { type: 'uint256' },
    ],
  },
  {
    name: 'repay',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      MORPHO_MARKET_PARAMS,
      { name: 'assets', type: 'uint256' },
      { name: 'shares', type: 'uint256' },
      { name: 'onBehalf', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [
      { type: 'uint256' },
      { type: 'uint256' },
    ],
  },
] as const;

export type MorphoMarketParams = {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
};

export const encodeMorphoSupply = (
  market: MorphoMarketParams,
  assets: bigint,
  onBehalf: Address,
): Hex =>
  encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'supply',
    args: [market, assets, 0n, onBehalf, '0x'],
  });

export const encodeMorphoWithdraw = (
  market: MorphoMarketParams,
  assets: bigint,
  onBehalf: Address,
  receiver: Address,
): Hex =>
  encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'withdraw',
    args: [market, assets, 0n, onBehalf, receiver],
  });

export const encodeMorphoBorrow = (
  market: MorphoMarketParams,
  assets: bigint,
  onBehalf: Address,
  receiver: Address,
): Hex =>
  encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'borrow',
    args: [market, assets, 0n, onBehalf, receiver],
  });

export const encodeMorphoRepay = (market: MorphoMarketParams, assets: bigint, onBehalf: Address): Hex =>
  encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'repay',
    args: [market, assets, 0n, onBehalf, '0x'],
  });
