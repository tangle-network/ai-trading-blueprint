import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { repoRoot } from '../lib/repo.js'
import { runLocalProductE2E, type LocalProductE2EContext, type LocalProductE2EReport } from './local-stack-runner.js'

interface ChatCodeStrategyScenario {
  id: string
  title: string
  strategyFile: string
  prompt: string
  requiredTerms: string[]
}

const SCENARIOS: ChatCodeStrategyScenario[] = [
  {
    id: 'evm-mean-reversion',
    title: 'EVM mean-reversion paper strategy',
    strategyFile: '/home/agent/tools/strategies/eval-mean-reversion-chat.js',
    requiredTerms: ['mean', 'reversion', 'risk', 'paper'],
    prompt: [
      'Build a small executable paper strategy module for EVM spot mean reversion.',
      'Write it to /home/agent/tools/strategies/eval-mean-reversion-chat.js.',
      'It must export { id, async tick(ctx) }, use ctx.writeArtifact and ctx.logDecision or ctx.skip, and be runnable with:',
      'node /home/agent/tools/run-strategy.js /home/agent/tools/strategies/eval-mean-reversion-chat.js --mode paper',
      'Keep it paper-only. Include explicit risk limits, a simple signal explanation, and no live key or private-key handling.',
      'After writing it, run the command above and tell me the exact result.',
    ].join('\n'),
  },
  {
    id: 'uniswap-inventory-mm',
    title: 'Uniswap inventory-aware market maker paper strategy',
    strategyFile: '/home/agent/tools/strategies/eval-uniswap-inventory-mm-chat.js',
    requiredTerms: ['inventory', 'market', 'maker', 'spread', 'paper'],
    prompt: [
      'Build a small executable paper strategy module for a Uniswap-style inventory-aware market maker.',
      'Write it to /home/agent/tools/strategies/eval-uniswap-inventory-mm-chat.js.',
      'It must export { id, async tick(ctx) }, produce bid/ask or rebalance intent metadata, use ctx.writeArtifact and ctx.logDecision or ctx.skip, and be runnable with:',
      'node /home/agent/tools/run-strategy.js /home/agent/tools/strategies/eval-uniswap-inventory-mm-chat.js --mode paper',
      'Keep it paper-only. Include inventory skew, max spread/slippage, gas/churn limits, and no live execution promotion.',
      'After writing it, run the command above and tell me the exact result.',
    ].join('\n'),
  },
  {
    id: 'hyperliquid-perp-shadow',
    title: 'Hyperliquid perp shadow strategy',
    strategyFile: '/home/agent/tools/strategies/eval-hyperliquid-perp-shadow-chat.js',
    requiredTerms: ['hyperliquid', 'perp', 'shadow', 'funding', 'paper'],
    prompt: [
      'Build a small executable paper/shadow strategy module for Hyperliquid perps.',
      'Write it to /home/agent/tools/strategies/eval-hyperliquid-perp-shadow-chat.js.',
      'It must export { id, async tick(ctx) }, model a shadow signal without sending orders, use ctx.writeArtifact and ctx.logDecision or ctx.skip, and be runnable with:',
      'node /home/agent/tools/run-strategy.js /home/agent/tools/strategies/eval-hyperliquid-perp-shadow-chat.js --mode paper',
      'Keep it paper-only. Include funding/volatility/position-size gates, explain what blocks live trading, and do not request API keys.',
      'After writing it, run the command above and tell me the exact result.',
    ].join('\n'),
  },
]

export interface ChatCodeStrategyE2EOptions {
  baseUrl?: string
  operatorUrl?: string
  outputPath?: string
  outputDir?: string
  startStack?: boolean
  keepStack?: boolean
  maxTurns?: number
  chatTimeoutMs?: number
  scenarioIds?: string[]
}

export interface ChatCodeStrategyE2EReport {
  suite: 'arena-chat-code-strategy-e2e'
  output_dir: string
  product: LocalProductE2EReport
  scenarios: ChatCodeStrategyScenarioReport[]
  assertions: Array<{ name: string; passed: boolean; detail: string }>
}

export interface ChatCodeStrategyScenarioReport {
  scenario_id: string
  title: string
  bot_id: string
  sandbox_id?: string
  container_name?: string
  session_id?: string
  strategy_file: string
  prompt: string
  transcript: unknown
  sandbox: {
    commands: Record<string, SandboxCommandResult>
  }
  assertions: Array<{ name: string; passed: boolean; detail: string }>
}

interface SandboxCommandResult {
  command: string
  status: number | null
  stdout: string
  stderr: string
}

interface SessionCreateResponse {
  id?: string
  session_id?: string
  session?: { id?: string }
}

interface BotSummaryResponse {
  bots?: Array<{ id?: string; sandbox_id?: string }>
}

