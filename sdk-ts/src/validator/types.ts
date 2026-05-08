import type { Address, Hex } from 'viem';
import type { Envelope } from '../types/envelope.js';

/**
 * One validator's contribution to an envelope: the EIP-712 signature over the
 * envelope digest (`keccak256(0x1901 || domainSeparator || hashEnvelope(env))`),
 * the validator's public address, and the integrator-supplied quality score.
 *
 * Mirrors `EnvelopeSignature` in `trading-runtime/src/envelope/signed.rs`.
 */
export type ValidatorSignature = {
  signer: Address;
  signature: Hex;
  /** Validator quality score (0-10000); 0 if scoring is disabled for this vault. */
  score: bigint;
};

/**
 * The data an envelope-signing validator needs from the SDK to produce a
 * signature: the envelope itself, plus the on-chain digest (precomputed by
 * the SDK so the validator does not have to re-derive the EIP-712 domain).
 */
export type ValidatorRequest = {
  envelope: Envelope;
  /** Pre-computed `_envelopeDigest(env)` — what the validator MUST sign. */
  envelopeDigest: Hex;
  /** Sorted approval signer set committed to in `envelope.signersHash`. */
  approvalSigners: readonly Address[];
};

/**
 * Pluggable validator backend. The SDK calls `requestSignatures()` once per
 * envelope, then validates the returned aggregate against the envelope's
 * `minSignatures` requirement before producing a `PreparedTx`.
 *
 * Concrete implementations:
 *   - `LocalEcdsaValidatorClient` (in this package, for testing): signs in-process
 *     with private keys.
 *   - `HttpValidatorClient` (planned, follow-up): calls the trading-http-api
 *     `/envelope` endpoint to request signatures from a remote validator set.
 */
export type ValidatorClient = {
  /**
   * Request signatures for the given envelope from the validator backend.
   * The SDK will reject the prepared tx if `signatures.length < env.minSignatures`.
   */
  requestSignatures: (req: ValidatorRequest) => Promise<ValidatorSignature[]>;
};
