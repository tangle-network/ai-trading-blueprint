import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import {
  createLocalValidatorClient,
  createVaultClient,
  mockUniswapV3Adapter,
} from '../src/index.js';

// Anvil deterministic test keys (Hardhat default mnemonic) — public, well-known.
const KEYS: readonly Hex[] = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];

const TOKEN_IN: Address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const TOKEN_OUT: Address = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const VAULT: Address = '0x1111111111111111111111111111111111111111';
const VALIDATOR_CONTRACT: Address = '0x2222222222222222222222222222222222222222';
const ROUTER: Address = '0x3333333333333333333333333333333333333333';

describe('validator-signature aggregation', () => {
  it('asks the validator client for sigs and bundles N of them ordered ascending by signer', async () => {
    const validators = KEYS.map((privateKey) => ({ privateKey }));
    const accountAddrs = validators.map((v) => privateKeyToAccount(v.privateKey).address);
    const sortedSigners = [...accountAddrs].sort((a, b) => {
      const av = BigInt(a);
      const bv = BigInt(b);
      if (av === bv) return 0;
      return av < bv ? -1 : 1;
    });

    const validatorClient = createLocalValidatorClient(validators);

    const client = createVaultClient({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337n,
      vaultAddress: VAULT,
      validatorAddress: VALIDATOR_CONTRACT,
      validatorClient,
      botId: 'bot-1',
      approvalSigners: sortedSigners,
      minSignatures: 2n,
      nonceProvider: () => 42n,
      defaultExpiryWindowSecs: 600n,
      swapAdapters: [
        mockUniswapV3Adapter({
          vault: VAULT,
          recipient: VAULT,
          router: ROUTER,
          feeTier: 500n,
          predictedOut: () => 1_000_000n,
        }),
      ],
    });

    const tx = await client.swap({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
      minOut: 900n,
      deadline: 9_999_999_999n,
    });

    expect(tx.validatorSignatures).toHaveLength(KEYS.length);
    expect(tx.validatorSigners).toEqual(sortedSigners);
    // All scores default to 0 unless validator opts in.
    expect(tx.validatorScores).toEqual(new Array(KEYS.length).fill(0n));
  });

  it('throws if the validator backend returns fewer signatures than the envelope requires', async () => {
    const stubValidatorClient = {
      requestSignatures: async () => [],
    };

    const client = createVaultClient({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337n,
      vaultAddress: VAULT,
      validatorAddress: VALIDATOR_CONTRACT,
      validatorClient: stubValidatorClient,
      botId: 'bot-1',
      approvalSigners: [privateKeyToAccount(KEYS[0]!).address],
      minSignatures: 1n,
      nonceProvider: () => 1n,
      swapAdapters: [
        mockUniswapV3Adapter({
          vault: VAULT,
          recipient: VAULT,
          router: ROUTER,
          feeTier: 500n,
          predictedOut: () => 1_000_000n,
        }),
      ],
    });

    await expect(
      client.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000n,
        minOut: 900n,
        deadline: 9_999_999_999n,
      }),
    ).rejects.toThrow(/0 signatures.*requires 1/);
  });
});
