import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runLocalProductE2E } from '../product/local-stack-runner.js'

const outputArg = valueAfter('--out')
const outputPath = outputArg
  ? resolve(process.cwd(), outputArg)
  : undefined

const options: Parameters<typeof runLocalProductE2E>[0] = {
  startStack: !process.argv.includes('--no-start-stack'),
  keepStack: process.argv.includes('--keep-stack'),
}
const baseUrl = valueAfter('--base-url')
if (baseUrl) options.baseUrl = baseUrl
const operatorUrl = valueAfter('--operator-url')
if (operatorUrl) options.operatorUrl = operatorUrl
if (outputPath) options.outputPath = outputPath
const outputDir = valueAfter('--output-dir')
if (outputDir) options.outputDir = outputDir
const maxTurns = numberAfter('--max-turns')
if (maxTurns !== undefined) options.maxTurns = maxTurns

const report = await runLocalProductE2E(options)

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

console.log(JSON.stringify({
  suite: report.suite,
  base_url: report.base_url,
  operator_url: report.operator_url,
  output_dir: report.output_dir,
  assertions: report.assertions,
  browser: {
    total: report.browser.total,
    passed: report.browser.passed,
    failed: report.browser.failed,
    llm: report.browser.bad?.llm,
  },
}, null, 2))

if (report.assertions.some((assertion) => !assertion.passed) || report.browser.failed > 0) {
  process.exit(1)
}

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
