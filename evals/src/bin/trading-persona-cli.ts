export function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

export function dollarArg(argv: readonly string[], name: string): number | undefined {
  const present = argv.includes(name)
  const raw = argValue(argv, name)
  if (raw === undefined) {
    if (present) throw new Error(`${name} requires a USD amount`)
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite, non-negative USD amount, got "${raw}"`)
  }
  return value
}
