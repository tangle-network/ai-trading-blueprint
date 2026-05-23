import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { importAgentEval, type TraceEmitterLike } from '../lib/agent-eval.js'
import { sha256 } from '../lib/crypto.js'
import { repoRoot } from '../lib/repo.js'
import { runLocalProductE2E, type LocalProductE2EContext, type LocalProductE2EReport } from './local-stack-runner.js'

const SCENARIO_ID = 'chat-mcp-multishot-strategy'
const STRATEGY_FILE = 'tools/strategies/eval-mcp-multishot-breakout.js'
const STRATEGY_PATH = `/home/agent/${STRATEGY_FILE}`
const MCP_PROMPT = [
  'Run this exact command in the sandbox terminal now:',
  'node /home/agent/tools/create-mcp-multishot-strategy-task.js',
  '',
  'This command dispatches self_improvement.create_task through the local MCP server with wait_for_completion: true, max_rounds: 3, an intentional round-1 failure, a round-2 fix, run-strategy tests, patch export, and promote_candidate.',
  'Do not edit strategy files directly and do not bypass MCP.',
  'After it finishes, reply with the task id, status, winner variant, rounds used, patch sha, files changed, and the run-strategy result.',
  'Keep this paper/shadow only; do not ask for keys and do not trade live funds.',
].join('\n')

export interface ChatMcpStrategyE2EOptions {
  baseUrl?: string
  operatorUrl?: string
  outputPath?: string
  outputDir?: string
  startStack?: boolean
  keepStack?: boolean
  maxTurns?: number
  chatTimeoutMs?: number
}

export interface ChatMcpStrategyE2EReport {
  suite: 'arena-chat-mcp-strategy-e2e'
  scenario_id: typeof SCENARIO_ID
  output_dir: string
  product: LocalProductE2EReport
  scenario: ChatMcpScenarioReport
  assertions: Array<{ name: string; passed: boolean; detail: string }>
}

export interface ChatMcpScenarioReport {
  bot_id: string
  sandbox_id?: string
  container_name?: string
  session_id: string
  prompt: string
  transcript: unknown
  sandbox: { commands: Record<string, SandboxCommandResult> }
  mcp_task?: McpTaskEvidence
  assertions: Array<{ name: string; passed: boolean; detail: string }>
}

interface SandboxCommandResult {
  command: string
  status: number | null
  stdout: string
  stderr: string
}

interface BotSummaryResponse {
  bots?: Array<{ id?: string; sandbox_id?: string }>
}

interface SessionCreateResponse {
  id?: string
  session_id?: string
  session?: { id?: string }
}

interface McpTaskEvidence {
  task_id: string
  status?: string
  max_rounds?: number
  winner_variant_id?: string | null
  patch_sha256?: string | null
  files_changed?: string[]
  variants?: Array<{
    variant_id?: string
    state?: string
    rounds_used?: number
    test_passed?: number | boolean | null
    files_changed?: string[]
    diff_additions?: number
    shots?: Array<{
      round?: number
      coding_ok?: boolean
      diff_additions?: number
      files_changed?: string[]
      tests?: Array<{ command?: string; ok?: boolean; status?: number | null }>
    }>
  }>
}

