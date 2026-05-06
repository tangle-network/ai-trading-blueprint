/**
 * EIP-712 typed data construction matching `TradeValidator.sol` v3.
 *
 * Domain ("TradingEnvelope", "2") deliberately diverges from the contract's
 * own EIP712 inheritance domain ("TradeValidator", "1") so envelope sigs
 * can't be cross-replayed against legacy validator-sig flows.
 *
 * Signing flow:
 *   const typedData = buildEnvelopeTypedData(envelope, chainId, vaultAddress);
 *   const signature = await wagmi.signTypedData(typedData);
 *
 * The recovered signer (when the contract verifies on-chain) will match the
 * connected wallet's address bit-for-bit. There is no off-chain hashing
 * happening in TS — we hand wagmi the structured data and let it follow
 * EIP-712 verbatim.
 */

import {
  type EnvelopeEnforcement,
  type SignedEnvelope,
  type TradingPolicy,
} from '~/lib/types/envelope';

export const ENVELOPE_DOMAIN_NAME = 'TradingEnvelope';
export const ENVELOPE_DOMAIN_VERSION = '2';

export type EnvelopeTypedData = ReturnType<typeof buildEnvelopeTypedData>;

/**
 * Build the EIP-712 typed-data payload for `signTypedData`. The set of types
 * we emit matches every `TYPEHASH` constant in TradeValidator.sol, but only
 * the variant referenced by `envelope.enforcement` is materialized — the
 * primaryType is `Envelope` and `enforcementHash` is computed once and
 * embedded as a `bytes32`. This avoids forcing the wallet to walk a 10-way
 * union it doesn't need.
 */
export function buildEnvelopeTypedData(envelope: SignedEnvelope) {
  return {
    domain: {
      name: ENVELOPE_DOMAIN_NAME,
      version: ENVELOPE_DOMAIN_VERSION,
      chainId: BigInt(envelope.chain_id),
      verifyingContract: envelope.verifying_contract,
    },
    types: ENVELOPE_TYPES,
    primaryType: 'Envelope' as const,
    message: envelopeStruct(envelope),
  };
}

