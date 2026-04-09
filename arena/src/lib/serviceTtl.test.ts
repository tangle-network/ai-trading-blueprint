import { describe, expect, it } from 'vitest';
import {
  SERVICE_BLOCK_TIME_SECONDS,
  computeServiceLifetimeSeconds,
  computeServiceRemainingSeconds,
} from './serviceTtl';

describe('service TTL helpers', () => {
  it('converts ttl blocks into seconds', () => {
    expect(computeServiceLifetimeSeconds(100)).toBe(100 * SERVICE_BLOCK_TIME_SECONDS);
  });

  it('computes remaining seconds from created-at timestamp plus ttl blocks', () => {
    const nowSeconds = 10_000;
    const createdAt = nowSeconds - 60;
    const ttlBlocks = 100;

    expect(computeServiceRemainingSeconds(createdAt, ttlBlocks, nowSeconds)).toBe(
      (ttlBlocks * SERVICE_BLOCK_TIME_SECONDS) - 60,
    );
  });

  it('clamps expired services to zero remaining seconds', () => {
    expect(computeServiceRemainingSeconds(1, 1, 10_000)).toBe(0);
  });
});