export async function runChatMcpStrategyE2E(options: ChatMcpStrategyE2EOptions = {}): Promise<ChatMcpStrategyE2EReport> {
  let scenario: ChatMcpScenarioReport | undefined
  const product = await runLocalProductE2E({
    ...options,
    afterProvision: async (context) => {
      scenario = await runScenario(context, options.chatTimeoutMs ?? 900_000)
      return scenario
    },
  })
  if (!scenario) throw new Error('chat MCP strategy scenario did not run')

  const assertions = [
    ...product.assertions.map((assertion) => ({ ...assertion, name: `product: ${assertion.name}` })),
    ...scenario.assertions.map((assertion) => ({ ...assertion, name: `mcp: ${assertion.name}` })),
  ]
  const report: ChatMcpStrategyE2EReport = {
    suite: 'arena-chat-mcp-strategy-e2e',
    scenario_id: SCENARIO_ID,
    output_dir: product.output_dir,
    product,
    scenario,
    assertions,
  }

  const outputPath = resolve(repoRoot, options.outputPath ?? `${product.output_dir}/chat-mcp-strategy-report.json`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeAgentEvalTrace(product.output_dir, report)

  if (assertions.some((assertion) => !assertion.passed)) {
    throw new Error(`chat MCP strategy e2e failed: ${assertions.map((a) => `${a.name}=${a.passed}`).join(', ')}`)
  }
  return report
}

async function runScenario(context: LocalProductE2EContext, chatTimeoutMs: number): Promise<ChatMcpScenarioReport> {
  const botId = context.newBotIds[0]
  if (!botId) throw new Error('local provisioning did not return a bot id')
  await configureDeterministicEvalSecrets(context.operatorUrl, context.token, botId)
  const bot = await findBot(context.operatorUrl, context.token, botId)
  const containerName = bot.sandbox_id ? `sidecar-${bot.sandbox_id}` : undefined
  const sessionId = await createManualSession(context.operatorUrl, context.token, botId)
  await postJson<unknown>(
    `${context.operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages`,
    context.token,
    { message: MCP_PROMPT, parts: [{ type: 'text', text: MCP_PROMPT }] },
  )
  const transcript = await waitForTranscript(context.operatorUrl, context.token, botId, sessionId, chatTimeoutMs, containerName)
  const sandbox = containerName ? inspectSandbox(containerName) : { commands: {} }
  const mcpTask = parseMcpTask(sandbox.commands.mcp_task_evidence?.stdout ?? '')
  const assertions = buildAssertions(transcript, sandbox, mcpTask)
  return {
    bot_id: botId,
    ...(bot.sandbox_id ? { sandbox_id: bot.sandbox_id } : {}),
    ...(containerName ? { container_name: containerName } : {}),
    session_id: sessionId,
    prompt: MCP_PROMPT,
    transcript,
    sandbox,
    ...(mcpTask ? { mcp_task: mcpTask } : {}),
    assertions,
  }
}

function inspectSandbox(containerName: string): { commands: Record<string, SandboxCommandResult> } {
  const commands: Record<string, string> = {
    mcp_tools: 'printf \'{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\\n\' | bun --bun /home/agent/tools/self-improvement-mcp-server.ts 2>&1 | head -120',
    mcp_task_evidence: `node - <<'NODE'
const fs=require('fs'), path=require('path');
const dir='/home/agent/.evolve/mcp-self-improvement/tasks';
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f)).sort():[];
const tasks=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8'))).filter(t=>JSON.stringify(t).includes('eval-mcp-multishot-breakout'));
const t=tasks[tasks.length-1];
if (t) console.log(JSON.stringify(t,null,2));
NODE`,
    mcp_task_logs: `node - <<'NODE'
const fs=require('fs'), path=require('path');
const dir='/home/agent/.evolve/mcp-self-improvement/tasks';
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f)).sort():[];
const tasks=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8'))).filter(t=>JSON.stringify(t).includes('eval-mcp-multishot-breakout'));
const t=tasks[tasks.length-1];
if (t) {
  const log=path.join(dir,t.task_id+'.log');
  if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log,'utf8'));
}
NODE`,
    mcp_patch: `node - <<'NODE'
const fs=require('fs'), path=require('path');
const dir='/home/agent/.evolve/mcp-self-improvement/tasks';
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>path.join(dir,f)).sort():[];
const tasks=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8'))).filter(t=>JSON.stringify(t).includes('eval-mcp-multishot-breakout'));
const t=tasks[tasks.length-1];
if (t) {
  const patch=path.join(dir,t.task_id+'.patch');
  if (fs.existsSync(patch)) process.stdout.write(fs.readFileSync(patch,'utf8'));
}
NODE`,
    mcp_candidate: `find /home/agent/.evolve/mcp-self-improvement/tasks -maxdepth 1 -name '*.candidate.json' -type f 2>/dev/null | sort | tail -5 | xargs -r sed -n '1,220p'`,
    mcp_helper_artifact: 'sed -n "1,260p" /home/agent/eval-artifacts/mcp/multishot-strategy-task.json 2>/dev/null',
    root_strategy_file: `test -s ${STRATEGY_PATH} && sed -n '1,220p' ${STRATEGY_PATH}`,
    worktree_strategy_file: `find /home/agent/.evolve/mcp-self-improvement/worktrees -path '*/${STRATEGY_FILE}' -type f 2>/dev/null | sort | tail -1 | xargs -r sed -n '1,220p'`,
    strategy_run: `p=$(find /home/agent/.evolve/mcp-self-improvement/worktrees -path '*/${STRATEGY_FILE}' -type f 2>/dev/null | sort | tail -1); test -n "$p" && node /home/agent/tools/run-strategy.js "$p" --mode paper --id eval-mcp-multishot-breakout`,
    strategy_artifacts: `find /home/agent/eval-artifacts/strategies -type f 2>/dev/null | sort | tail -20 | while read -r f; do echo "FILE:$f"; sed -n '1,160p' "$f"; done`,
  }
  return {
    commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, dockerExec(containerName, command)])),
  }
}

