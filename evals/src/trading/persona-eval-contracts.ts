export interface ValidatedCostLimits {
  costCeiling: number
  providerCellCostLimit: number
}

function nonNegativeFiniteDollar(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite, non-negative USD amount, got ${value}`)
  }
  return value
}

export function validateCostLimits(
  costCeiling: number | undefined,
  providerCellCostLimit: number | undefined,
): ValidatedCostLimits | undefined {
  if (costCeiling === undefined && providerCellCostLimit === undefined) return undefined
  if (costCeiling === undefined || providerCellCostLimit === undefined) {
    throw new Error(
      'costCeiling and providerCellCostLimit must be supplied together; the total cap needs a provider-enforced per-cell maximum',
    )
  }
  const total = nonNegativeFiniteDollar(costCeiling, 'costCeiling')
  const perCell = nonNegativeFiniteDollar(providerCellCostLimit, 'providerCellCostLimit')
  if (perCell > total) {
    throw new Error(
      `providerCellCostLimit (${perCell}) cannot exceed costCeiling (${total})`,
    )
  }
  return { costCeiling: total, providerCellCostLimit: perCell }
}

export function deterministicExecutionIdentity(commitSha: string): string {
  const normalized = commitSha.trim().toLowerCase()
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(normalized)) {
    throw new Error(`cannot identify deterministic trading execution from git SHA "${commitSha}"`)
  }
  return `deterministic-trading-runtime@git:${normalized}`
}
