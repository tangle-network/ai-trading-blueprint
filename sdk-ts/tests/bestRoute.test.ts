import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  createVaultClient,
  createLocalValidatorClient,
  mockAerodromeAdapter,
  mockUniswapV3Adapter,
  mockCurveAdapter,
} from '../src/index.js';

const VAULT: Address = '0x1111111111111111111111111111111111111111';
const VALIDATOR: Address = '0x2222222222222222222222222222222222222222';
const TOKEN_IN: Address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const TOKEN_OUT: Address = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const ROUTER_UNI: Address = '0x3333333333333333333333333333333333333333';
const ROUTER_AERO: Address = '0x4444444444444444444444444444444444444444';
const POOL_CURVE: Address = '0x5555555555555555555555555555555555555555';

const VALIDATOR_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// Approvers must match the LocalValidator addresses (same priv key) so the on-chain `signersHash` matches.
const APPROVAL_SIGNER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const baseConfig = (validators = [{ privateKey: VALIDATOR_KEY }]) =>
  ({
    rpcUrl: 'http://localhost:8545',
    chainId: 31337n,
    vaultAddress: VAULT,
    validatorAddress: VALIDATOR,
    validatorClient: createLocalValidatorClient(validators),
    botId: 'test-bot',
    approvalSigners: [APPROVAL_SIGNER] as const,
    minSignatures: 1n,
    nonceProvider: () => 1n,
    defaultExpiryWindowSecs: 600n,
  }) as const;

describe('best-route selection', () => {
  it('picks the swap adapter with the highest predicted output', async () => {
    const client = createVaultClient({
      ...baseConfig(),
      swapAdapters: [
        mockUniswapV3Adapter({
          vault: VAULT,
          recipient: VAULT,
          router: ROUTER_UNI,
          feeTier: 500n,
          predictedOut: () => 980_000n,
        }),
        mockAerodromeAdapter({
          vault: VAULT,
          recipient: VAULT,
          router: ROUTER_AERO,
          tickSpacing: 60n,
          predictedOut: () => 1_010_000n, // best
        }),
        mockCurveAdapter({
          vault: VAULT,
          recipient: VAULT,
          pool: POOL_CURVE,
          i: 0n,
          j: 1n,
          predictedOut: () => 990_000n,
        }),
      ],
    });

    const tx = await client.swap({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
      minOut: 900_000n,
      deadline: 9_999_999_999n,
      slippageBps: 50n,
    });

    expect(tx.predictedOutput).toBe(1_010_000n);
    expect(tx.to).toBe(VAULT);
  });

  it('respects gas-adjusted output when adapters supply gasEstimate', async () => {
    const client = createVaultClient({
      ...baseConfig(),
      swapAdapters: [
        // Higher raw output but penalty-eats it.
        {
          protocol: 'uniswap_v3',
          quote: async () => {
            const q = await mockUniswapV3Adapter({
              vault: VAULT,
              recipient: VAULT,
              router: ROUTER_UNI,
              feeTier: 500n,
              predictedOut: () => 1_000_100n,
            }).quote({
              tokenIn: TOKEN_IN,
              tokenOut: TOKEN_OUT,
              amountIn: 1_000_000n,
              minOut: 900_000n,
              deadline: 9_999_999_999n,
            });
            if (!q) return null;
            return { ...q, gasEstimate: 1_000n };
          },
        },
        mockAerodromeAdapter({
          vault: VAULT,
          recipient: VAULT,
          router: ROUTER_AERO,
          tickSpacing: 60n,
          // raw amountOut = 999_500 ; gasEstimate=0 ; gas-adj = 999_500 vs 1_000_100 - 1_000 = 999_100 → uniswap loses
          predictedOut: () => 999_500n,
        }),
      ],
    });

    const tx = await client.swap({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
      minOut: 900_000n,
      deadline: 9_999_999_999n,
    });

    // Gas-adjusted picker prefers Aerodrome.
    expect(tx.predictedOutput).toBe(999_500n);
  });

  it('throws when no adapter returns a quote', async () => {
    const client = createVaultClient({
      ...baseConfig(),
      swapAdapters: [
        {
          protocol: 'uniswap_v3',
          quote: async () => null,
        },
      ],
    });

    await expect(
      client.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1n,
        minOut: 0n,
        deadline: 9_999_999_999n,
      }),
    ).rejects.toThrow(/no swap adapter/);
  });
});
