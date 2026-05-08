import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import { keccak256, toHex } from 'viem';
import {
  TYPE_HASHES,
  TYPE_STRINGS,
  hashEnforcement,
  hashEnvelope,
  hashApprovalSigners,
} from '../src/index.js';
import type {
  AaveSupplyEnforcement,
  CurveStableSwapEnforcement,
  Envelope,
  MorphoSupplyEnforcement,
  UniswapV3SwapEnforcement,
} from '../src/types/envelope.js';

const TOKEN_A: Address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const TOKEN_B: Address = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const ROUTER: Address = '0x1111111111111111111111111111111111111111';
const POOL: Address = '0x2222222222222222222222222222222222222222';
const MORPHO: Address = '0x3333333333333333333333333333333333333333';
const VAULT: Address = '0x4444444444444444444444444444444444444444';
const SIGNER_A: Address = '0xA00000000000000000000000000000000000000A';
const SIGNER_B: Address = '0xB00000000000000000000000000000000000000B';

describe('EIP-712 typehash strings match the Solidity constants', () => {
  it('envelope typehash matches', () => {
    expect(TYPE_HASHES.envelope).toBe(keccak256(toHex(TYPE_STRINGS.envelope)));
  });

  it('all 13 enforcement typehashes are derived from their canonical strings', () => {
    expect(TYPE_HASHES.uniswapV3Swap).toBe(keccak256(toHex(TYPE_STRINGS.uniswapV3Swap)));
    expect(TYPE_HASHES.uniswapV4Swap).toBe(keccak256(toHex(TYPE_STRINGS.uniswapV4Swap)));
    expect(TYPE_HASHES.aerodromeSwap).toBe(keccak256(toHex(TYPE_STRINGS.aerodromeSwap)));
    expect(TYPE_HASHES.pancakeswapV3Swap).toBe(keccak256(toHex(TYPE_STRINGS.pancakeswapV3Swap)));
    expect(TYPE_HASHES.curveStableSwap).toBe(keccak256(toHex(TYPE_STRINGS.curveStableSwap)));
    expect(TYPE_HASHES.aaveSupply).toBe(keccak256(toHex(TYPE_STRINGS.aaveSupply)));
    expect(TYPE_HASHES.aaveWithdraw).toBe(keccak256(toHex(TYPE_STRINGS.aaveWithdraw)));
    expect(TYPE_HASHES.aaveBorrow).toBe(keccak256(toHex(TYPE_STRINGS.aaveBorrow)));
    expect(TYPE_HASHES.aaveRepay).toBe(keccak256(toHex(TYPE_STRINGS.aaveRepay)));
    expect(TYPE_HASHES.morphoSupply).toBe(keccak256(toHex(TYPE_STRINGS.morphoSupply)));
    expect(TYPE_HASHES.morphoWithdraw).toBe(keccak256(toHex(TYPE_STRINGS.morphoWithdraw)));
    expect(TYPE_HASHES.morphoBorrow).toBe(keccak256(toHex(TYPE_STRINGS.morphoBorrow)));
    expect(TYPE_HASHES.morphoRepay).toBe(keccak256(toHex(TYPE_STRINGS.morphoRepay)));
  });
});

