import type { Address, Hex } from 'viem';
import { keccak256, toHex } from 'viem';
import {
  encodeAaveBorrow,
  encodeAaveRepay,
  encodeAaveSupply,
  encodeAaveWithdraw,
  encodeAerodromeExactInputSingle,
  encodeMorphoBorrow,
  encodeMorphoRepay,
  encodeMorphoSupply,
  encodeMorphoWithdraw,
  encodePancakeswapV3ExactInputSingle,
  encodeUniswapV3ExactInputSingle,
  encodeCurveExchange,
  type MorphoMarketParams,
} from '../encoding/calldata.js';
import type { EnforcementVariant, ExecuteParams } from '../types/envelope.js';
import type { LendingProtocol, SwapProtocol } from '../types/protocols.js';
import type {
  BorrowIntent,
  LendIntent,
  LendingAdapter,
  LendingPlan,
  RepayIntent,
  SwapAdapter,
  SwapIntent,
  SwapQuote,
  WithdrawIntent,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Mock adapter set. Each adapter takes a "config" with router/pool addresses
// and a canned predicted-output (so tests can pin the best-route picker).
// In production these are replaced by adapters that call the real DEX quoter
// or protocol-specific math (UniswapV3 quoterV2, Aerodrome SugarOracle, Curve
// `get_dy`, Morpho `expectedSupplyAssets`, Aave reserve data, etc).
// ──────────────────────────────────────────────────────────────────────────────

type Common = {
  vault: Address;
  recipient: Address;
};

const MAX_UINT160 = (1n << 160n) - 1n;

const intentHashFor = (kind: string, parts: readonly bigint[]): Hex => {
  // Deterministic mock intent hash so tests get stable calldata fixtures.
  const seed = `${kind}:${parts.map((p) => p.toString()).join(',')}`;
  return keccak256(toHex(seed));
};

const applySlippage = (predicted: bigint, slippageBps: bigint, floor: bigint): bigint => {
  if (slippageBps < 0n || slippageBps > 10_000n) {
    throw new Error(`mock adapter: slippageBps out of range: ${slippageBps}`);
  }
  const afterSlip = (predicted * (10_000n - slippageBps)) / 10_000n;
  return afterSlip > floor ? afterSlip : floor;
};

// ── Swap adapters ─────────────────────────────────────────────────────────────

export type UniswapV3MockConfig = Common & {
  router: Address;
  feeTier: bigint;
  predictedOut: (i: SwapIntent) => bigint;
};

export const mockUniswapV3Adapter = (cfg: UniswapV3MockConfig): SwapAdapter => ({
  protocol: 'uniswap_v3',
  quote: async (intent) => {
    const predicted = cfg.predictedOut(intent);
    const minOut = applySlippage(predicted, intent.slippageBps ?? 50n, intent.minOut);
    const data = encodeUniswapV3ExactInputSingle({
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      fee: Number(cfg.feeTier),
      recipient: cfg.recipient,
      deadline: intent.deadline,
      amountIn: intent.amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    });
    const minOutputPerInput =
      intent.amountIn === 0n ? 0n : (minOut * 10n ** 18n) / intent.amountIn;
    const enforcement: EnforcementVariant = {
      kind: 'uniswap_v3_swap',
      enforcement: {
        feeTier: cfg.feeTier,
        maxSingleAmountIn: intent.amountIn,
        maxTotalAmountIn: intent.amountIn,
        maxValue: 0n,
        minOutputPerInput,
        router: cfg.router,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        sqrtPriceLimitX96: 0n,
      },
    };
    const execute: ExecuteParams = {
      target: cfg.router,
      data,
      value: 0n,
      minOutput: minOut,
      outputToken: intent.tokenOut,
      intentHash: intentHashFor('uniswap_v3', [intent.amountIn, minOut, intent.deadline]),
      deadline: intent.deadline,
    };
    const out: SwapQuote = { protocol: 'uniswap_v3', amountOut: predicted, execute, enforcement };
    return out;
  },
});

export type PancakeV3MockConfig = UniswapV3MockConfig;

export const mockPancakeswapV3Adapter = (cfg: PancakeV3MockConfig): SwapAdapter => {
  const inner = mockUniswapV3Adapter(cfg);
  return {
    protocol: 'pancakeswap_v3',
    quote: async (intent) => {
      const q = await inner.quote(intent);
      if (!q) return null;
      // Re-tag protocol + enforcement variant.
      const data = encodePancakeswapV3ExactInputSingle({
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        fee: Number(cfg.feeTier),
        recipient: cfg.recipient,
        deadline: intent.deadline,
        amountIn: intent.amountIn,
        amountOutMinimum: q.execute.minOutput,
        sqrtPriceLimitX96: 0n,
      });
      const minOutputPerInput =
        intent.amountIn === 0n ? 0n : (q.execute.minOutput * 10n ** 18n) / intent.amountIn;
      const enforcement: EnforcementVariant = {
        kind: 'pancakeswap_v3_swap',
        enforcement: {
          feeTier: cfg.feeTier,
          maxSingleAmountIn: intent.amountIn,
          maxTotalAmountIn: intent.amountIn,
          maxValue: 0n,
          minOutputPerInput,
          router: cfg.router,
          tokenIn: intent.tokenIn,
          tokenOut: intent.tokenOut,
          sqrtPriceLimitX96: 0n,
        },
      };
      return {
        protocol: 'pancakeswap_v3',
        amountOut: q.amountOut,
        execute: { ...q.execute, data, intentHash: intentHashFor('pancake_v3', [intent.amountIn, q.execute.minOutput, intent.deadline]) },
        enforcement,
      };
    },
  };
};

export type AerodromeMockConfig = Common & {
  router: Address;
  tickSpacing: bigint;
  predictedOut: (i: SwapIntent) => bigint;
};

export const mockAerodromeAdapter = (cfg: AerodromeMockConfig): SwapAdapter => ({
  protocol: 'aerodrome',
  quote: async (intent) => {
    const predicted = cfg.predictedOut(intent);
    const minOut = applySlippage(predicted, intent.slippageBps ?? 50n, intent.minOut);
    const data = encodeAerodromeExactInputSingle({
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      tickSpacing: Number(cfg.tickSpacing),
      recipient: cfg.recipient,
      deadline: intent.deadline,
      amountIn: intent.amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    });
    const minOutputPerInput =
      intent.amountIn === 0n ? 0n : (minOut * 10n ** 18n) / intent.amountIn;
    const enforcement: EnforcementVariant = {
      kind: 'aerodrome_swap',
      enforcement: {
        maxSingleAmountIn: intent.amountIn,
        maxTotalAmountIn: intent.amountIn,
        maxValue: 0n,
        minOutputPerInput,
        router: cfg.router,
        tickSpacing: cfg.tickSpacing,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        sqrtPriceLimitX96: 0n,
      },
    };
    const execute: ExecuteParams = {
      target: cfg.router,
      data,
      value: 0n,
      minOutput: minOut,
      outputToken: intent.tokenOut,
      intentHash: intentHashFor('aerodrome', [intent.amountIn, minOut, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'aerodrome', amountOut: predicted, execute, enforcement };
  },
});

export type CurveMockConfig = Common & {
  pool: Address;
  i: bigint;
  j: bigint;
  predictedOut: (i: SwapIntent) => bigint;
};

export const mockCurveAdapter = (cfg: CurveMockConfig): SwapAdapter => ({
  protocol: 'curve',
  quote: async (intent) => {
    const predicted = cfg.predictedOut(intent);
    const minOut = applySlippage(predicted, intent.slippageBps ?? 50n, intent.minOut);
    const data = encodeCurveExchange(cfg.i, cfg.j, intent.amountIn, minOut);
    const minOutputPerInput =
      intent.amountIn === 0n ? 0n : (minOut * 10n ** 18n) / intent.amountIn;
    const enforcement: EnforcementVariant = {
      kind: 'curve_stable_swap',
      enforcement: {
        i: cfg.i,
        j: cfg.j,
        maxSingleAmountIn: intent.amountIn,
        maxTotalAmountIn: intent.amountIn,
        maxValue: 0n,
        minOutputPerInput,
        pool: cfg.pool,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
      },
    };
    const execute: ExecuteParams = {
      target: cfg.pool,
      data,
      value: 0n,
      minOutput: minOut,
      outputToken: intent.tokenOut,
      intentHash: intentHashFor('curve', [intent.amountIn, minOut, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'curve', amountOut: predicted, execute, enforcement };
  },
});

// Note: a uniswap_v4 mock is intentionally omitted from the default route set
// because V4 calldata builds through Universal Router 2.0 with a multi-step
// commands buffer; the inner UR encoder is non-trivial and lives behind the
// real adapter implementation. The SDK still exports the v4 Envelope types
// so a custom v4 adapter can be registered.

// ── Lending adapters ──────────────────────────────────────────────────────────

export type AaveAdapterConfig = {
  vault: Address;
  pool: Address;
  /**
   * Map of (asset → debtToken) used by repay enforcement. In production this
   * is read from the Aave pool's `getReserveData(asset)` view.
   */
  debtTokens?: Record<Address, Address>;
};

export const mockAaveAdapter = (cfg: AaveAdapterConfig): LendingAdapter => {
  const vault = cfg.vault;
  const pool = cfg.pool;

  const supply: LendingAdapter['supply'] = async (intent) => {
    if (intent.protocol !== 'aave') return null;
    const data = encodeAaveSupply(intent.asset, intent.amount, vault);
    const enforcement: EnforcementVariant = {
      kind: 'aave_supply',
      enforcement: {
        asset: intent.asset,
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        pool,
      },
    };
    const execute: ExecuteParams = {
      target: pool,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('aave_supply', [intent.amount, intent.deadline]),
      deadline: intent.deadline,
    };
    const out: LendingPlan = { protocol: 'aave', execute, enforcement };
    return out;
  };

  const withdraw: LendingAdapter['withdraw'] = async (intent) => {
    if (intent.protocol !== 'aave') return null;
    const data = encodeAaveWithdraw(intent.asset, intent.amount, vault);
    const enforcement: EnforcementVariant = {
      kind: 'aave_withdraw',
      enforcement: {
        asset: intent.asset,
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        minHealthFactor: intent.minHealthFactor,
        pool,
      },
    };
    const execute: ExecuteParams = {
      target: pool,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('aave_withdraw', [intent.amount, intent.minHealthFactor, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'aave', execute, enforcement };
  };

  const borrow: LendingAdapter['borrow'] = async (intent) => {
    if (intent.protocol !== 'aave') return null;
    const data = encodeAaveBorrow(intent.asset, intent.amount, 2n, vault);
    const enforcement: EnforcementVariant = {
      kind: 'aave_borrow',
      enforcement: {
        asset: intent.asset,
        interestRateMode: 2n,
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        minHealthFactor: intent.minHealthFactor,
        pool,
      },
    };
    const execute: ExecuteParams = {
      target: pool,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('aave_borrow', [intent.amount, intent.minHealthFactor, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'aave', execute, enforcement };
  };

  const repay: LendingAdapter['repay'] = async (intent) => {
    if (intent.protocol !== 'aave') return null;
    const debtToken = cfg.debtTokens?.[intent.asset] ?? intent.debtToken;
    const data = encodeAaveRepay(intent.asset, intent.amount, 2n, vault);
    const enforcement: EnforcementVariant = {
      kind: 'aave_repay',
      enforcement: {
        asset: intent.asset,
        debtToken,
        interestRateMode: 2n,
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        pool,
      },
    };
    const execute: ExecuteParams = {
      target: pool,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('aave_repay', [intent.amount, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'aave', execute, enforcement };
  };

  return { protocol: 'aave', supply, withdraw, borrow, repay };
};

export type MorphoAdapterConfig = {
  vault: Address;
  morpho: Address;
  marketId: Hex;
  market: MorphoMarketParams;
};

export const mockMorphoAdapter = (cfg: MorphoAdapterConfig): LendingAdapter => {
  const vault = cfg.vault;
  const morpho = cfg.morpho;
  const marketId = cfg.marketId;

  const supply: LendingAdapter['supply'] = async (intent) => {
    if (intent.protocol !== 'morpho') return null;
    const data = encodeMorphoSupply(cfg.market, intent.amount, vault);
    const enforcement: EnforcementVariant = {
      kind: 'morpho_supply',
      enforcement: {
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        marketId,
        morpho,
      },
    };
    const execute: ExecuteParams = {
      target: morpho,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('morpho_supply', [intent.amount, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'morpho', execute, enforcement };
  };

  const withdraw: LendingAdapter['withdraw'] = async (intent) => {
    if (intent.protocol !== 'morpho') return null;
    const data = encodeMorphoWithdraw(cfg.market, intent.amount, vault, vault);
    const enforcement: EnforcementVariant = {
      kind: 'morpho_withdraw',
      enforcement: {
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        marketId,
        minCollateralRatio: intent.minHealthFactor,
        morpho,
      },
    };
    const execute: ExecuteParams = {
      target: morpho,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('morpho_withdraw', [intent.amount, intent.minHealthFactor, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'morpho', execute, enforcement };
  };

  const borrow: LendingAdapter['borrow'] = async (intent) => {
    if (intent.protocol !== 'morpho') return null;
    const data = encodeMorphoBorrow(cfg.market, intent.amount, vault, vault);
    const enforcement: EnforcementVariant = {
      kind: 'morpho_borrow',
      enforcement: {
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        marketId,
        minCollateralRatio: intent.minHealthFactor,
        morpho,
      },
    };
    const execute: ExecuteParams = {
      target: morpho,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('morpho_borrow', [intent.amount, intent.minHealthFactor, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'morpho', execute, enforcement };
  };

  const repay: LendingAdapter['repay'] = async (intent) => {
    if (intent.protocol !== 'morpho') return null;
    const data = encodeMorphoRepay(cfg.market, intent.amount, vault);
    const enforcement: EnforcementVariant = {
      kind: 'morpho_repay',
      enforcement: {
        maxSingleAmount: intent.amount,
        maxTotalAmount: intent.amount,
        maxValue: 0n,
        marketId,
        morpho,
      },
    };
    const execute: ExecuteParams = {
      target: morpho,
      data,
      value: 0n,
      minOutput: intent.amount,
      outputToken: intent.asset,
      intentHash: intentHashFor('morpho_repay', [intent.amount, intent.deadline]),
      deadline: intent.deadline,
    };
    return { protocol: 'morpho', execute, enforcement };
  };

  return { protocol: 'morpho', supply, withdraw, borrow, repay };
};

// Re-export a tiny utility so consumers that build their own adapters still
// get the SDK's intent-hashing helper.
export { intentHashFor as deriveIntentHash };

// keep these re-exports so end users can ship their own adapters without
// importing from deep paths.
export type { LendingProtocol, SwapProtocol } from '../types/protocols.js';
