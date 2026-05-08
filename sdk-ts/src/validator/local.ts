import { sign, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { ValidatorClient, ValidatorRequest, ValidatorSignature } from './types.js';

export type LocalValidator = {
  privateKey: Hex;
  /** Quality score (0-10000) the validator emits with each signature. Defaults to 0. */
  score?: bigint;
};

/**
 * In-process validator client backed by raw private keys. Useful for tests,
 * harness scripts, and local-fork wallet flows. NOT for production: real
 * deployments should use an HTTP-backed validator (see follow-up note in
 * README).
 *
 * `requestSignatures` signs the EIP-712 envelope digest with each configured
 * key. The returned list is sorted ascending by signer address to match the
 * on-chain dedup semantics in `_validateEnvelopeWithEnforcementHash`.
 */
export const createLocalValidatorClient = (validators: readonly LocalValidator[]): ValidatorClient => {
  type Entry = { account: ReturnType<typeof privateKeyToAccount>; privateKey: Hex; score: bigint };
  const entries: Entry[] = validators.map((v) => ({
    account: privateKeyToAccount(v.privateKey),
    privateKey: v.privateKey,
    score: v.score ?? 0n,
  }));

  const requestSignatures = async (req: ValidatorRequest): Promise<ValidatorSignature[]> => {
    const out: ValidatorSignature[] = [];
    for (const entry of entries) {
      const signature: Hex = await sign({
        hash: req.envelopeDigest,
        privateKey: entry.privateKey,
        to: 'hex',
      });
      const signer: Address = entry.account.address;
      out.push({ signer, signature, score: entry.score });
    }
    out.sort((a, b) => {
      const av = BigInt(a.signer);
      const bv = BigInt(b.signer);
      if (av === bv) return 0;
      return av < bv ? -1 : 1;
    });
    return out;
  };

  return { requestSignatures };
};
