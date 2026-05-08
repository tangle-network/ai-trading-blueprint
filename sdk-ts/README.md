# @ai-trading-blueprint/sdk

A typed TypeScript SDK that collapses the `TradingVault` envelope-v3 surface
(13 `execute*Envelope` variants) into a single ergonomic API:

```ts
const tx = await vault.swap({ tokenIn, tokenOut, amountIn, minOut, deadline });
const tx = await vault.lend({ protocol: 'aave', asset, amount, deadline });
const tx = await vault.borrow({ protocol: 'morpho', asset, amount, minHealthFactor, deadline });
```

The SDK takes care of:

- Picking the best swap route across Uniswap V3, Uniswap V4, Aerodrome
  Slipstream, PancakeSwap V3, and Curve StableSwap.
- Routing lend / borrow / repay / withdraw to Aave V3 or Morpho Blue.
- Constructing the matching EIP-712 enforcement struct and hashing it into
  `Envelope.enforcementHash`.
- Coordinating N-of-M validator signatures via a pluggable `ValidatorClient`.
- Producing a `PreparedTx` whose `to`/`data`/`value` you submit via viem,
  wagmi, or any other transport.

## Install

```bash
yarn add @ai-trading-blueprint/sdk viem
```

## Usage

### 1. Swap

```ts
import {
  createVaultClient,
  createLocalValidatorClient,
  mockUniswapV3Adapter,
  mockAerodromeAdapter,
} from '@ai-trading-blueprint/sdk';
import { createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';

const validatorClient = createLocalValidatorClient([
  { privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
]);

const vault = createVaultClient({
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 1n,
  vaultAddress: '0x...vault',
  validatorAddress: '0x...validator',
  validatorClient,
  botId: 'my-bot',
  approvalSigners: ['0x...validatorAddress'],
  minSignatures: 1n,
  swapAdapters: [
    mockUniswapV3Adapter({
      vault: '0x...vault',
      recipient: '0x...vault',
      router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // UniV3 SwapRouter
      feeTier: 500n,
      predictedOut: ({ amountIn }) => (amountIn * 998n) / 1000n,
    }),
    mockAerodromeAdapter({
      vault: '0x...vault',
      recipient: '0x...vault',
      router: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5', // Aerodrome Slipstream
      tickSpacing: 60n,
      predictedOut: ({ amountIn }) => (amountIn * 1001n) / 1000n,
    }),
  ],
});

const tx = await vault.swap({
  tokenIn: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  amountIn: 1_000_000n,
  minOut: 0n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  slippageBps: 50n,
});

// Hand the prepared call to viem to submit.
const wallet = createWalletClient({ chain: mainnet, transport: http() });
await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, account: '0x...operator' });
```

### 2. Lend (Aave / Morpho)

```ts
import {
  createVaultClient,
  createLocalValidatorClient,
  mockAaveAdapter,
  mockMorphoAdapter,
} from '@ai-trading-blueprint/sdk';

const vault = createVaultClient({
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 1n,
  vaultAddress: '0x...vault',
  validatorAddress: '0x...validator',
  validatorClient: createLocalValidatorClient([{ privateKey: '0x...' }]),
  botId: 'my-bot',
  approvalSigners: ['0x...'],
  minSignatures: 1n,
  lendingAdapters: {
    aave: mockAaveAdapter({
      vault: '0x...vault',
      pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3 Pool
    }),
    morpho: mockMorphoAdapter({
      vault: '0x...vault',
      morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', // Morpho Blue
      marketId: '0x...marketId',
      market: {
        loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        collateralToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        oracle: '0x...oracle',
        irm: '0x...irm',
        lltv: 860_000_000_000_000_000n,
      },
    }),
  },
});

const tx = await vault.lend({
  protocol: 'aave',
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: 100_000_000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
});
```

### 3. Borrow

```ts
const tx = await vault.borrow({
  protocol: 'morpho',
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: 10_000_000n,
  minHealthFactor: 1_300_000_000_000_000_000n, // 1.3e18
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
});

// borrow + repay + withdraw share the same shape; just call the matching method.
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          High-level API                                  │
│      vault.swap / vault.lend / vault.borrow / vault.repay / withdraw      │
└──────────────────────────────────────────────────────────────────────────┘
                │                                 │
                ▼                                 ▼
┌──────────────────────────────┐   ┌────────────────────────────────────────┐
│ QuoteAdapter (mockable)      │   │ Envelope construction                  │
│ - SwapAdapter[]              │   │ - hashEnforcement / hashEnvelope       │
│ - LendingAdapter             │   │ - signersHash                          │
│ Best-route picker            │   │ - protocolHash                         │
└──────────────────────────────┘   └────────────────────────────────────────┘
                                                 │
                                                 ▼
                              ┌────────────────────────────────────────────┐
                              │ ValidatorClient (pluggable)                │
                              │ - createLocalValidatorClient (dev)         │
                              │ - HttpValidatorClient (planned)            │
                              └────────────────────────────────────────────┘
                                                 │
                                                 ▼
                              ┌────────────────────────────────────────────┐
                              │ Raw API: 13 execute*Envelope encoders      │
                              │ - vault.raw.executeUniswapV3SwapEnvelope() │
                              │ - vault.raw.executeAaveBorrowEnvelope()    │
                              │ - …                                        │
                              └────────────────────────────────────────────┘
                                                 │
                                                 ▼
                                       PreparedTx { to, data, value, … }
```

