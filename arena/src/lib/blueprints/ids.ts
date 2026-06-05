export function resolveTradingBlueprintId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '0' ? trimmed : fallback;
}
