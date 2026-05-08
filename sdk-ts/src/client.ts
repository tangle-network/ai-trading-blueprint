import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  hashApprovalSigners,
  hashEnforcement,
  hashEnvelope,
} from './encoding/enforcementHash.js';
import type {
  EnforcementVariant,
  Envelope,
  ExecuteParams,
  HealthFactorParams,
  DebtReductionParams,
} from './types/envelope.js';
import type { LendingProtocol } from './types/protocols.js';
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
} from './adapters/types.js';
import {
  RAW_API,
  type PreparedTx,
  type RawApi,
  executeAaveBorrowEnvelope,
  executeAaveRepayEnvelope,
  executeAaveSupplyEnvelope,
  executeAaveWithdrawEnvelope,
  executeAerodromeSwapEnvelope,
  executeCurveStableSwapEnvelope,
  executeMorphoBorrowEnvelope,
  executeMorphoRepayEnvelope,
  executeMorphoSupplyEnvelope,
  executeMorphoWithdrawEnvelope,
  executePancakeswapV3SwapEnvelope,
  executeUniswapV3SwapEnvelope,
  executeUniswapV4SwapEnvelope,
} from './raw.js';
import type { ValidatorClient, ValidatorRequest, ValidatorSignature } from './validator/types.js';

// Re-export PreparedTx so consumers don't have to deep-import.
export type { PreparedTx };

const PROTOCOL_HASH_SWAP = keccak256(toHex('swap'));
const PROTOCOL_HASH_AAVE = keccak256(toHex('aave_v3'));
const PROTOCOL_HASH_MORPHO = keccak256(toHex('morpho'));

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);
const ENVELOPE_DOMAIN_NAME_HASH = keccak256(toHex('TradingEnvelope'));
const ENVELOPE_DOMAIN_VERSION_HASH = keccak256(toHex('2'));

const envelopeDomainSeparator = (chainId: bigint, verifyingContract: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        ENVELOPE_DOMAIN_NAME_HASH,
        ENVELOPE_DOMAIN_VERSION_HASH,
        chainId,
        verifyingContract,
      ],
    ),
  );

const envelopeDigest = (env: Envelope, validator: Address): Hex => {
  const domain = envelopeDomainSeparator(env.chainId, validator);
  const struct = hashEnvelope(env);
  // 0x1901 || domainSeparator || structHash
  const packed: Hex = `0x1901${domain.slice(2)}${struct.slice(2)}`;
  return keccak256(packed);
};

// ──────────────────────────────────────────────────────────────────────────────
// Vault client
// ──────────────────────────────────────────────────────────────────────────────

export type VaultClientConfig = {
  /** RPC URL — held by the SDK so future versions can call view-only helpers. */
  rpcUrl: string;
  chainId: bigint;
  /** TradingVault address. */
  vaultAddress: Address;
  /** TradeValidator address — used as the EIP-712 verifyingContract. */
  validatorAddress: Address;
  /** Pluggable validator backend. */
  validatorClient: ValidatorClient;
  /** Bot identifier — hashed into envelope.botIdHash. */
  botId: string;
  /**
   * Sorted approval signer set the SDK commits to in `envelope.signersHash`.
   * Must contain at least `minSignatures` validators.
   */
  approvalSigners: readonly Address[];
  /** Required number of validator signatures (`envelope.minSignatures`). */
  minSignatures: bigint;
  /**
   * Optional starting nonce. If unset, the SDK generates monotonic nonces from
   * `Date.now()` so two PreparedTx in flight don't collide on `signersHash`
   * + `nonce` replay protection. For production use a `NonceCoordinator` that
   * reads from on-chain `envelopeConsumedAmount`.
   */
  nonceProvider?: () => bigint;
  /** Default expiry window in seconds (envelope.expiresAt = now + window). */
  defaultExpiryWindowSecs?: bigint;
  /** Swap-quote adapters to fan out to. */
  swapAdapters?: readonly SwapAdapter[];
  /** Lending adapters keyed by protocol. */
  lendingAdapters?: Partial<Record<LendingProtocol, LendingAdapter>>;
};

export type SwapArgs = SwapIntent;
export type LendArgs = LendIntent;
export type WithdrawArgs = WithdrawIntent;
export type BorrowArgs = BorrowIntent;
export type RepayArgs = RepayIntent;