export async function runChatCodeStrategyE2E(options: ChatCodeStrategyE2EOptions = {}): Promise<ChatCodeStrategyE2EReport> {
  const selected = selectScenarios(options.scenarioIds)
  let scenarios: ChatCodeStrategyScenarioReport[] = []
  const product = await runLocalProductE2E({
    ...options,
    afterProvision: async (context) => {
      scenarios = await runChatCodeStrategyScenarios(context, selected, options.chatTimeoutMs ?? 420_000)
      return scenarios
    },
  })

  const assertions = [
    ...product.assertions.map((assertion) => ({ ...assertion, name: `product: ${assertion.name}` })),
    ...scenarios.flatMap((scenario) => scenario.assertions.map((assertion) => ({
      ...assertion,
      name: `${scenario.scenario_id}: ${assertion.name}`,
    }))),
  ]
  const report: ChatCodeStrategyE2EReport = {
    suite: 'arena-chat-code-strategy-e2e',
    output_dir: product.output_dir,
    product,
    scenarios,
    assertions,
  }

  const outputPath = resolve(repoRoot, options.outputPath ?? `${product.output_dir}/chat-code-strategy-report.json`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  if (assertions.some((assertion) => !assertion.passed)) {
    throw new Error(`chat-code strategy e2e failed: ${assertions.map((a) => `${a.name}=${a.passed}`).join(', ')}`)
  }

  return report
}

async function runChatCodeStrategyScenarios(
  context: LocalProductE2EContext,
  scenarios: ChatCodeStrategyScenario[],
  chatTimeoutMs: number,
): Promise<ChatCodeStrategyScenarioReport[]> {
  const botId = context.newBotIds[0]
  if (!botId) throw new Error('local provisioning did not return a bot id')
  await configureDeterministicEvalSecrets(context.operatorUrl, context.token, botId)
  const bot = await findBot(context.operatorUrl, context.token, botId)
  const containerName = bot.sandbox_id ? `sidecar-${bot.sandbox_id}` : undefined
  const reports: ChatCodeStrategyScenarioReport[] = []
  for (const scenario of scenarios) {
    const sessionId = await createManualSession(context.operatorUrl, context.token, botId, scenario.title)
    const beforeTranscript = await getJson<unknown>(
      `${context.operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`,
      context.token,
    ).catch(() => ({}))
    const beforeAssistantCount = countAssistantMessages(beforeTranscript)
    await postJson<unknown>(
      `${context.operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages`,
      context.token,
      {
        message: scenario.prompt,
        parts: [{ type: 'text', text: scenario.prompt }],
      },
    )
    const transcript = await waitForTranscript(context.operatorUrl, context.token, botId, sessionId, scenario, beforeAssistantCount, chatTimeoutMs)
    const sandbox = containerName ? inspectScenarioSandbox(containerName, scenario) : { commands: {} }
    reports.push(buildScenarioReport({
      scenario,
      botId,
      sessionId,
      transcript,
      sandbox,
      ...(bot.sandbox_id ? { sandboxId: bot.sandbox_id } : {}),
      ...(containerName ? { containerName } : {}),
    }))
  }
  return reports
}

function buildScenarioReport(input: {
  scenario: ChatCodeStrategyScenario
  botId: string
  sandboxId?: string
  containerName?: string
  sessionId: string
  transcript: unknown
  sandbox: { commands: Record<string, SandboxCommandResult> }
}): ChatCodeStrategyScenarioReport {
  const transcriptText = collectText(input.transcript)
  const fileCheck = input.sandbox.commands.strategy_file
  const code = input.sandbox.commands.strategy_code?.stdout ?? ''
  const run = input.sandbox.commands.strategy_run
  const artifacts = input.sandbox.commands.strategy_artifacts?.stdout ?? ''
  const logs = input.sandbox.commands.strategy_logs?.stdout ?? ''
  const combinedEvidence = [transcriptText, code, run?.stdout ?? '', run?.stderr ?? '', artifacts, logs].join('\n')
  const termsPresent = input.scenario.requiredTerms.filter((term) => combinedEvidence.toLowerCase().includes(term.toLowerCase()))
  const latestAssistant = lastAssistantText(input.transcript)
  const assertions = [
    {
      name: 'chat transcript includes scenario intent',
      passed: transcriptText.toLowerCase().includes(input.scenario.id.split('-')[0] ?? input.scenario.id) || termsPresent.length >= 2,
      detail: summarizeText(transcriptText),
    },
    {
      name: 'agent responded through product chat',
      passed: hasAssistantMessage(input.transcript),
      detail: summarizeText(latestAssistant) || 'no assistant message observed',
    },
    {
      name: 'strategy file exists in sandbox',
      passed: fileCheck?.status === 0,
      detail: summarizeText([fileCheck?.stdout ?? '', fileCheck?.stderr ?? ''].join('\n')),
    },
    {
      name: 'strategy exports executable tick',
      passed: includesAll(code, ['module.exports', 'tick', 'ctx.']),
      detail: summarizeText(code),
    },
    {
      name: 'strategy run succeeded through run-strategy',
      passed: run?.status === 0 && includesAll(run.stdout, ['"ok": true', '"strategy_id"']),
      detail: summarizeText([run?.stdout ?? '', run?.stderr ?? ''].join('\n')),
    },
    {
      name: 'strategy writes user-visible evidence',
      passed: artifacts.trim().length > 0 || logs.trim().length > 0,
      detail: summarizeText([artifacts, logs].join('\n')),
    },
    {
      name: 'strategy stayed paper/shadow only',
      passed: includesAny(combinedEvidence, ['paper', 'shadow']) && !includesAny(combinedEvidence, ['private_key', 'PRIVATE_KEY', 'live_enabled: true', 'can_execute_live":true']),
      detail: summarizeText(combinedEvidence),
    },
    {
      name: 'strategy covers required scenario concepts',
      passed: termsPresent.length === input.scenario.requiredTerms.length,
      detail: `present=${termsPresent.join(', ')} required=${input.scenario.requiredTerms.join(', ')}`,
    },
  ]

  return {
    scenario_id: input.scenario.id,
    title: input.scenario.title,
    bot_id: input.botId,
    ...(input.sandboxId ? { sandbox_id: input.sandboxId } : {}),
    ...(input.containerName ? { container_name: input.containerName } : {}),
    session_id: input.sessionId,
    strategy_file: input.scenario.strategyFile,
    prompt: input.scenario.prompt,
    transcript: input.transcript,
    sandbox: input.sandbox,
    assertions,
  }
}

function inspectScenarioSandbox(containerName: string, scenario: ChatCodeStrategyScenario): { commands: Record<string, SandboxCommandResult> } {
  const quotedFile = shellQuote(scenario.strategyFile)
  const strategyId = scenario.id.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const commands: Record<string, string> = {
    strategy_file: `test -s ${quotedFile} && ls -l ${quotedFile}`,
    strategy_code: `sed -n '1,240p' ${quotedFile}`,
    strategy_run: `node /home/agent/tools/run-strategy.js ${quotedFile} --mode paper --id ${shellQuote(strategyId)}`,
    strategy_artifacts: `find /home/agent/eval-artifacts/strategies -type f 2>/dev/null | sort | tail -20 | while read -r f; do echo "FILE:$f"; sed -n '1,180p' "$f"; done`,
    strategy_logs: 'tail -80 /home/agent/logs/strategy-runs.jsonl 2>/dev/null',
  }
  return {
    commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, dockerExec(containerName, command)])),
  }
}

