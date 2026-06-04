import { resolve } from 'node:path'

import {
  renderFleetAuditMarkdown,
  runLiveAgentFleetAudit,
} from '../product/live-agent-fleet-audit.js'

const operatorUrl = valueAfter('--operator-url') ?? process.env.TRADING_OPERATOR_API_URL
const token = valueAfter('--token') ?? process.env.TRADING_OPERATOR_SESSION_TOKEN ?? process.env.OPERATOR_SESSION_TOKEN
const privateKey = valueAfter('--private-key') ?? process.env.TRADING_OPERATOR_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY
const outDir = valueAfter('--out-dir') ?? resolve('.evolve', `live-agent-fleet-audit-${stamp()}`)
const limit = numberAfter('--limit')
const concurrency = numberAfter('--concurrency')

const result = await runLiveAgentFleetAudit({
  ...(operatorUrl ? { operatorUrl } : {}),
  ...(token ? { token } : {}),
  ...(privateKey ? { privateKey } : {}),
  outDir,
  ...(limit ? { limit } : {}),
  ...(concurrency ? { concurrency } : {}),
})

if (hasFlag('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(renderFleetAuditMarkdown(result))
  console.error(`wrote ${resolve(outDir, 'fleet-audit.json')}`)
  console.error(`wrote ${resolve(outDir, 'fleet-audit.md')}`)
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

function numberAfter(flag: string): number | undefined {
  const raw = valueAfter(flag)
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
}
