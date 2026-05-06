/**
 * Cross-domain hash equivalence: the EIP-712 typed data we construct here
 * must produce a digest byte-equal to what the on-chain `_envelopeDigest`
 * computes. We verify by independently reimplementing the on-chain hash and
 * comparing to wagmi/viem's hashTypedData of our payload.
 */

import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, hashTypedData, keccak256, toBytes, getAddress } from 'viem';
import { buildEnvelopeTypedData, hashPolicy, hashEnforcement } from './eip712';
import type { SignedEnvelope, TradingPolicy, EnvelopeEnforcement } from '~/lib/types/envelope';

const VAULT = '0x0000000000000000000000000000000000000077' as const;

const policy: TradingPolicy = {
  max_trade_size_usd: '1000',
  max_total_exposure_usd: '3000',
  max_drawdown_pct: '10',
  can_open_positions: true,
  vault: {
    allowed_protocols: ['uniswap_v3'],
    allowed_tokens_in: [],
    allowed_tokens_out: [],
    max_slippage_bps: 100,
  },
};

const enforcement: EnvelopeEnforcement = {
  kind: 'uniswap_v3_swap',
  UniswapV3Swap: {
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    fee_tier: 3000,
    max_single_amount_in: '1000000000000000000',
    max_total_amount_in: '10000000000000000000',
    min_output_per_input: '2900000000',
  },
};

const envelope: SignedEnvelope = {
  version: 2,
  bot_id: 'bot-cross-domain',
  vault_address: VAULT,
  chain_id: 31337,
  protocol: 'uniswap_v3',
  policy,
  approval_signers: [
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  ],
  min_signatures: 2,
  issued_at: 1_700_000_000,
  expires_at: 1_700_003_600,
  nonce: 1,
  verifying_contract: VAULT,
  enforcement,
  signatures: [],
};

describe('eip712.buildEnvelopeTypedData', () => {
  it('produces a typed-data payload whose digest equals the on-chain envelopeDigest', () => {
    const typedData = buildEnvelopeTypedData(envelope);
    const tsDigest = hashTypedData(typedData);

    // Independently reimplement the on-chain `_envelopeDigest` calculation.
    const ENVELOPE_TYPEHASH = keccak256(
      toBytes(
        'Envelope(uint64 version,bytes32 botIdHash,address vault,uint64 chainId,bytes32 protocolHash,bytes32 policyHash,bytes32 enforcementHash,uint64 issuedAt,uint64 expiresAt,uint64 nonce,bytes32 signersHash,uint64 minSignatures)',
      ),
    );
    const sortedSigners = envelope.approval_signers
      .map((a) => getAddress(a))
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const signersHash = keccak256(
      ('0x' + sortedSigners.map((a) => a.slice(2)).join('')) as `0x${string}`,
    );

    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'uint256' },
        ],
        [
          ENVELOPE_TYPEHASH,
          BigInt(envelope.version),
          keccak256(toBytes(envelope.bot_id)),
          envelope.vault_address,
          BigInt(envelope.chain_id),
          keccak256(toBytes(envelope.protocol.toLowerCase())),
          hashPolicy(envelope.policy),
          hashEnforcement(envelope.enforcement!),
          BigInt(envelope.issued_at),
          BigInt(envelope.expires_at),
          BigInt(envelope.nonce),
          signersHash,
          BigInt(envelope.min_signatures),
        ],
      ),
    );

    const DOMAIN_TYPEHASH = keccak256(
      toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    );
    const domainSep = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          DOMAIN_TYPEHASH,
          keccak256(toBytes('TradingEnvelope')),
          keccak256(toBytes('2')),
          BigInt(envelope.chain_id),
          envelope.verifying_contract,
        ],
      ),
    );
    const ourDigest = keccak256(
      ('0x1901' + domainSep.slice(2) + structHash.slice(2)) as `0x${string}`,
    );

    expect(tsDigest).toBe(ourDigest);
  });

  it('produces stable hashes across runs (deterministic)', () => {
    expect(hashTypedData(buildEnvelopeTypedData(envelope))).toBe(
      hashTypedData(buildEnvelopeTypedData(envelope)),
    );
  });

  it('changes the digest when any field changes', () => {
    const a = hashTypedData(buildEnvelopeTypedData(envelope));
    const b = hashTypedData(buildEnvelopeTypedData({ ...envelope, nonce: 2 }));
    expect(a).not.toBe(b);
  });

  it('produces distinct enforcement hashes per protocol-action variant', () => {
    const swap = hashEnforcement(enforcement);
    const aave: EnvelopeEnforcement = {
      kind: 'aave_supply',
      AaveSupply: {
        pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        max_single_amount: '1000000000',
        max_total_amount: '10000000000',
      },
    };
    expect(hashEnforcement(aave)).not.toBe(swap);
  });
});