/** Solidity-side types — names, ordering, and casing all match `TradeValidator.sol`. */
const ENVELOPE_TYPES = {
  Envelope: [
    { name: 'version', type: 'uint64' },
    { name: 'botIdHash', type: 'bytes32' },
    { name: 'vault', type: 'address' },
    { name: 'chainId', type: 'uint64' },
    { name: 'protocolHash', type: 'bytes32' },
    { name: 'policyHash', type: 'bytes32' },
    { name: 'enforcementHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'signersHash', type: 'bytes32' },
    { name: 'minSignatures', type: 'uint64' },
  ],
} as const;

function envelopeStruct(envelope: SignedEnvelope) {
  return {
    version: BigInt(envelope.version),
    botIdHash: keccakUtf8(envelope.bot_id),
    vault: envelope.vault_address,
    chainId: BigInt(envelope.chain_id),
    protocolHash: keccakUtf8(envelope.protocol.toLowerCase()),
    policyHash: hashPolicy(envelope.policy),
    enforcementHash: envelope.enforcement
      ? hashEnforcement(envelope.enforcement)
      : ZERO_BYTES32,
    issuedAt: BigInt(envelope.issued_at),
    expiresAt: BigInt(envelope.expires_at),
    nonce: BigInt(envelope.nonce),
    signersHash: hashSortedAddresses(envelope.approval_signers),
    minSignatures: BigInt(envelope.min_signatures),
  };
}

// ── Hashes (computed locally so wallet only sees a flat Envelope struct) ──

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

import { keccak256, toBytes, encodeAbiParameters, type Address, getAddress } from 'viem';

function keccakUtf8(s: string): `0x${string}` {
  return keccak256(toBytes(s));
}

/** Matches `_hashApprovalSigners` in TradeValidator.sol — sorted ascending, raw 20-byte concat. */
function hashSortedAddresses(addrs: ReadonlyArray<`0x${string}`>): `0x${string}` {
  const sorted = [...addrs].map((a) => getAddress(a)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const packed = ('0x' + sorted.map((a) => a.slice(2)).join('')) as `0x${string}`;
  return keccak256(packed);
}

/** Matches `hash_sorted_strings` in policy.rs — sorted, deduped, per-element keccak then outer keccak. */
function hashSortedStrings(values: ReadonlyArray<string>): `0x${string}` {
  const seen = new Set<string>();
  const sorted: string[] = [];
  for (const v of [...values].sort()) {
    if (!seen.has(v)) {
      seen.add(v);
      sorted.push(v);
    }
  }
  const innerHashes = sorted.map((s) => keccak256(toBytes(s)).slice(2)).join('');
  return keccak256(('0x' + innerHashes) as `0x${string}`);
}

const TRADING_POLICY_TYPEHASH = keccakUtf8(
  'TradingPolicy(uint256 canOpenPositions,bytes32 clobPolicy,uint256 maxDrawdownBps,uint256 maxTotalExposureCents,uint256 maxTradeSizeCents,bytes32 perpsPolicy,bytes32 vaultPolicy)',
);
const PERPS_POLICY_TYPEHASH = keccakUtf8(
  'PerpsPolicy(bytes32 allowedAssetsHash,uint256 maxLeverage,uint256 maxStopLossDistanceBps,uint256 minStopLossDistanceBps,uint256 requireStopLoss)',
);
const VAULT_POLICY_TYPEHASH = keccakUtf8(
  'VaultPolicy(bytes32 allowedProtocolsHash,bytes32 allowedTokensInHash,bytes32 allowedTokensOutHash,uint256 maxSlippageBps)',
);
const CLOB_POLICY_TYPEHASH = keccakUtf8(
  'ClobPolicy(bytes32 allowedMarketIdsHash,uint256 maxPositionSizeCents)',
);

/** Decimal string with N decimal places → integer scaled by 10^N. */
function decimalToScaled(decimal: string, decimals: number): bigint {
  const negative = decimal.startsWith('-');
  const stripped = negative ? decimal.slice(1) : decimal;
  const parts = stripped.split('.');
  const intPart = parts[0] ?? '0';
  const fracPart = (parts[1] ?? '').padEnd(decimals, '0').slice(0, decimals);
  const result = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPart);
  return negative ? -result : result;
}

/** Dollars → cents (×100). Matches `decimal_to_cents` in policy.rs. */
function toCents(decimal: string): bigint {
  return decimalToScaled(decimal, 2);
}

/** Pct in [0, 100] → bps (×100). Matches `decimal_pct_to_bps` in policy.rs. */
function pctToBps(decimal: string): bigint {
  return decimalToScaled(decimal, 2);
}

/** Fraction in [0, 1] → bps (×10000). Matches `decimal_fraction_to_bps` in policy.rs. */
function fractionToBps(decimal: string): bigint {
  return decimalToScaled(decimal, 4);
}

function hashPerpsPolicy(p: TradingPolicy['perps']): `0x${string}` {
  if (!p) return ZERO_BYTES32;
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        PERPS_POLICY_TYPEHASH,
        hashSortedStrings(p.allowed_assets),
        BigInt(p.max_leverage),
        fractionToBps(p.max_stop_loss_distance),
        fractionToBps(p.min_stop_loss_distance),
        BigInt(p.require_stop_loss ? 1 : 0),
      ],
    ),
  );
}

function hashVaultPolicy(p: TradingPolicy['vault']): `0x${string}` {
  if (!p) return ZERO_BYTES32;
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [
        VAULT_POLICY_TYPEHASH,
        hashSortedStrings(p.allowed_protocols),
        hashSortedStrings(p.allowed_tokens_in),
        hashSortedStrings(p.allowed_tokens_out),
        BigInt(p.max_slippage_bps),
      ],
    ),
  );
}

function hashClobPolicy(p: TradingPolicy['clob']): `0x${string}` {
  if (!p) return ZERO_BYTES32;
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [CLOB_POLICY_TYPEHASH, hashSortedStrings(p.allowed_market_ids), toCents(p.max_position_size_usd)],
    ),
  );
}

export function hashPolicy(policy: TradingPolicy): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        TRADING_POLICY_TYPEHASH,
        BigInt(policy.can_open_positions ? 1 : 0),
        hashClobPolicy(policy.clob),
        pctToBps(policy.max_drawdown_pct),
        toCents(policy.max_total_exposure_usd),
        toCents(policy.max_trade_size_usd),
        hashPerpsPolicy(policy.perps),
        hashVaultPolicy(policy.vault),
      ],
    ),
  );
}

// ── Per-enforcement hashes ──

