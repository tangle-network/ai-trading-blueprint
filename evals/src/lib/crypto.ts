import { createHash } from 'node:crypto'

export function sha256(value: unknown): `sha256:${string}` {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `sha256:${createHash('sha256').update(text ?? '').digest('hex')}`
}
