import { describe, expect, it } from 'vitest';
import { classifyQuoteFailure } from './useQuotes';

describe('classifyQuoteFailure', () => {
  it('classifies HTTP 403 as unauthorized', () => {
    const result = classifyQuoteFailure(Object.assign(new Error('boom'), { status: 403 }));
    expect(result.kind).toBe('unauthorized');
    expect(result.detail).toBe('boom');
  });

  it('classifies permission/allowlist messages as unauthorized', () => {
    expect(classifyQuoteFailure(new Error('RequesterNotAllowed')).kind).toBe('unauthorized');
    expect(classifyQuoteFailure(new Error('requester is not a permitted caller')).kind).toBe('unauthorized');
    expect(classifyQuoteFailure(new Error('not allowed')).kind).toBe('unauthorized');
  });

  it('classifies the Connect permission_denied code as unauthorized', () => {
    expect(classifyQuoteFailure({ code: 7, message: 'denied' }).kind).toBe('unauthorized');
    expect(classifyQuoteFailure({ code: 'permission_denied', message: 'x' }).kind).toBe('unauthorized');
  });

  it('classifies capacity / resource_exhausted as at_capacity', () => {
    expect(classifyQuoteFailure(new Error('operator at capacity')).kind).toBe('at_capacity');
    expect(classifyQuoteFailure({ code: 8, message: 'no slots' }).kind).toBe('at_capacity');
  });

  it('classifies network/transport failures as unreachable', () => {
    expect(classifyQuoteFailure(new Error('Failed to fetch')).kind).toBe('unreachable');
    expect(classifyQuoteFailure(new Error('connection refused')).kind).toBe('unreachable');
    expect(classifyQuoteFailure(new Error('request timed out')).kind).toBe('unreachable');
    expect(classifyQuoteFailure(new Error('No RPC address registered')).kind).toBe('unreachable');
    expect(classifyQuoteFailure({ code: 14, message: 'down' }).kind).toBe('unreachable');
  });

  it('classifies pricing/decode problems as cannot_price', () => {
    expect(classifyQuoteFailure(new Error('No quote details in response')).kind).toBe('cannot_price');
    expect(classifyQuoteFailure(new Error('failed to decode signature')).kind).toBe('cannot_price');
    expect(classifyQuoteFailure(new Error('Unsupported resource kind in quote: FOO')).kind).toBe('cannot_price');
  });

  it('falls through to misconfigured for unrecognized errors', () => {
    const result = classifyQuoteFailure(new Error('some opaque internal error'));
    expect(result.kind).toBe('misconfigured');
    expect(result.detail).toBe('some opaque internal error');
  });

  it('authorization precedence wins over generic transport heuristics', () => {
    // A 403 whose message also contains "connection" must stay unauthorized.
    const result = classifyQuoteFailure(
      Object.assign(new Error('connection rejected: forbidden'), { status: 403 }),
    );
    expect(result.kind).toBe('unauthorized');
  });

  it('handles non-Error inputs', () => {
    expect(classifyQuoteFailure('plain string at capacity').kind).toBe('at_capacity');
    expect(classifyQuoteFailure(null).kind).toBe('misconfigured');
    expect(classifyQuoteFailure(undefined).detail).toBe('undefined');
  });
});