export type VaultClient = {
  swap: (args: SwapArgs) => Promise<PreparedTx>;
  lend: (args: LendArgs) => Promise<PreparedTx>;
  withdraw: (args: WithdrawArgs) => Promise<PreparedTx>;
  borrow: (args: BorrowArgs) => Promise<PreparedTx>;
  repay: (args: RepayArgs) => Promise<PreparedTx>;
  /** Low-level escape hatch — bypass routing & call any envelope-execute fn directly. */
  raw: RawApi;
  /** Surfaces inert helpers that callers occasionally need (debugging, simulation). */
  utils: {
    hashEnvelope: typeof hashEnvelope;
    hashEnforcement: typeof hashEnforcement;
    envelopeDigest: typeof envelopeDigest;
  };
};

const protocolHashFor = (variant: EnforcementVariant): Hex => {
  switch (variant.kind) {
    case 'uniswap_v3_swap':
    case 'uniswap_v4_swap':
    case 'aerodrome_swap':
    case 'pancakeswap_v3_swap':
    case 'curve_stable_swap':
      return PROTOCOL_HASH_SWAP;
    case 'aave_supply':
    case 'aave_withdraw':
    case 'aave_borrow':
    case 'aave_repay':
      return PROTOCOL_HASH_AAVE;
    case 'morpho_supply':
    case 'morpho_withdraw':
    case 'morpho_borrow':
    case 'morpho_repay':
      return PROTOCOL_HASH_MORPHO;
  }
};

const monotonicCounter = (): (() => bigint) => {
  let last = 0n;
  return () => {
    const candidate = BigInt(Date.now());
    last = candidate > last ? candidate : last + 1n;
    return last;
  };
};

const buildEnvelope = (cfg: VaultClientConfig, variant: EnforcementVariant, nonce: bigint, deadline: bigint): Envelope => {
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const expiryWindow = cfg.defaultExpiryWindowSecs ?? 300n;
  const expiresAt = issuedAt + expiryWindow;
  // The on-chain executor checks `params.deadline < block.timestamp` (revert)
  // and `block.timestamp > env.expiresAt` (revert) — so both must be in the
  // future when the tx lands. We pin `expiresAt = max(deadline, issuedAt+window)`
  // to keep the envelope alive at least as long as the deadline allows.
  const env: Envelope = {
    version: 2n,
    botIdHash: keccak256(toHex(cfg.botId)),
    vault: cfg.vaultAddress,
    chainId: cfg.chainId,
    protocolHash: protocolHashFor(variant),
    policyHash: keccak256(toHex('default')),
    enforcementHash: hashEnforcement(variant),
    issuedAt,
    expiresAt: deadline > expiresAt ? deadline : expiresAt,
    nonce,
    signersHash: hashApprovalSigners(cfg.approvalSigners),
    minSignatures: cfg.minSignatures,
  };
  return env;
};

const requireEnoughSignatures = (
  signatures: readonly ValidatorSignature[],
  minSignatures: bigint,
): void => {
  if (BigInt(signatures.length) < minSignatures) {
    throw new Error(
      `validator client returned ${signatures.length} signatures; envelope requires ${minSignatures}`,
    );
  }
};

const collectSignatures = async (
  client: ValidatorClient,
  envelope: Envelope,
  validatorAddress: Address,
  approvalSigners: readonly Address[],
): Promise<ValidatorSignature[]> => {
  const digest = envelopeDigest(envelope, validatorAddress);
  const req: ValidatorRequest = { envelope, envelopeDigest: digest, approvalSigners };
  const sigs = await client.requestSignatures(req);
  requireEnoughSignatures(sigs, envelope.minSignatures);
  return sigs;
};