function buildAssertions(transcript: unknown, sandbox: { commands: Record<string, SandboxCommandResult> }, task?: McpTaskEvidence): Array<{ name: string; passed: boolean; detail: string }> {
  const text = collectText(transcript)
  const mcpTools = sandbox.commands.mcp_tools?.stdout ?? ''
  const taskText = sandbox.commands.mcp_task_evidence?.stdout ?? ''
  const logs = sandbox.commands.mcp_task_logs?.stdout ?? ''
  const patch = sandbox.commands.mcp_patch?.stdout ?? ''
  const candidate = sandbox.commands.mcp_candidate?.stdout ?? ''
  const helperArtifact = sandbox.commands.mcp_helper_artifact?.stdout ?? ''
  const strategyCode = [sandbox.commands.root_strategy_file?.stdout ?? '', sandbox.commands.worktree_strategy_file?.stdout ?? ''].join('\n')
  const run = sandbox.commands.strategy_run
  const artifacts = sandbox.commands.strategy_artifacts?.stdout ?? ''
  const variants = task?.variants ?? []
  const winner = variants.find((variant) => variant.variant_id === task?.winner_variant_id) ?? variants.find((variant) => variant.state === 'approved')
  const shots = variants.flatMap((variant) => variant.shots ?? [])
  const failedFirstRound = shots.some((shot) => shot.round === 1 && (shot.tests ?? []).some((test) => test.ok === false))
  const passedLaterRound = shots.some((shot) => (shot.round ?? 0) >= 2 && (shot.tests ?? []).some((test) => test.ok === true))
  return [
    { name: 'agent responded through product chat', passed: hasAssistantMessage(transcript), detail: summarizeText(lastAssistantText(transcript)) },
    { name: 'MCP server exposed create_task', passed: mcpTools.includes('self_improvement.create_task'), detail: summarizeText(mcpTools) },
    { name: 'chat dispatched MCP task', passed: Boolean(task?.task_id), detail: summarizeText(taskText || helperArtifact || text) },
    { name: 'MCP task completed', passed: task?.status === 'completed', detail: summarizeText(taskText) },
    { name: 'MCP task requested multi-shot budget', passed: (task?.max_rounds ?? 0) >= 3, detail: `max_rounds=${task?.max_rounds ?? 'missing'}` },
    { name: 'MCP task used multiple rounds', passed: (winner?.rounds_used ?? 0) >= 2, detail: `rounds_used=${winner?.rounds_used ?? 'missing'}` },
    { name: 'MCP recorded failed first round and passing later round', passed: failedFirstRound && passedLaterRound, detail: summarizeText(JSON.stringify(shots)) },
    { name: 'MCP selected winner and patch', passed: Boolean(task?.winner_variant_id && task?.patch_sha256 && patch.includes(STRATEGY_FILE)), detail: summarizeText([task?.winner_variant_id ?? '', task?.patch_sha256 ?? '', patch].join('\n')) },
    { name: 'MCP produced promotion candidate', passed: (candidate.includes('patch_sha256') && candidate.includes('winner_variant_id')) || helperArtifact.includes('"candidate"'), detail: summarizeText([candidate, helperArtifact].join('\n')) },
    { name: 'strategy code exists in winning worktree', passed: strategyCode.includes('eval-mcp-multishot-breakout') && strategyCode.includes('async tick'), detail: summarizeText(strategyCode) },
    { name: 'strategy run succeeded through run-strategy', passed: run?.status === 0 && run.stdout.includes('"ok": true'), detail: summarizeText([run?.stdout ?? '', run?.stderr ?? ''].join('\n')) },
    { name: 'strategy wrote user-visible artifact/log evidence', passed: artifacts.includes('mcp-multishot-breakout') || (run?.stdout ?? '').includes('mcp_multishot_breakout'), detail: summarizeText([artifacts, run?.stdout ?? ''].join('\n')) },
    { name: 'helper wrote durable eval artifact', passed: helperArtifact.includes('eval-mcp-multishot-breakout') && helperArtifact.includes('patch_contains_strategy'), detail: summarizeText(helperArtifact) },
    { name: 'no live trading promotion', passed: !includesAny([text, taskText, patch, candidate, helperArtifact, strategyCode].join('\n'), ['can_execute_live":true', 'live_enabled: true', 'PRIVATE_KEY']), detail: 'searched transcript, MCP task, patch, candidate, helper artifact, and code' },
  ]
}

