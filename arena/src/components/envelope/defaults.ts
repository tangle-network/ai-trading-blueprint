/**
 * Default zero-valued enforcement payloads for the builder UI.
 *
 * Each helper returns an `EnvelopeEnforcement` of the requested kind whose
 * fields are valid for the type system but invalid by content (zero
 * addresses, zero amounts, etc.) so the validator surfaces concrete issues
 * the user must fix.
 */

import type {
  EnforcementKind,
  EnvelopeEnforcement,
  SignedEnvelope,
  TradingPolicy,
} from '~/lib/types/envelope';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as `0x${string}`;

export function defaultEnforcementForKind(kind: EnforcementKind): EnvelopeEnforcement {
  switch (kind) {
    case 'uniswap_v3_swap':
      return {
        kind: 'uniswap_v3_swap',
        UniswapV3Swap: {
          router: ZERO_ADDRESS,
          token_in: ZERO_ADDRESS,
          token_out: ZERO_ADDRESS,
          fee_tier: 3000,
          max_single_amount_in: '0',
          max_total_amount_in: '0',
          min_output_per_input: '0',
        },
      };
    case 'uniswap_v4_swap':
      return {
        kind: 'uniswap_v4_swap',
        UniswapV4Swap: {
          currency0: ZERO_ADDRESS,
          currency1: ZERO_ADDRESS,
          fee: 3000,
          tick_spacing: 60,
          hooks: ZERO_ADDRESS,
          zero_for_one: true,
          max_single_amount_in: '0',
          max_total_amount_in: '0',
          min_output_per_input: '0',
          universal_router: ZERO_ADDRESS,
        },
      };
    case 'aerodrome_swap':
      return {
        kind: 'aerodrome_swap',
        AerodromeSwap: {
          router: ZERO_ADDRESS,
          token_in: ZERO_ADDRESS,
          token_out: ZERO_ADDRESS,
          tick_spacing: 1,
          max_single_amount_in: '0',
          max_total_amount_in: '0',
          min_output_per_input: '0',
        },
      };
    case 'aave_supply':
      return {
        kind: 'aave_supply',
        AaveSupply: {
          pool: ZERO_ADDRESS,
          asset: ZERO_ADDRESS,
          max_single_amount: '0',
          max_total_amount: '0',
        },
      };
    case 'aave_withdraw':
      return {
        kind: 'aave_withdraw',
        AaveWithdraw: {
          pool: ZERO_ADDRESS,
          asset: ZERO_ADDRESS,
          max_single_amount: '0',
          max_total_amount: '0',
          min_health_factor: '1000000000000000000',
        },
      };
    case 'aave_borrow':
      return {
        kind: 'aave_borrow',
        AaveBorrow: {
          pool: ZERO_ADDRESS,
          asset: ZERO_ADDRESS,
          interest_rate_mode: 2,
          max_single_amount: '0',
          max_total_amount: '0',
          min_health_factor: '1000000000000000000',
        },
      };
    case 'aave_repay':
      return {
        kind: 'aave_repay',
        AaveRepay: {
          pool: ZERO_ADDRESS,
          asset: ZERO_ADDRESS,
          debt_token: ZERO_ADDRESS,
          interest_rate_mode: 2,
          max_single_amount: '0',
          max_total_amount: '0',
        },
      };
    case 'morpho_supply':
      return {
        kind: 'morpho_supply',
        MorphoSupply: {
          morpho: ZERO_ADDRESS,
          market_id: ZERO_BYTES32,
          max_single_amount: '0',
          max_total_amount: '0',
        },
      };
    case 'morpho_withdraw':
      return {
        kind: 'morpho_withdraw',
        MorphoWithdraw: {
          morpho: ZERO_ADDRESS,
          market_id: ZERO_BYTES32,
          max_single_amount: '0',
          max_total_amount: '0',
          min_collateral_ratio: '1000000000000000000',
        },
      };
    case 'morpho_borrow':
      return {
        kind: 'morpho_borrow',
        MorphoBorrow: {
          morpho: ZERO_ADDRESS,
          market_id: ZERO_BYTES32,
          max_single_amount: '0',
          max_total_amount: '0',
          min_collateral_ratio: '1000000000000000000',
        },
      };
    case 'morpho_repay':
      return {
        kind: 'morpho_repay',
        MorphoRepay: {
          morpho: ZERO_ADDRESS,
          market_id: ZERO_BYTES32,
          max_single_amount: '0',
          max_total_amount: '0',
        },
      };
  }
}

export function defaultPolicy(): TradingPolicy {
  return {
    max_trade_size_usd: '1000',
    max_total_exposure_usd: '5000',
    max_drawdown_pct: '20',
    can_open_positions: true,
  };
}

interface DefaultEnvelopeArgs {
  botId?: string;
  vaultAddress?: `0x${string}`;
  chainId?: number;
  verifyingContract?: `0x${string}`;
}

export function defaultEnvelope(args: DefaultEnvelopeArgs = {}): SignedEnvelope {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 2,
    bot_id: args.botId ?? '',
    vault_address: args.vaultAddress ?? ZERO_ADDRESS,
    chain_id: args.chainId ?? 1,
    protocol: 'uniswap_v3',
    policy: defaultPolicy(),
    approval_signers: [],
    min_signatures: 1,
    issued_at: now,
    expires_at: now + 24 * 3600,
    nonce: 1,
    verifying_contract: args.verifyingContract ?? args.vaultAddress ?? ZERO_ADDRESS,
    enforcement: defaultEnforcementForKind('uniswap_v3_swap'),
    signatures: [],
  };
}

export const ENFORCEMENT_KIND_LABELS: Record<EnforcementKind, string> = {
  uniswap_v3_swap: 'Uniswap V3 Swap',
  uniswap_v4_swap: 'Uniswap V4 Swap',
  aerodrome_swap: 'Aerodrome Swap',
  aave_supply: 'Aave Supply',
  aave_withdraw: 'Aave Withdraw',
  aave_borrow: 'Aave Borrow',
  aave_repay: 'Aave Repay',
  morpho_supply: 'Morpho Supply',
  morpho_withdraw: 'Morpho Withdraw',
  morpho_borrow: 'Morpho Borrow',
  morpho_repay: 'Morpho Repay',
};