async function configureDeterministicEvalSecrets(operatorUrl: string, token: string, botId: string): Promise<void> {
  const envJson = deterministicAgentEnv()
  const url = `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/secrets`
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ env_json: envJson }),
  })
  if (!res.ok) {
    throw new Error(`failed to configure deterministic eval secrets for ${botId}: ${res.status} ${await res.text()}`)
  }
}

function deterministicAgentEnv(): Record<string, string> {
  const zaiKey = process.env.ZAI_API_KEY
  if (zaiKey) {
    return {
      ZAI_API_KEY: zaiKey,
      OPENCODE_MODEL_PROVIDER: 'zai-coding-plan',
      OPENCODE_MODEL_NAME: 'glm-4.7',
      OPENCODE_MODEL_API_KEY: zaiKey,
      SIDECAR_DEFAULT_HARNESS: 'opencode',
    }
  }
  const geminiKey = process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY
  if (geminiKey) {
    return {
      GEMINI_API_KEY: geminiKey,
      GOOGLE_API_KEY: geminiKey,
      SIDECAR_DEFAULT_HARNESS: 'gemini',
    }
  }
  throw new Error('chat-code strategy eval requires GOOGLE_AI_KEY, GEMINI_API_KEY, or ZAI_API_KEY for the real sandbox agent')
}

async function findBot(operatorUrl: string, token: string, botId: string): Promise<{ id: string; sandbox_id?: string }> {
  const body = await getJson<BotSummaryResponse>(`${operatorUrl}/api/bots?limit=200`, token)
  const bot = body.bots?.find((candidate) => candidate.id === botId)
  if (!bot?.id) throw new Error(`provisioned bot ${botId} was not returned by /api/bots`)
  return {
    id: bot.id,
    ...(typeof bot.sandbox_id === 'string' && bot.sandbox_id.length > 0 ? { sandbox_id: bot.sandbox_id } : {}),
  }
}

