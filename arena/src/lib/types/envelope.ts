/**
 * v3 SignedEnvelope types — mirror trading-runtime/src/envelope/* exactly.
 *
 * Canonical source of truth lives in Rust; this file MUST stay in sync.
 * Field names, ordering, and casing here match the JSON the operator API
 * accepts at `PUT /envelope` (which is `serde_json` of the Rust types).
 */

// ── Discriminated union for on-chain enforcement ──

export type EnvelopeEnforcement =
  | { kind: 'uniswap_v3_swap'; UniswapV3Swap: UniswapV3SwapEnforcement }
  | { kind: 'uniswap_v4_swap'; UniswapV4Swap: UniswapV4SwapEnforcement }
  | { kind: 'aerodrome_swap'; AerodromeSwap: AerodromeSwapEnforcement }
  | { kind: 'aave_supply'; AaveSupply: AaveSupplyEnforcement }
  | { kind: 'aave_withdraw'; AaveWithdraw: AaveWithdrawEnforcement }
  | { kind: 'aave_borrow'; AaveBorrow: AaveBorrowEnforcement }
  | { kind: 'aave_repay'; AaveRepay: AaveRepayEnforcement }
  | { kind: 'morpho_supply'; MorphoSupply: MorphoSupplyEnforcement }
  | { kind: 'morpho_withdraw'; MorphoWithdraw: MorphoWithdrawEnforcement }
  | { kind: 'morpho_borrow'; MorphoBorrow: MorphoBorrowEnforcement }
  | { kind: 'morpho_repay'; MorphoRepay: MorphoRepayEnforcement };

export type EnforcementKind = EnvelopeEnforcement['kind'];

export const ENFORCEMENT_KINDS: ReadonlyArray<EnforcementKind> = [
  'uniswap_v3_swap',
  'uniswap_v4_swap',
  'aerodrome_swap',
  'aave_supply',
  'aave_withdraw',
  'aave_borrow',
  'aave_repay',
  'morpho_supply',
  'morpho_withdraw',
  'morpho_borrow',
  'morpho_repay',
] as const;

/** Maps an enforcement variant to its envelope-level `protocol` field. */
export function protocolForKind(kind: EnforcementKind): string {
  switch (kind) {
    case 'uniswap_v3_swap':
      return 'uniswap_v3';
    case 'uniswap_v4_swap':
      return 'uniswap_v4';
    case 'aerodrome_swap':
      return 'aerodrome';
    case 'aave_supply':
    case 'aave_withdraw':
    case 'aave_borrow':
    case 'aave_repay':
      return 'aave_v3';
    case 'morpho_supply':
    case 'morpho_withdraw':
    case 'morpho_borrow':
    case 'morpho_repay':
      return 'morpho';
  }
}

export function actionForKind(kind: EnforcementKind): string {
  switch (kind) {
    case 'uniswap_v3_swap':
    case 'uniswap_v4_swap':
    case 'aerodrome_swap':
      return 'swap';
    case 'aave_supply':
    case 'morpho_supply':
      return 'supply';
    case 'aave_withdraw':
    case 'morpho_withdraw':
      return 'withdraw';
    case 'aave_borrow':
    case 'morpho_borrow':
      return 'borrow';
    case 'aave_repay':
    case 'morpho_repay':
      return 'repay';
  }
}

// ── Per-protocol enforcement field shapes ──
// All u256 amounts are decimal strings (matches Rust's serde_json U256 output).

export interface UniswapV3SwapEnforcement {
  router: `0x${string}`;
  token_in: `0x${string}`;
  token_out: `0x${string}`;
  fee_tier: number;
  max_single_amount_in: string;
  max_total_amount_in: string;
  min_output_per_input: string;
}

export interface UniswapV4SwapEnforcement {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tick_spacing: number;
  hooks: `0x${string}`;
  zero_for_one: boolean;
  max_single_amount_in: string;
  max_total_amount_in: string;
  min_output_per_input: string;
  universal_router: `0x${string}`;
}

export interface AerodromeSwapEnforcement {
  router: `0x${string}`;
  token_in: `0x${string}`;
  token_out: `0x${string}`;
  tick_spacing: number;
  max_single_amount_in: string;
  max_total_amount_in: string;
  min_output_per_input: string;
}

export interface AaveSupplyEnforcement {
  pool: `0x${string}`;
  asset: `0x${string}`;
  max_single_amount: string;
  max_total_amount: string;
}

export interface AaveWithdrawEnforcement {
  pool: `0x${string}`;
  asset: `0x${string}`;
  max_single_amount: string;
  max_total_amount: string;
  /** 1e18-scaled health factor floor */
  min_health_factor: string;
}

export interface AaveBorrowEnforcement {
  pool: `0x${string}`;
  asset: `0x${string}`;
  /** 1 = stable, 2 = variable */
  interest_rate_mode: 1 | 2;
  max_single_amount: string;
  max_total_amount: string;
  min_health_factor: string;
}

export interface AaveRepayEnforcement {
  pool: `0x${string}`;
  asset: `0x${string}`;
  debt_token: `0x${string}`;
  interest_rate_mode: 1 | 2;
  max_single_amount: string;
  max_total_amount: string;
}

export interface MorphoSupplyEnforcement {
  morpho: `0x${string}`;
  market_id: `0x${string}`;
  max_single_amount: string;
  max_total_amount: string;
}

export interface MorphoWithdrawEnforcement {
  morpho: `0x${string}`;
  market_id: `0x${string}`;
  max_single_amount: string;
  max_total_amount: string;
  min_collateral_ratio: string;
}

export interface MorphoBorrowEnforcement {
  morpho: `0x${string}`;
  market_id: `0x${string}`;
  max_single_amount: string;
  max_total_amount: string;
  min_collateral_ratio: string;
}

export interface MorphoRepayEnforcement {
  morpho: `0x${string}`;
  market_id: `0x${string}`;
  max_single_amount: string;
  max_total_amount: string;
}

// ── Trading policy (universal limits + optional sub-policies) ──

export interface PerpsPolicy {
  allowed_assets: string[];
  max_leverage: number;
  max_stop_loss_distance: string; // Decimal as string
  min_stop_loss_distance: string;
  require_stop_loss: boolean;
}

export interface VaultPolicy {
  allowed_protocols: string[];
  allowed_tokens_in: string[];
  allowed_tokens_out: string[];
  max_slippage_bps: number;
}

export interface ClobPolicy {
  allowed_market_ids: string[];
  max_position_size_usd: string; // Decimal
}

export interface TradingPolicy {
  max_trade_size_usd: string;       // Decimal
  max_total_exposure_usd: string;   // Decimal
  max_drawdown_pct: string;         // Decimal in (0, 100]
  can_open_positions: boolean;
  perps?: PerpsPolicy;
  vault?: VaultPolicy;
  clob?: ClobPolicy;
}

// ── Signed envelope ──

export interface EnvelopeSignature {
  signer: `0x${string}`;
  signature: `0x${string}`;
  /** Validator quality score in 0-10000. */
  score: number;
}

export interface SignedEnvelope {
  /** v3 mandates 2; legacy values are rejected by the server. */
  version: 2;
  bot_id: string;
  vault_address: `0x${string}`;
  chain_id: number;
  protocol: string;
  policy: TradingPolicy;
  approval_signers: `0x${string}`[];
  min_signatures: number;
  issued_at: number;
  expires_at: number;
  nonce: number;
  verifying_contract: `0x${string}`;
  enforcement?: EnvelopeEnforcement;
  signatures: EnvelopeSignature[];
}
