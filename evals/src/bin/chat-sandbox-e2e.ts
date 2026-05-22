import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runChatSandboxE2E } from '../product/chat-sandbox-runner.js'

const outputArg = valueAfter('--out')
const outputPath = outputArg
  ? resolve(process.cwd(), outputArg)
  : undefined

const options: Parameters<typeof runChatSandboxE2E>[0] = {
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
const chatTimeoutMs = numberAfter('--chat-timeout-ms')
if (chatTimeoutMs !== undefined) options.chatTimeoutMs = chatTimeoutMs

const report = await runChatSandboxE2E(options)

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

console.log(JSON.stringify({
  suite: report.suite,
  scenario_id: report.scenario_id,
  output_dir: report.output_dir,
  assertions: report.assertions,
  answers: report.chat_scenario.answers,
}, null, 2))

if (report.assertions.some((assertion) => !assertion.passed)) {
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
