import type { Trade, TradeValidation, ValidatorResponseDetail } from '~/lib/types/trade';

const PAPER_MODE_VALIDATOR = 'paper-mode';

export type TradeValidationDisplayState =
  | 'approved_signed'
  | 'rejected'
  | 'paper_bypassed'
  | 'unsigned_error';

export function hasUsableValidatorSignature(signature?: string): boolean {
  if (!signature?.startsWith('0x')) return false;
  const body = signature.slice(2);
  return body.length === 130 && /[1-9a-f]/i.test(body) && /^[0-9a-f]+$/i.test(body);
}

export function countUsableValidatorSignatures(
  responses: ValidatorResponseDetail[] = [],
): number {
  return responses.filter((response) => hasUsableValidatorSignature(response.signature)).length;
}

/**
 * A synthetic response emitted when paper mode skips real validators. Its
 * score (typically 100) is not a validator signal and must not be rendered
 * as one.
 */
export function isPaperBypassResponse(response: ValidatorResponseDetail): boolean {
  return (
    response.validator === PAPER_MODE_VALIDATOR
    || /bypassed/i.test(response.reasoning ?? '')
  );
}

export function isExplicitPaperValidationBypass(
  validation?: TradeValidation,
  paperTrade?: boolean,
): boolean {
  if (!validation || validation.responses.length === 0) return false;
  // Legacy shape: paper trade with the single synthetic paper-mode response.
  if (
    paperTrade
    && validation.responses.length === 1
    && validation.responses[0]?.validator === PAPER_MODE_VALIDATOR
  ) {
    return true;
  }
  // General shape: every response is a synthetic bypass record. A mixed set
  // with at least one real validator is never treated as bypassed.
  return validation.responses.every(isPaperBypassResponse);
}

export function getTradeValidationDisplay(
  trade: Pick<Trade, 'paperTrade' | 'validation'>,
): {
  state: TradeValidationDisplayState;
  label: string;
  badgeVariant: 'success' | 'destructive' | 'secondary' | 'amber';
  helperText?: string;
} | null {
  const validation = trade.validation;
  if (!validation) return null;

  if (!validation.approved) {
    return {
      state: 'rejected',
      label: 'REJECTED',
      badgeVariant: 'destructive',
    };
  }

  if (isExplicitPaperValidationBypass(validation, trade.paperTrade)) {
    return {
      state: 'paper_bypassed',
      label: 'Paper — validation bypassed',
      badgeVariant: 'secondary',
      helperText: 'Paper mode bypassed validator signing; no real validator scored this trade.',
    };
  }

  if (trade.paperTrade && countUsableValidatorSignatures(validation.responses) === 0) {
    return {
      state: 'unsigned_error',
      label: 'UNSIGNED',
      badgeVariant: 'amber',
      helperText: 'Validator scoring passed, but no usable signatures were produced.',
    };
  }

  return {
    state: 'approved_signed',
    label: 'APPROVED',
    badgeVariant: 'success',
  };
}
