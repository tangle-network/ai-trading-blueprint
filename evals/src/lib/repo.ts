import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export function resolveRepo(...parts: string[]): string {
  return resolve(repoRoot, ...parts)
}

export function isoStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}