async function createManualSession(operatorUrl: string, token: string, botId: string, title: string): Promise<string> {
  const created = await postJson<SessionCreateResponse>(
    `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions`,
    token,
    { title },
  )
  return extractSessionId(created)
}

async function waitForTranscript(
  operatorUrl: string,
  token: string,
  botId: string,
  sessionId: string,
  scenario: ChatCodeStrategyScenario,
  beforeAssistantCount: number,
  timeoutMs: number,
): Promise<unknown> {
  const url = `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`
  const deadline = Date.now() + timeoutMs
  let latest: unknown = {}
  while (Date.now() < deadline) {
    latest = await getJson<unknown>(url, token)
    const assistant = assistantText(latest).toLowerCase()
    const newAssistantArrived = countAssistantMessages(latest) > beforeAssistantCount
    const answeredThisScenario = assistant.includes(scenario.strategyFile.toLowerCase()) ||
      assistant.includes(scenario.id.toLowerCase()) ||
      scenario.requiredTerms.every((term) => assistant.includes(term.toLowerCase()))
    if (newAssistantArrived && answeredThisScenario) {
      return latest
    }
    await sleep(5_000)
  }
  return latest
}

function countAssistantMessages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAssistantMessages(item), 0)
  if (typeof value !== 'object' || value === null) return 0
  const record = value as Record<string, unknown>
  const role = typeof record.role === 'string'
    ? record.role
    : typeof record.info === 'object' && record.info !== null && typeof (record.info as Record<string, unknown>).role === 'string'
      ? String((record.info as Record<string, unknown>).role)
      : ''
  const self = role.toLowerCase() === 'assistant' ? 1 : 0
  return self + Object.values(record).reduce<number>((sum, child) => sum + countAssistantMessages(child), 0)
}

function dockerExec(containerName: string, command: string): SandboxCommandResult {
  const result = spawnSync('docker', [
    'exec',
    '-u',
    'agent',
    '-e',
    'HOME=/home/agent',
    '-e',
    'PATH=/root/.bun/bin:/root/.local/bin:/root/.opencode/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
    containerName,
    'sh',
    '-lc',
    command,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  })
  return {
    command,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

function extractSessionId(value: SessionCreateResponse): string {
  const id = value.id ?? value.session_id ?? value.session?.id
  if (!id) throw new Error(`session create response did not contain an id: ${JSON.stringify(value)}`)
  return id
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(collectText).join('\n')
  if (typeof value === 'object' && value !== null) return Object.values(value).map(collectText).join('\n')
  return ''
}

function hasAssistantMessage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAssistantMessage)
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const role = typeof record.role === 'string'
    ? record.role
    : typeof record.info === 'object' && record.info !== null && typeof (record.info as Record<string, unknown>).role === 'string'
      ? String((record.info as Record<string, unknown>).role)
      : ''
  if (role.toLowerCase() === 'assistant') return true
  return Object.values(record).some(hasAssistantMessage)
}

function assistantText(value: unknown): string {
  if (Array.isArray(value)) return value.map(assistantText).filter(Boolean).join('\n')
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  const role = typeof record.role === 'string'
    ? record.role
    : typeof record.info === 'object' && record.info !== null && typeof (record.info as Record<string, unknown>).role === 'string'
      ? String((record.info as Record<string, unknown>).role)
      : ''
  if (role.toLowerCase() === 'assistant') return collectText(record)
  return Object.values(record).map(assistantText).filter(Boolean).join('\n')
}

function lastAssistantText(value: unknown): string {
  const messages = assistantMessages(value)
  return messages[messages.length - 1] ?? ''
}

function assistantMessages(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(assistantMessages)
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const role = typeof record.role === 'string'
    ? record.role
    : typeof record.info === 'object' && record.info !== null && typeof (record.info as Record<string, unknown>).role === 'string'
      ? String((record.info as Record<string, unknown>).role)
      : ''
  const childMessages = Object.values(record).flatMap(assistantMessages)
  return role.toLowerCase() === 'assistant'
    ? [collectText(record), ...childMessages]
    : childMessages
}

function includesAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase()))
}

function includesAll(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase()
  return needles.every((needle) => lower.includes(needle.toLowerCase()))
}

function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 300 ? `${normalized.slice(0, 297)}...` : normalized || 'empty'
}

function selectScenarios(ids: string[] | undefined): ChatCodeStrategyScenario[] {
  if (!ids || ids.length === 0) return SCENARIOS
  const byId = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]))
  return ids.map((id) => {
    const scenario = byId.get(id)
    if (!scenario) throw new Error(`unknown chat-code strategy scenario ${id}; valid ids: ${SCENARIOS.map((s) => s.id).join(', ')}`)
    return scenario
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