## What's mocked vs. real

This is a v0.1 release. Wire-protocol semantics (envelope, EIP-712 hashes,
calldata layout) are pinned to the on-chain `TradingVault` and verified
against the Solidity sources in `contracts/src/`. The pieces that are
**mocked** (and clearly marked):

| Component                | Status   | What it does today                                                                                                  | Replace with                                                                                                                       |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mockUniswapV3Adapter`   | mock     | Returns canned `predictedOut` from a user supplied function; encodes V3 `exactInputSingle` calldata.                | Real adapter that calls UniV3 QuoterV2 (`quoteExactInputSingle`) and encodes the same calldata.                                    |
| `mockAerodromeAdapter`   | mock     | Same shape, encodes Aerodrome Slipstream `exactInputSingle` (int24 tickSpacing).                                    | Real adapter that calls Aerodrome `SugarOracle` / `MixedQuoter`.                                                                   |
| `mockPancakeswapV3Adapter` | mock   | Reuses Uniswap V3 calldata layout (PancakeSwap V3 fork), distinct router.                                            | Real adapter that calls PancakeSwap V3 quoter.                                                                                     |
| `mockCurveAdapter`       | mock     | Encodes `exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)`.                                                 | Real adapter that calls `pool.get_dy(i,j,dx)`.                                                                                     |
| `mockAaveAdapter`        | mock     | Encodes Aave V3 supply/withdraw/borrow/repay calldata; produces matching enforcement structs.                        | Production adapter that reads `getReserveData(asset)` for the live debtToken and amount caps from policy.                          |
| `mockMorphoAdapter`      | mock     | Encodes Morpho Blue supply/withdraw/borrow/repay against a single configured market.                                | Production adapter wired to the Morpho subgraph / `MarketParams` registry.                                                         |
| `createLocalValidatorClient` | dev only | Signs envelope digests in-process with raw private keys.                                                       | `HttpValidatorClient` that calls `trading-http-api` (planned — see follow-ups).                                                    |

The **non-mocked** pieces (load-bearing for envelope correctness):

- All 13 enforcement struct hashes (`src/encoding/enforcementHash.ts`) match
  the on-chain `_hash<X>Enforcement` byte-for-byte.
- `hashEnvelope` matches the on-chain `_hashEnvelope`.
- `hashApprovalSigners` matches `_hashApprovalSigners` (sorted ascending,
  raw 20-byte concat, keccak).
- Calldata encoders (`src/encoding/calldata.ts`) match the on-chain
  `_decode*` decoders' expected shapes.
- `TRADING_VAULT_ABI` is generated from `contracts/out/TradingVault.sol/TradingVault.json`
  (forge build output) and exposes the 13 envelope-execute functions verbatim.

## Building your own adapter

Implement `SwapAdapter` (for swaps) or `LendingAdapter` (for Aave/Morpho-shape
operations) and pass it to `createVaultClient({ swapAdapters: […], lendingAdapters: { … } })`.
The adapter is responsible for:

1. Quoting predicted output.
2. Encoding `params.data` (router calldata) using the helpers in
   `src/encoding/calldata.ts`.
3. Producing a matching `EnforcementVariant` (the SDK hashes it for you).

```ts
import type { SwapAdapter } from '@ai-trading-blueprint/sdk';

const myV3Adapter: SwapAdapter = {
  protocol: 'uniswap_v3',
  quote: async (intent) => {
    const predicted = await callQuoter(intent);
    return {
      protocol: 'uniswap_v3',
      amountOut: predicted,
      execute: { /* params */ },
      enforcement: { kind: 'uniswap_v3_swap', enforcement: { /* … */ } },
    };
  },
};
```

## Power-user escape hatch

If you have a fully-formed envelope and just want to encode the call:

```ts
const tx = vault.raw.executeUniswapV3SwapEnvelope({
  vault: '0x...',
  params: { /* ExecuteParams */ },
  envelope: { /* Envelope */ },
  enforcement: { /* UniswapV3SwapEnforcement */ },
  validatorSignatures: [{ signer, signature, score }],
  predictedOutput: 1_000_000n,
});
```

## Development

```bash
yarn install
yarn build       # tsc → dist/
yarn typecheck   # tsc --noEmit
yarn test        # vitest run
```

## Follow-ups

- **Real DEX quoters** (highest leverage): swap each `mock<Protocol>Adapter`
  for one that calls the live quoter contract. Public surface is unchanged.
- **HTTP-backed `ValidatorClient`**: implement `HttpValidatorClient` that
  hits `PUT /envelope` on `trading-http-api` and waits for the configured
  validator set's signature aggregation.
- **Publish to npm** as `@ai-trading-blueprint/sdk` (currently `private: true`
  and unpublished).
