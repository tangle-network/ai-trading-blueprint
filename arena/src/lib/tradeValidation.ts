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

export function isExplicitPaperValidationBypass(
  validation?: TradeValidation,
  paperTrade?: boolean,
): boolean {
  return Boolean(
    paperTrade
      && validation
      && validation.responses.length === 1
      && validation.responses[0]?.validator === PAPER_MODE_VALIDATOR,
  );
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
      label: 'BYPASSED',
      badgeVariant: 'secondary',
      helperText: 'Paper mode bypassed validator signing because no validators were configured.',
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
