export const SERVICE_BLOCK_TIME_SECONDS = 12;

export function computeServiceLifetimeSeconds(ttlBlocks: number): number | null {
  if (!Number.isFinite(ttlBlocks) || ttlBlocks <= 0) return null;
  return ttlBlocks * SERVICE_BLOCK_TIME_SECONDS;
}

export function computeServiceRemainingSeconds(
  createdAtSeconds: number,
  ttlBlocks: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | null {
  const lifetimeSeconds = computeServiceLifetimeSeconds(ttlBlocks);
  if (lifetimeSeconds == null) return null;
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return null;

  return Math.max(0, createdAtSeconds + lifetimeSeconds - nowSeconds);
}
