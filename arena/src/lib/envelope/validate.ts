/**
 * Pre-signing validation that mirrors the server-side `EnvelopeError` checks
 * in `trading-runtime/src/envelope/{policy,enforcement,signed}.rs`.
 *
 * Catches misconfiguration in the wallet flow before requesting a signature
 * the contract would reject. Returns a list of human-readable issues; an
 * empty array means the envelope is structurally valid (it may still fail
 * at signature-recovery time on-chain — but it won't fail on shape).
 */

import {
  type EnvelopeEnforcement,
  type SignedEnvelope,
  type TradingPolicy,
  protocolForKind,
} from '~/lib/types/envelope';

export interface EnvelopeValidationIssue {
  field: string;
  message: string;
}

export function validateEnvelopeForSigning(envelope: SignedEnvelope): EnvelopeValidationIssue[] {
  const issues: EnvelopeValidationIssue[] = [];

  if (envelope.version !== 2) {
    issues.push({ field: 'version', message: 'Envelope version must be 2' });
  }
  if (envelope.bot_id.trim().length === 0) {
    issues.push({ field: 'bot_id', message: 'bot_id required' });
  }
  if (envelope.chain_id <= 0) {
    issues.push({ field: 'chain_id', message: 'chain_id must be positive' });
  }
  if (envelope.min_signatures < 1) {
    issues.push({ field: 'min_signatures', message: 'min_signatures must be >= 1' });
  }
  if (envelope.approval_signers.length === 0) {
    issues.push({ field: 'approval_signers', message: 'approval_signers cannot be empty' });
  }
  if (envelope.min_signatures > envelope.approval_signers.length) {
    issues.push({
      field: 'min_signatures',
      message: `min_signatures (${envelope.min_signatures}) exceeds approval_signers count (${envelope.approval_signers.length})`,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  if (envelope.expires_at <= now) {
    issues.push({ field: 'expires_at', message: 'envelope is already expired' });
  }
  if (envelope.expires_at <= envelope.issued_at) {
    issues.push({ field: 'expires_at', message: 'expires_at must be after issued_at' });
  }

  issues.push(...validatePolicy(envelope.policy));

  if (envelope.enforcement) {
    issues.push(...validateEnforcement(envelope.enforcement));
    const enfProtocol = protocolForKind(envelope.enforcement.kind);
    if (envelope.protocol.toLowerCase() !== enfProtocol) {
      issues.push({
        field: 'protocol',
        message: `envelope.protocol (${envelope.protocol}) does not match enforcement protocol (${enfProtocol})`,
      });
    }
  }

  // Protocols that route through the vault require enforcement; direct-API ones don't.
  const vaultRouted = new Set(['uniswap_v3', 'uniswap_v4', 'aerodrome', 'aave_v3', 'morpho']);
  if (vaultRouted.has(envelope.protocol) && !envelope.enforcement) {
    issues.push({
      field: 'enforcement',
      message: `protocol ${envelope.protocol} is vault-routed and requires an enforcement binding`,
    });
  }

  return issues;
}

function validatePolicy(p: TradingPolicy): EnvelopeValidationIssue[] {
  const issues: EnvelopeValidationIssue[] = [];
  if (parseFloat(p.max_trade_size_usd) <= 0) {
    issues.push({ field: 'policy.max_trade_size_usd', message: 'must be > 0' });
  }
  if (parseFloat(p.max_total_exposure_usd) <= 0) {
    issues.push({ field: 'policy.max_total_exposure_usd', message: 'must be > 0' });
  }
  const dd = parseFloat(p.max_drawdown_pct);
  if (!(dd > 0 && dd <= 100)) {
    issues.push({ field: 'policy.max_drawdown_pct', message: 'must be in (0, 100]' });
  }
  if (p.perps) {
    if (p.perps.max_leverage < 1) {
      issues.push({ field: 'policy.perps.max_leverage', message: 'must be >= 1' });
    }
    if (parseFloat(p.perps.min_stop_loss_distance) >= parseFloat(p.perps.max_stop_loss_distance)) {
      issues.push({
        field: 'policy.perps.stop_loss_range',
        message: 'min_stop_loss_distance must be < max_stop_loss_distance',
      });
    }
  }
  return issues;
}

function validateEnforcement(e: EnvelopeEnforcement): EnvelopeValidationIssue[] {
  const issues: EnvelopeValidationIssue[] = [];
  const [single, total] = singleAndTotal(e);
  if (BigInt(single) === 0n) {
    issues.push({ field: 'enforcement.max_single_amount', message: 'must be > 0' });
  }
  if (BigInt(total) === 0n) {
    issues.push({ field: 'enforcement.max_total_amount', message: 'must be > 0' });
  }
  if (BigInt(single) > BigInt(total)) {
    issues.push({
      field: 'enforcement.amounts',
      message: 'max_single_amount must be <= max_total_amount',
    });
  }
  if (e.kind === 'aave_borrow' || e.kind === 'aave_repay') {
    const irm = e.kind === 'aave_borrow' ? e.AaveBorrow.interest_rate_mode : e.AaveRepay.interest_rate_mode;
    if (irm !== 1 && irm !== 2) {
      issues.push({
        field: 'enforcement.interest_rate_mode',
        message: 'Aave interest_rate_mode must be 1 (stable) or 2 (variable)',
      });
    }
  }
  return issues;
}

function singleAndTotal(e: EnvelopeEnforcement): [string, string] {
  switch (e.kind) {
    case 'uniswap_v3_swap':
      return [e.UniswapV3Swap.max_single_amount_in, e.UniswapV3Swap.max_total_amount_in];
    case 'uniswap_v4_swap':
      return [e.UniswapV4Swap.max_single_amount_in, e.UniswapV4Swap.max_total_amount_in];
    case 'aerodrome_swap':
      return [e.AerodromeSwap.max_single_amount_in, e.AerodromeSwap.max_total_amount_in];
    case 'aave_supply':
      return [e.AaveSupply.max_single_amount, e.AaveSupply.max_total_amount];
    case 'aave_withdraw':
      return [e.AaveWithdraw.max_single_amount, e.AaveWithdraw.max_total_amount];
    case 'aave_borrow':
      return [e.AaveBorrow.max_single_amount, e.AaveBorrow.max_total_amount];
    case 'aave_repay':
      return [e.AaveRepay.max_single_amount, e.AaveRepay.max_total_amount];
    case 'morpho_supply':
      return [e.MorphoSupply.max_single_amount, e.MorphoSupply.max_total_amount];
    case 'morpho_withdraw':
      return [e.MorphoWithdraw.max_single_amount, e.MorphoWithdraw.max_total_amount];
    case 'morpho_borrow':
      return [e.MorphoBorrow.max_single_amount, e.MorphoBorrow.max_total_amount];
    case 'morpho_repay':
      return [e.MorphoRepay.max_single_amount, e.MorphoRepay.max_total_amount];
  }
}