const pickBestSwapQuote = (quotes: readonly (SwapQuote | null)[]): SwapQuote => {
  const valid = quotes.filter((q): q is SwapQuote => q !== null);
  if (valid.length === 0) {
    throw new Error('no swap adapter returned a quote for the given pair');
  }
  // Gas-adjust: subtract `gasEstimate` from `amountOut` (units must align —
  // adapters returning a non-zero gasEstimate are responsible for unit-matching).
  // If gasEstimate is unset, treat as 0.
  let best = valid[0]!;
  let bestScore = best.amountOut - (best.gasEstimate ?? 0n);
  for (let i = 1; i < valid.length; i += 1) {
    const candidate = valid[i]!;
    const score = candidate.amountOut - (candidate.gasEstimate ?? 0n);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

const requireLendingAdapter = (
  cfg: VaultClientConfig,
  protocol: LendingProtocol,
): LendingAdapter => {
  const adapter = cfg.lendingAdapters?.[protocol];
  if (!adapter) {
    throw new Error(`no lending adapter registered for protocol "${protocol}"`);
  }
  return adapter;
};

const dispatchSwap = (
  vault: Address,
  envelope: Envelope,
  variant: EnforcementVariant,
  params: ExecuteParams,
  signatures: readonly ValidatorSignature[],
  predictedOutput: bigint,
): PreparedTx => {
  switch (variant.kind) {
    case 'uniswap_v3_swap':
      return executeUniswapV3SwapEnvelope({
        vault,
        params,
        envelope,
        enforcement: variant.enforcement,
        validatorSignatures: signatures,
        predictedOutput,
      });
    case 'uniswap_v4_swap':
      return executeUniswapV4SwapEnvelope({
        vault,
        params,
        envelope,
        enforcement: variant.enforcement,
        validatorSignatures: signatures,
        predictedOutput,
      });
    case 'aerodrome_swap':
      return executeAerodromeSwapEnvelope({
        vault,
        params,
        envelope,
        enforcement: variant.enforcement,
        validatorSignatures: signatures,
        predictedOutput,
      });
    case 'pancakeswap_v3_swap':
      return executePancakeswapV3SwapEnvelope({
        vault,
        params,
        envelope,
        enforcement: variant.enforcement,
        validatorSignatures: signatures,
        predictedOutput,
      });
    case 'curve_stable_swap':
      return executeCurveStableSwapEnvelope({
        vault,
        params,
        envelope,
        enforcement: variant.enforcement,
        validatorSignatures: signatures,
        predictedOutput,
      });
    default:
      throw new Error(`dispatchSwap: enforcement.kind "${variant.kind}" is not a swap variant`);
  }
};

const toHealthFactorParams = (e: ExecuteParams, pool: Address, vault: Address, minHealthFactor: bigint): HealthFactorParams => ({
  target: e.target,
  data: e.data,
  value: e.value,
  minOutput: e.minOutput,
  outputToken: e.outputToken,
  pool,
  account: vault,
  minHealthFactor,
  intentHash: e.intentHash,
  deadline: e.deadline,
});

const toDebtReductionParams = (e: ExecuteParams, debtToken: Address): DebtReductionParams => ({
  target: e.target,
  data: e.data,
  value: e.value,
  inputToken: e.outputToken, // e.outputToken set to repay asset by the adapter
  maxInput: e.minOutput, // adapter sets minOutput = repayment amount cap
  debtToken,
  // The on-chain validator requires `minDebtDecrease > 0`. For Aave/Morpho repays we
  // choose 1 wei as the minimum-debt-decrease floor — actual debt reduction is bounded
  // by `maxInput`; this is purely the "did anything happen" guard.
  minDebtDecrease: 1n,
  intentHash: e.intentHash,
  deadline: e.deadline,
});

export const createVaultClient = (cfg: VaultClientConfig): VaultClient => {
  const nonceProvider = cfg.nonceProvider ?? monotonicCounter();
  const swapAdapters = cfg.swapAdapters ?? [];

  const swap = async (args: SwapArgs): Promise<PreparedTx> => {
    if (swapAdapters.length === 0) {
      throw new Error('createVaultClient: swap requested but no swapAdapters configured');
    }
    const quotes = await Promise.all(swapAdapters.map((a) => a.quote(args)));
    const best = pickBestSwapQuote(quotes);
    const envelope = buildEnvelope(cfg, best.enforcement, nonceProvider(), args.deadline);
    const sigs = await collectSignatures(
      cfg.validatorClient,
      envelope,
      cfg.validatorAddress,
      cfg.approvalSigners,
    );
    return dispatchSwap(cfg.vaultAddress, envelope, best.enforcement, best.execute, sigs, best.amountOut);
  };

  const lend = async (args: LendArgs): Promise<PreparedTx> => {
    const adapter = requireLendingAdapter(cfg, args.protocol);
    const plan = await adapter.supply(args);
    if (!plan) {
      throw new Error(`lending adapter for "${args.protocol}" returned no plan`);
    }
    const envelope = buildEnvelope(cfg, plan.enforcement, nonceProvider(), args.deadline);
    const sigs = await collectSignatures(cfg.validatorClient, envelope, cfg.validatorAddress, cfg.approvalSigners);
    return dispatchSupply(cfg.vaultAddress, envelope, plan, sigs);
  };

  const withdraw = async (args: WithdrawArgs): Promise<PreparedTx> => {
    const adapter = requireLendingAdapter(cfg, args.protocol);
    const plan = await adapter.withdraw(args);
    if (!plan) {
      throw new Error(`lending adapter for "${args.protocol}" returned no withdraw plan`);
    }
    const envelope = buildEnvelope(cfg, plan.enforcement, nonceProvider(), args.deadline);
    const sigs = await collectSignatures(cfg.validatorClient, envelope, cfg.validatorAddress, cfg.approvalSigners);
    return dispatchHealthFactor(cfg.vaultAddress, envelope, plan, sigs, args.minHealthFactor);
  };

  const borrow = async (args: BorrowArgs): Promise<PreparedTx> => {
    const adapter = requireLendingAdapter(cfg, args.protocol);
    const plan = await adapter.borrow(args);
    if (!plan) {
      throw new Error(`lending adapter for "${args.protocol}" returned no borrow plan`);
    }
    const envelope = buildEnvelope(cfg, plan.enforcement, nonceProvider(), args.deadline);
    const sigs = await collectSignatures(cfg.validatorClient, envelope, cfg.validatorAddress, cfg.approvalSigners);
    return dispatchHealthFactor(cfg.vaultAddress, envelope, plan, sigs, args.minHealthFactor);
  };

  const repay = async (args: RepayArgs): Promise<PreparedTx> => {
    const adapter = requireLendingAdapter(cfg, args.protocol);
    const plan = await adapter.repay(args);
    if (!plan) {
      throw new Error(`lending adapter for "${args.protocol}" returned no repay plan`);
    }
    const envelope = buildEnvelope(cfg, plan.enforcement, nonceProvider(), args.deadline);
    const sigs = await collectSignatures(cfg.validatorClient, envelope, cfg.validatorAddress, cfg.approvalSigners);
    return dispatchRepay(cfg.vaultAddress, envelope, plan, sigs, args.debtToken);
  };

  const dispatchSupply = (
    vault: Address,
    envelope: Envelope,
    plan: LendingPlan,
    sigs: readonly ValidatorSignature[],
  ): PreparedTx => {
    if (plan.enforcement.kind === 'aave_supply') {
      return executeAaveSupplyEnvelope({
        vault,
        params: plan.execute,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: plan.execute.minOutput,
      });
    }
    if (plan.enforcement.kind === 'morpho_supply') {
      return executeMorphoSupplyEnvelope({
        vault,
        params: plan.execute,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: plan.execute.minOutput,
      });
    }
    throw new Error(`dispatchSupply: unexpected enforcement kind "${plan.enforcement.kind}"`);
  };

  const dispatchHealthFactor = (
    vault: Address,
    envelope: Envelope,
    plan: LendingPlan,
    sigs: readonly ValidatorSignature[],
    minHealthFactor: bigint,
  ): PreparedTx => {
    if (plan.enforcement.kind === 'aave_withdraw') {
      const params = toHealthFactorParams(plan.execute, plan.enforcement.enforcement.pool, vault, minHealthFactor);
      return executeAaveWithdrawEnvelope({
        vault,
        params,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: params.minOutput,
      });
    }
    if (plan.enforcement.kind === 'aave_borrow') {
      const params = toHealthFactorParams(plan.execute, plan.enforcement.enforcement.pool, vault, minHealthFactor);
      return executeAaveBorrowEnvelope({
        vault,
        params,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: params.minOutput,
      });
    }
    if (plan.enforcement.kind === 'morpho_withdraw') {
      const params = toHealthFactorParams(plan.execute, plan.enforcement.enforcement.morpho, vault, minHealthFactor);
      return executeMorphoWithdrawEnvelope({
        vault,
        params,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: params.minOutput,
      });
    }
    if (plan.enforcement.kind === 'morpho_borrow') {
      const params = toHealthFactorParams(plan.execute, plan.enforcement.enforcement.morpho, vault, minHealthFactor);
      return executeMorphoBorrowEnvelope({
        vault,
        params,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: params.minOutput,
      });
    }
    throw new Error(`dispatchHealthFactor: unexpected enforcement kind "${plan.enforcement.kind}"`);
  };

  const dispatchRepay = (
    vault: Address,
    envelope: Envelope,
    plan: LendingPlan,
    sigs: readonly ValidatorSignature[],
    debtToken: Address,
  ): PreparedTx => {
    if (plan.enforcement.kind === 'aave_repay') {
      const params = toDebtReductionParams(plan.execute, debtToken);
      return executeAaveRepayEnvelope({
        vault,
        params,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: params.maxInput,
      });
    }
    if (plan.enforcement.kind === 'morpho_repay') {
      const params = toDebtReductionParams(plan.execute, debtToken);
      return executeMorphoRepayEnvelope({
        vault,
        params,
        envelope,
        enforcement: plan.enforcement.enforcement,
        validatorSignatures: sigs,
        predictedOutput: params.maxInput,
      });
    }
    throw new Error(`dispatchRepay: unexpected enforcement kind "${plan.enforcement.kind}"`);
  };

  return {
    swap,
    lend,
    withdraw,
    borrow,
    repay,
    raw: RAW_API,
    utils: { hashEnvelope, hashEnforcement, envelopeDigest },
  };
};
