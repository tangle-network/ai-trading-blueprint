import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runProductBrowserEval } from '../product/browser-driver.js'

const outputArg = valueAfter('--out')
const reportPath = resolve(process.cwd(), outputArg ?? `.evolve/evals/product-browser-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)

const options: Parameters<typeof runProductBrowserEval>[0] = {
  runBad: process.argv.includes('--run-bad'),
  snapshot: process.argv.includes('--snapshot'),
}
const baseUrl = valueAfter('--base-url')
if (baseUrl) options.baseUrl = baseUrl
const badModel = valueAfter('--bad-model')
if (badModel) options.badModel = badModel
const badBaseUrl = valueAfter('--bad-base-url')
if (badBaseUrl) options.badBaseUrl = badBaseUrl
const badApiKey = valueAfter('--bad-api-key')
if (badApiKey) options.badApiKey = badApiKey
const outputDir = valueAfter('--output-dir')
if (outputDir) options.outputDir = outputDir
const casesPath = valueAfter('--cases')
if (casesPath) options.casesPath = casesPath
const maxTurns = numberAfter('--max-turns')
if (maxTurns !== undefined) options.maxTurns = maxTurns

const report = runProductBrowserEval(options)

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  suite: report.suite,
  mode: report.mode,
  output: reportPath,
  cases: report.cases_path,
  total: report.total,
  passed: report.passed,
  failed: report.failed,
  llm: report.bad?.llm,
}, null, 2))

if (report.failed > 0) process.exit(1)

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

function numberAfter(flag: string): number | undefined {
  const value = valueAfter(flag)
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`)
  return parsed
}