async function configureDeterministicEvalSecrets(operatorUrl: string, token: string, botId: string): Promise<void> {
  const envJson = deterministicAgentEnv()
  const url = `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/secrets`
  let lastError = ''
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ env_json: envJson }),
    })
    if (res.ok) return
    lastError = `${res.status} ${await res.text()}`
    if (!lastError.includes('No such container') && !lastError.includes('load_container failed')) break
    await sleep(2_000 * attempt)
  }
  throw new Error(`failed to configure deterministic eval secrets for ${botId}: ${lastError}`)
}

function deterministicAgentEnv(): Record<string, string> {
  const zaiKey = process.env.ZAI_API_KEY
  if (zaiKey) return { ZAI_API_KEY: zaiKey, OPENCODE_MODEL_PROVIDER: 'zai-coding-plan', OPENCODE_MODEL_NAME: 'glm-4.7', OPENCODE_MODEL_API_KEY: zaiKey, SIDECAR_DEFAULT_HARNESS: 'opencode' }
  const geminiKey = process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY
  if (geminiKey) return { GEMINI_API_KEY: geminiKey, GOOGLE_API_KEY: geminiKey, SIDECAR_DEFAULT_HARNESS: 'gemini' }
  throw new Error('chat MCP strategy eval requires GOOGLE_AI_KEY, GEMINI_API_KEY, or ZAI_API_KEY for the real sandbox agent')
}

async function findBot(operatorUrl: string, token: string, botId: string): Promise<{ id: string; sandbox_id?: string }> {
  const body = await getJson<BotSummaryResponse>(`${operatorUrl}/api/bots?limit=200`, token)
  const bot = body.bots?.find((candidate) => candidate.id === botId)
  if (!bot?.id) throw new Error(`provisioned bot ${botId} was not returned by /api/bots`)
  return { id: bot.id, ...(typeof bot.sandbox_id === 'string' && bot.sandbox_id.length > 0 ? { sandbox_id: bot.sandbox_id } : {}) }
}

async function createManualSession(operatorUrl: string, token: string, botId: string): Promise<string> {
  const created = await postJson<SessionCreateResponse>(
    `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions`,
    token,
    { title: 'MCP multi-shot strategy eval' },
  )
  const id = created.id ?? created.session_id ?? created.session?.id
  if (!id) throw new Error(`session create response did not contain an id: ${JSON.stringify(created)}`)
  return id
}

async function waitForTranscript(operatorUrl: string, token: string, botId: string, sessionId: string, timeoutMs: number, containerName?: string): Promise<unknown> {
  const url = `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`
  const deadline = Date.now() + timeoutMs
  let artifactSeenAt: number | undefined
  let latest: unknown = {}
  while (Date.now() < deadline) {
    latest = await getJson<unknown>(url, token)
    const assistant = lastAssistantText(latest).toLowerCase()
    if (assistant.includes('eval-mcp-multishot-breakout') || assistant.includes('self_improvement') || assistant.includes('patch sha') || assistant.includes('multishot-strategy-task')) {
      return latest
    }
    if (containerName && sandboxHasCompletedMcpTask(containerName)) {
      artifactSeenAt ??= Date.now()
      if (Date.now() - artifactSeenAt > 60_000) return latest
    }
    await sleep(5_000)
  }
  return latest
}