const ENFORCEMENT_TYPEHASHES = {
  uniswap_v3_swap: keccakUtf8(
    'UniswapV3SwapEnforcement(uint256 feeTier,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 minOutputPerInput,address router,address tokenIn,address tokenOut)',
  ),
  uniswap_v4_swap: keccakUtf8(
    'UniswapV4SwapEnforcement(address currency0,address currency1,uint256 fee,int256 tickSpacing,address hooks,bool zeroForOne,uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 minOutputPerInput,address universalRouter)',
  ),
  aerodrome_swap: keccakUtf8(
    'AerodromeSwapEnforcement(uint256 maxSingleAmountIn,uint256 maxTotalAmountIn,uint256 minOutputPerInput,address router,int256 tickSpacing,address tokenIn,address tokenOut)',
  ),
  aave_supply: keccakUtf8(
    'AaveSupplyEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,address pool)',
  ),
  aave_withdraw: keccakUtf8(
    'AaveWithdrawEnforcement(address asset,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 minHealthFactor,address pool)',
  ),
  aave_borrow: keccakUtf8(
    'AaveBorrowEnforcement(address asset,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,uint256 minHealthFactor,address pool)',
  ),
  aave_repay: keccakUtf8(
    'AaveRepayEnforcement(address asset,address debtToken,uint256 interestRateMode,uint256 maxSingleAmount,uint256 maxTotalAmount,address pool)',
  ),
  morpho_supply: keccakUtf8(
    'MorphoSupplyEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,address morpho)',
  ),
  morpho_withdraw: keccakUtf8(
    'MorphoWithdrawEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,uint256 minCollateralRatio,address morpho)',
  ),
  morpho_borrow: keccakUtf8(
    'MorphoBorrowEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,uint256 minCollateralRatio,address morpho)',
  ),
  morpho_repay: keccakUtf8(
    'MorphoRepayEnforcement(uint256 maxSingleAmount,uint256 maxTotalAmount,bytes32 marketId,address morpho)',
  ),
} as const;

export function hashEnforcement(e: EnvelopeEnforcement): `0x${string}` {
  switch (e.kind) {
    case 'uniswap_v3_swap': {
      const x = e.UniswapV3Swap;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
            { type: 'address' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.uniswap_v3_swap,
            BigInt(x.fee_tier),
            BigInt(x.max_single_amount_in),
            BigInt(x.max_total_amount_in),
            BigInt(x.min_output_per_input),
            x.router as Address,
            x.token_in as Address,
            x.token_out as Address,
          ],
        ),
      );
    }
    case 'uniswap_v4_swap': {
      const x = e.UniswapV4Swap;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'int256' },
            { type: 'address' },
            { type: 'bool' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.uniswap_v4_swap,
            x.currency0 as Address,
            x.currency1 as Address,
            BigInt(x.fee),
            BigInt(x.tick_spacing),
            x.hooks as Address,
            x.zero_for_one,
            BigInt(x.max_single_amount_in),
            BigInt(x.max_total_amount_in),
            BigInt(x.min_output_per_input),
            x.universal_router as Address,
          ],
        ),
      );
    }
    case 'aerodrome_swap': {
      const x = e.AerodromeSwap;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
            { type: 'int256' },
            { type: 'address' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.aerodrome_swap,
            BigInt(x.max_single_amount_in),
            BigInt(x.max_total_amount_in),
            BigInt(x.min_output_per_input),
            x.router as Address,
            BigInt(x.tick_spacing),
            x.token_in as Address,
            x.token_out as Address,
          ],
        ),
      );
    }
    case 'aave_supply': {
      const x = e.AaveSupply;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.aave_supply,
            x.asset as Address,
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            x.pool as Address,
          ],
        ),
      );
    }
    case 'aave_withdraw': {
      const x = e.AaveWithdraw;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.aave_withdraw,
            x.asset as Address,
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            BigInt(x.min_health_factor),
            x.pool as Address,
          ],
        ),
      );
    }
    case 'aave_borrow': {
      const x = e.AaveBorrow;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.aave_borrow,
            x.asset as Address,
            BigInt(x.interest_rate_mode),
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            BigInt(x.min_health_factor),
            x.pool as Address,
          ],
        ),
      );
    }
    case 'aave_repay': {
      const x = e.AaveRepay;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.aave_repay,
            x.asset as Address,
            x.debt_token as Address,
            BigInt(x.interest_rate_mode),
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            x.pool as Address,
          ],
        ),
      );
    }
    case 'morpho_supply': {
      const x = e.MorphoSupply;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'bytes32' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.morpho_supply,
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            x.market_id,
            x.morpho as Address,
          ],
        ),
      );
    }
    case 'morpho_withdraw': {
      const x = e.MorphoWithdraw;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.morpho_withdraw,
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            x.market_id,
            BigInt(x.min_collateral_ratio),
            x.morpho as Address,
          ],
        ),
      );
    }
    case 'morpho_borrow': {
      const x = e.MorphoBorrow;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.morpho_borrow,
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            x.market_id,
            BigInt(x.min_collateral_ratio),
            x.morpho as Address,
          ],
        ),
      );
    }
    case 'morpho_repay': {
      const x = e.MorphoRepay;
      return keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'bytes32' },
            { type: 'address' },
          ],
          [
            ENFORCEMENT_TYPEHASHES.morpho_repay,
            BigInt(x.max_single_amount),
            BigInt(x.max_total_amount),
            x.market_id,
            x.morpho as Address,
          ],
        ),
      );
    }
  }
}