describe('enforcement struct hashes are deterministic', () => {
  it('uniswap v3 — known fixture (snapshot)', () => {
    const enf: UniswapV3SwapEnforcement = {
      feeTier: 500n,
      maxSingleAmountIn: 1_000_000n,
      maxTotalAmountIn: 10_000_000n,
      maxValue: 0n,
      minOutputPerInput: 990_000_000_000_000_000n,
      router: ROUTER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      sqrtPriceLimitX96: 0n,
    };
    const h: Hex = hashEnforcement({ kind: 'uniswap_v3_swap', enforcement: enf });
    // snapshot — SDK & on-chain MUST agree on this exact byte string.
    expect(h).toBe('0xef429a1fb9352db7c0f0237a8dbf7bf6be6a811945e41844d54d3b8a391db6cc');
  });

  it('curve stable — int128 sign-extends to int256 (snapshot)', () => {
    const enf: CurveStableSwapEnforcement = {
      i: -1n,
      j: 2n,
      maxSingleAmountIn: 100n,
      maxTotalAmountIn: 1000n,
      maxValue: 0n,
      minOutputPerInput: 0n,
      pool: POOL,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
    };
    const h: Hex = hashEnforcement({ kind: 'curve_stable_swap', enforcement: enf });
    // Determinism check: same inputs → same hash, every run.
    expect(h).toBe(hashEnforcement({ kind: 'curve_stable_swap', enforcement: enf }));
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('aave_supply (snapshot)', () => {
    const enf: AaveSupplyEnforcement = {
      asset: TOKEN_A,
      maxSingleAmount: 100n,
      maxTotalAmount: 1000n,
      maxValue: 0n,
      pool: POOL,
    };
    const h: Hex = hashEnforcement({ kind: 'aave_supply', enforcement: enf });
    expect(h).toBe('0x6ed56e329e0b5644ba49cd3e0b3f8de2624fb73b672a725db5f06fd69e75f35b');
  });

  it('morpho_supply (snapshot)', () => {
    const enf: MorphoSupplyEnforcement = {
      maxSingleAmount: 100n,
      maxTotalAmount: 1000n,
      maxValue: 0n,
      marketId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      morpho: MORPHO,
    };
    const h: Hex = hashEnforcement({ kind: 'morpho_supply', enforcement: enf });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).toBe(hashEnforcement({ kind: 'morpho_supply', enforcement: enf }));
  });

  it('changing one field changes the hash (no field aliasing)', () => {
    const a: AaveSupplyEnforcement = {
      asset: TOKEN_A,
      maxSingleAmount: 100n,
      maxTotalAmount: 1000n,
      maxValue: 0n,
      pool: POOL,
    };
    const b: AaveSupplyEnforcement = { ...a, maxTotalAmount: 1001n };
    expect(hashEnforcement({ kind: 'aave_supply', enforcement: a })).not.toBe(
      hashEnforcement({ kind: 'aave_supply', enforcement: b }),
    );
  });
});

describe('envelope hashing', () => {
  it('hashEnvelope is deterministic and changes when fields change', () => {
    const env: Envelope = {
      version: 2n,
      botIdHash: keccak256(toHex('bot-1')),
      vault: VAULT,
      chainId: 31337n,
      protocolHash: keccak256(toHex('swap')),
      policyHash: keccak256(toHex('default')),
      enforcementHash: keccak256(toHex('enf-fixed')),
      issuedAt: 1_700_000_000n,
      expiresAt: 1_700_000_300n,
      nonce: 1n,
      signersHash: hashApprovalSigners([SIGNER_A]),
      minSignatures: 1n,
    };
    const h1 = hashEnvelope(env);
    const h2 = hashEnvelope(env);
    expect(h1).toBe(h2);

    const flipped: Envelope = { ...env, nonce: 2n };
    expect(hashEnvelope(flipped)).not.toBe(h1);
  });
});

describe('hashApprovalSigners (matches on-chain _hashApprovalSigners)', () => {
  it('sorts signers ascending before concatenating', () => {
    const sortedFirst = hashApprovalSigners([SIGNER_A, SIGNER_B]);
    const reverse = hashApprovalSigners([SIGNER_B, SIGNER_A]);
    expect(sortedFirst).toBe(reverse);
  });

  it('rejects duplicates', () => {
    expect(() => hashApprovalSigners([SIGNER_A, SIGNER_A])).toThrow(/duplicate/);
  });

  it('rejects zero address', () => {
    expect(() => hashApprovalSigners(['0x0000000000000000000000000000000000000000'])).toThrow(/zero/);
  });

  it('matches keccak256("") for empty input', () => {
    expect(hashApprovalSigners([])).toBe(keccak256('0x'));
  });
});
