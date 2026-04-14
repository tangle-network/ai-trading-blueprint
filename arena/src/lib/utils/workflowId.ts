export function normalizeWorkflowId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return undefined;
}

export function normalizeOptionalWorkflowId(value: unknown): string | null {
  return normalizeWorkflowId(value) ?? null;
}