function sandboxHasCompletedMcpTask(containerName: string): boolean {
  const result = dockerExec(containerName, 'test -s /home/agent/eval-artifacts/mcp/multishot-strategy-task.json && grep -q \'"status": "completed"\' /home/agent/eval-artifacts/mcp/multishot-strategy-task.json')
  return result.status === 0
}

function dockerExec(containerName: string, command: string): SandboxCommandResult {
  const result = spawnSync('docker', ['exec', '-u', 'agent', '-e', 'HOME=/home/agent', '-e', 'PATH=/root/.bun/bin:/root/.local/bin:/root/.opencode/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin', containerName, 'sh', '-lc', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  })
  return { command, status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

function parseMcpTask(text: string): McpTaskEvidence | undefined {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as McpTaskEvidence
  } catch {
    return undefined
  }
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(collectText).join('\n')
  if (typeof value === 'object' && value !== null) return Object.values(value).map(collectText).join('\n')
  return ''
}

function hasAssistantMessage(value: unknown): boolean {
  return assistantMessages(value).length > 0
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
  return role.toLowerCase() === 'assistant' ? [collectText(record), ...childMessages] : childMessages
}

function includesAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase()))
}

function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 360 ? `${normalized.slice(0, 357)}...` : normalized || 'empty'
}

async function writeAgentEvalTrace(outputDir: string, report: ChatMcpStrategyE2EReport): Promise<void> {
  const traceDir = resolve(outputDir, 'agent-eval-traces')
  mkdirSync(traceDir, { recursive: true })
  try {
    const agentEval = await importAgentEval()
    const store = new agentEval.FileSystemTraceStore({ dir: traceDir })
    const runId = `${SCENARIO_ID}-${Date.now()}`
    const emitter = new agentEval.TraceEmitter(store, { runId })
    await recordTrace(emitter, report)
    const record = agentEval.validateRunRecord({
      runId,
      experimentId: report.suite,
      candidateId: 'product-chat-mcp-multishot',
      seed: 0,
      model: snapshotModel(process.env.BAD_TANGLE_ROUTER_MODEL ?? 'product-chat-agent'),
      promptHash: sha256(report.scenario.prompt),
      configHash: sha256({ scenario: SCENARIO_ID, assertions: report.assertions.map((a) => a.name) }),
      commitSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim(),
      wallMs: 0,
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      outcome: {
        searchScore: report.assertions.every((assertion) => assertion.passed) ? 1 : 0,
        raw: { passed: report.assertions.filter((a) => a.passed).length, total: report.assertions.length },
      },
      splitTag: 'dev',
      scenarioId: SCENARIO_ID,
    })
    writeFileSync(resolve(traceDir, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch (error) {
    writeFileSync(resolve(traceDir, 'agent-eval-import-error.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, 'utf8')
  }
  writeFileSync(resolve(traceDir, 'raw-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function snapshotModel(model: string): string {
  if (/@\d{4}-\d{2}-\d{2}$/.test(model) || /-\d{8}$/.test(model)) return model
  return `${model}@2026-05-23`
}

async function recordTrace(emitter: TraceEmitterLike, report: ChatMcpStrategyE2EReport): Promise<void> {
  await emitter.startRun({ suite: report.suite, scenario_id: report.scenario_id, prompt_hash: sha256(report.scenario.prompt) })
  const provision = await emitter.tool({ name: 'local product provisioning', toolName: 'runLocalProductE2E' })
  await provision.end({ assertions: report.product.assertions, bot_id: report.scenario.bot_id, sandbox_id: report.scenario.sandbox_id })
  const chat = await emitter.tool({ name: 'product chat MCP request', toolName: 'operator chat api' })
  await chat.end({ session_id: report.scenario.session_id, transcript: report.scenario.transcript })
  const mcp = await emitter.tool({ name: 'sandbox MCP multi-shot task', toolName: 'self_improvement.create_task/status/patch/promote' })
  await mcp.end({ task: report.scenario.mcp_task, commands: report.scenario.sandbox.commands })
  await emitter.recordArtifact({ name: 'chat-mcp-strategy-report', mimeType: 'application/json', value: report })
  await emitter.endRun({ status: report.assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed', assertions: report.assertions })
}
