import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { importAgentEval, type TraceEmitterLike } from '../lib/agent-eval.js'
import { repoRoot } from '../lib/repo.js'
import { runLocalProductE2E, type LocalProductE2EContext, type LocalProductE2EReport } from './local-stack-runner.js'

const SCENARIO_ID = 'rain-chat-to-sandbox'
const RAIN_PROMPT = [
  'Research Rain SDK trading and positions support from the real developer docs, then build a useful paper-trading prototype for a human user who asked: "integrate and market make on Rain markets."',
  'Do not stop at a plan, checklist, metadata artifact, or docs. Use the local self-improvement MCP server to complete a real code-changing task in an isolated worktree.',
  'The MCP task must build the smallest useful executable Rain paper-trading capability under tools/rain-paper/: typed market/position models, a deterministic fake Rain market fixture, a paper execution engine, a simple market-making strategy, and a run-demo script that prints and writes eval-artifacts/rain/demo-result.json.',
  'The demo must show something a user can understand: selected Rain-like market, quotes/orders, simulated fills, final positions, PnL, risk blocks, and why live trading is still disabled.',
  'Use Rain SDK method names from the docs as the adapter boundary: reads such as getPublicMarkets/getMarketDetails/getMarketPrices/getMarketLiquidity/getPortfolioValue, and simulated writes such as buildBuyOptionRawTx/buildLimitBuyOptionTx/buildSellOptionTx/buildClaimTx/buildAddLiquidityTx. Do not request live keys or submit real transactions.',
  'The MCP task must run deterministic executable checks, not string-only checks. At minimum: bun test tools/rain-paper/rain-paper.test.ts and bun --bun tools/rain-paper/run-demo.ts. The tests must exercise the strategy, paper engine, PnL accounting, exposure/slippage/risk guards, and the demo artifact.',
  'If the full prototype cannot complete, write the exact blocking command and error into sandbox memory and say what remains. Otherwise summarize the generated files, demo result, tests, and live-trading blockers.',
  'Do not ask for live keys and do not trade real funds.',
].join('\n')

export interface ChatSandboxE2EOptions {
  baseUrl?: string
  operatorUrl?: string
  outputPath?: string
  outputDir?: string
  startStack?: boolean
  keepStack?: boolean
  maxTurns?: number
  chatTimeoutMs?: number
}

export interface ChatSandboxE2EReport {
  suite: 'arena-chat-sandbox-e2e'
  scenario_id: typeof SCENARIO_ID
  output_dir: string
  product: LocalProductE2EReport
  chat_scenario: ChatSandboxScenarioReport
  assertions: Array<{ name: string; passed: boolean; detail: string }>
}

export interface ChatSandboxScenarioReport {
  bot_id: string
  sandbox_id?: string
  container_name?: string
  session_id?: string
  prompt: string
  transcript: unknown
  sandbox: {
    commands: Record<string, SandboxCommandResult>
  }
  evolution: {
    self_improvement_runs?: unknown
    revision_arena?: unknown
  }
  answers: Array<{ question: string; answer: 'yes' | 'no' | 'unknown'; evidence: string }>
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

interface ChatSessionSummary {
  id?: string
  session_id?: string
  session_type?: string
}

interface BotSummaryResponse {
  bots?: Array<{ id?: string; sandbox_id?: string }>
}

export async function runChatSandboxE2E(options: ChatSandboxE2EOptions = {}): Promise<ChatSandboxE2EReport> {
  let scenario: ChatSandboxScenarioReport | undefined
  const product = await runLocalProductE2E({
    ...options,
    afterProvision: async (context) => {
      scenario = await runRainChatScenario(context, options.chatTimeoutMs ?? 240_000)
      return scenario
    },
  })

  if (!scenario) {
    throw new Error('chat sandbox scenario did not run because local provisioning did not produce exactly one bot and provision')
  }

  const assertions = [
    ...product.assertions.map((assertion) => ({ ...assertion, name: `product: ${assertion.name}` })),
    ...scenario.assertions.map((assertion) => ({ ...assertion, name: `chat: ${assertion.name}` })),
  ]
  const report: ChatSandboxE2EReport = {
    suite: 'arena-chat-sandbox-e2e',
    scenario_id: SCENARIO_ID,
    output_dir: product.output_dir,
    product,
    chat_scenario: scenario,
    assertions,
  }

  const outputPath = resolve(repoRoot, options.outputPath ?? `${product.output_dir}/chat-sandbox-report.json`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeAgentEvalTrace(product.output_dir, report)

  if (assertions.some((assertion) => !assertion.passed)) {
    throw new Error(`chat sandbox e2e failed: ${assertions.map((a) => `${a.name}=${a.passed}`).join(', ')}`)
  }

  return report
}

async function runRainChatScenario(context: LocalProductE2EContext, chatTimeoutMs: number): Promise<ChatSandboxScenarioReport> {
  const botId = context.newBotIds[0]
  if (!botId) throw new Error('local provisioning did not return a bot id')
  await configureDeterministicEvalSecrets(context.operatorUrl, context.token, botId)
  const bot = await findBot(context.operatorUrl, context.token, botId)
  const sessionId = await selectOrCreateManualSession(context.operatorUrl, context.token, botId)
  await postJson<unknown>(
    `${context.operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages`,
    context.token,
    {
      message: RAIN_PROMPT,
      parts: [{ type: 'text', text: RAIN_PROMPT }],
    },
  )

  const transcript = await waitForTranscript(context.operatorUrl, context.token, botId, sessionId, chatTimeoutMs)
  const transcriptText = collectText(transcript)
  const assistantResponded = hasAssistantMessage(transcript)
  const containerName = bot.sandbox_id ? `sidecar-${bot.sandbox_id}` : undefined
  const sandbox = containerName ? inspectSandbox(containerName) : { commands: {} }
  const memoryText = [
    sandbox.commands.memory_rain_hits?.stdout ?? '',
    sandbox.commands.memory_rain_excerpt?.stdout ?? '',
  ].join('\n')
  const mcpTaskCount = parseCount(sandbox.commands.mcp_task_count?.stdout)
  const mcpTaskSummary = sandbox.commands.mcp_task_summary?.stdout ?? ''
  const workspaceChanges = (sandbox.commands.git_status?.stdout ?? '').trim()
  const toolchainText = sandbox.commands.toolchain?.stdout ?? ''
  const selfImprovementStatus = [
    sandbox.commands.self_improvement_tools?.stdout ?? '',
    sandbox.commands.self_improvement_status?.stdout ?? '',
    sandbox.commands.self_improvement_mcp_list?.stdout ?? '',
  ].join('\n')
  const executionArtifacts = [
    sandbox.commands.agent_env?.stdout ?? '',
    selfImprovementStatus,
    mcpTaskSummary,
    sandbox.commands.rain_task_evidence?.stdout ?? '',
    sandbox.commands.rain_patch_excerpt?.stdout ?? '',
    sandbox.commands.rain_root_checks?.stdout ?? '',
    sandbox.commands.rain_root_checks?.stderr ?? '',
    sandbox.commands.rain_demo_artifact?.stdout ?? '',
    sandbox.commands.rain_code_excerpt?.stdout ?? '',
    sandbox.commands.self_improvement_runs?.stdout ?? '',
    sandbox.commands.revision_arena?.stdout ?? '',
    sandbox.commands.recent_evolve_rain_excerpt?.stdout ?? '',
    sandbox.commands.capability_artifacts?.stdout ?? '',
    sandbox.commands.capability_artifact_excerpt?.stdout ?? '',
  ].join('\n').trim()
  const evolution = await inspectEvolution(context.operatorUrl, context.token, botId)
  const assistant = assistantText(transcript)
  const evidenceText = [transcriptText, memoryText, executionArtifacts].join('\n')
  const hasRainDeveloperEvidence = includesAny(evidenceText, [
    'rain.one/docs',
    'Rain-SDK',
    'Trading-and-positions',
    'trading and positions',
  ])
  const hasActionableCapabilityArtifact = includesAny(executionArtifacts, [
    'rain',
  ]) && includesAny(executionArtifacts, [
    'paper',
    'backtest',
    'validation',
    'blocker',
    'risk',
  ])
  const startedImprovement = mcpTaskCount > 0 || workspaceChanges.length > 0 || hasActionableCapabilityArtifact
  const rainTaskEvidence = sandbox.commands.rain_task_evidence?.stdout ?? ''
  const rainDemoArtifact = sandbox.commands.rain_demo_artifact?.stdout ?? ''
  const rainCodeExcerpt = sandbox.commands.rain_code_excerpt?.stdout ?? ''
  const rainRootChecks = sandbox.commands.rain_root_checks
  const rainRootCheckText = [rainRootChecks?.stdout ?? '', rainRootChecks?.stderr ?? ''].join('\n')
  const completedMcpTask = includesAny(rainTaskEvidence, ['"status":"completed"', '"status": "completed"']) &&
    includesAny(rainTaskEvidence, ['"patch_sha256":"sha256:', '"patch_sha256": "sha256:']) &&
    includesAny(rainTaskEvidence, ['"test_passed":1', '"test_passed": 1', '"test_passed":true', '"test_passed": true']) &&
    includesAny(rainTaskEvidence, ['"diff_additions":']) &&
    !includesAny(rainTaskEvidence, ['"diff_additions":0', '"diff_additions": 0'])
  const executableRainFilesPresent = includesAll([rainTaskEvidence, rainCodeExcerpt].join('\n'), [
    'tools/rain-paper/',
    'engine.ts',
    'strategy.ts',
    'run-demo',
    'rain-paper.test',
  ])
  const rootRainPrototypeVerified = rainRootChecks?.status === 0 &&
    includesAll(rainRootCheckText, ['bun test', 'tools/rain-paper/rain-paper.test.ts', 'run-demo', 'Demo result written']) &&
    includesAll(rainDemoArtifact, ['demo-result.json', 'finalBalance', 'positions'])
  const builtExecutableRainPrototype = (completedMcpTask || rootRainPrototypeVerified) &&
    executableRainFilesPresent &&
    includesAny(rainCodeExcerpt, ['class', 'function', 'export']) &&
    includesAll([rainDemoArtifact, rainCodeExcerpt].join('\n').toLowerCase(), [
      'pnl',
      'position',
      'fill',
      'risk',
      'bid',
      'ask',
    ])
  const executedSelfImprovementTask = completedMcpTask || workspaceChanges.length > 0 || hasSuccessfulEvolutionPayload(evolution)
  const hasValidationPlan = includesAny(evidenceText, ['backtest', 'paper trade', 'paper-trading', 'validation', 'test']) &&
    includesAny(evidenceText, ['risk', 'limit', 'blocked', 'live'])
  const agentEnv = sandbox.commands.agent_env?.stdout ?? ''
  const usesExpectedHarness = (
    agentEnv.includes('SIDECAR_DEFAULT_HARNESS=opencode') &&
    agentEnv.includes('ZAI_API_KEY=') &&
    agentEnv.includes('OPENCODE_MODEL_PROVIDER=zai-coding-plan')
  ) || (
    agentEnv.includes('SIDECAR_DEFAULT_HARNESS=gemini') &&
    agentEnv.includes('GEMINI_API_KEY=')
  )
  const hasHarnessRuntimeErrors = includesAny(executionArtifacts, [
    'kill EPERM',
    'AGENT_EXECUTION_FAILED',
    'failed to map segment',
    'metadata missing',
    'token mismatch',
  ])
  const selfImprovementRuntimeReady = includesAny(toolchainText, ['bun=']) &&
    selfImprovementStatus.includes('self-improvement-loop.ts') &&
    selfImprovementStatus.includes('self-improvement-mcp-server.ts') &&
    selfImprovementStatus.includes('"workspace"') &&
    selfImprovementStatus.includes('self_improvement.create_task')

  const assertions = [
    {
      name: 'chat session created',
      passed: sessionId.length > 0,
      detail: sessionId || 'no session id',
    },
    {
      name: 'chat transcript contains Rain request',
      passed: transcriptText.toLowerCase().includes('rain'),
      detail: summarizeText(transcriptText),
    },
    {
      name: 'sandbox memory contains Rain request',
      passed: memoryText.toLowerCase().includes('rain'),
      detail: summarizeText(memoryText),
    },
    {
      name: 'sandbox uses requested coding harness',
      passed: usesExpectedHarness,
      detail: summarizeText(agentEnv),
    },
    {
      name: 'sandbox harness produced no runtime process errors',
      passed: !hasHarnessRuntimeErrors,
      detail: summarizeText(executionArtifacts),
    },
    {
      name: 'sandbox self-improvement runtime is executable',
      passed: selfImprovementRuntimeReady,
      detail: summarizeText([toolchainText, selfImprovementStatus].join('\n')),
    },
    {
      name: 'agent responded through product chat',
      passed: assistantResponded,
      detail: summarizeText(assistant) || 'no assistant message observed',
    },
    {
      name: 'agent used Rain developer evidence',
      passed: hasRainDeveloperEvidence,
      detail: summarizeText(evidenceText),
    },
    {
      name: 'agent kept Rain integration paper-first',
      passed: includesAll(transcriptText, ['paper']) || includesAll(memoryText, ['paper']),
      detail: 'paper-first signal searched in transcript and sandbox memory',
    },
    {
      name: 'agent produced a tactical capability artifact or task',
      passed: startedImprovement,
      detail: summarizeText(executionArtifacts || workspaceChanges || `mcp task files=${mcpTaskCount}`),
    },
    {
      name: 'agent completed an executable Rain paper-trading prototype',
      passed: builtExecutableRainPrototype,
      detail: summarizeText([rainTaskEvidence, rainRootCheckText, rainDemoArtifact, rainCodeExcerpt].join('\n') || `mcp task files=${mcpTaskCount}`),
    },
    {
      name: 'agent specified validation and risk gates',
      passed: hasValidationPlan,
      detail: summarizeText(evidenceText),
    },
    {
      name: 'no live promotion occurred',
      passed: !collectText(evolution).toLowerCase().includes('"can_execute_live":true'),
      detail: 'no live-enabled revision observed in evolution endpoints',
    },
  ]

  return {
    bot_id: botId,
    ...(bot.sandbox_id ? { sandbox_id: bot.sandbox_id } : {}),
    ...(containerName ? { container_name: containerName } : {}),
    session_id: sessionId,
    prompt: RAIN_PROMPT,
    transcript,
    sandbox,
    evolution,
    answers: [
      answer('Did the real chat API accept a user Rain request?', true, `session=${sessionId}`),
      answer('Did the request reach sandbox memory/filesystem?', memoryText.toLowerCase().includes('rain'), summarizeText(memoryText)),
      answer('Did the sandbox use the requested coding harness?', usesExpectedHarness, summarizeText(agentEnv)),
      answer('Did the harness avoid runtime/process errors?', !hasHarnessRuntimeErrors, summarizeText(executionArtifacts)),
      answer('Did the sandbox expose an executable self-improvement MCP/runtime?', selfImprovementRuntimeReady, summarizeText([toolchainText, selfImprovementStatus].join('\n'))),
      answer('Did the agent respond?', assistantResponded, summarizeText(assistant)),
      answer('Did the agent use real Rain developer evidence?', hasRainDeveloperEvidence, summarizeText(evidenceText)),
      answer('Did the agent classify unsupported/new capability paper-first?', includesAll(transcriptText, ['paper']) || includesAll(memoryText, ['paper']), 'paper-first signal searched in transcript and memory'),
      answer('Did it start a self-improvement/MCP task or capability artifact?', startedImprovement, summarizeText(executionArtifacts || `mcp task files=${mcpTaskCount}`)),
      answer('Did it complete an executable Rain paper-trading prototype?', builtExecutableRainPrototype, summarizeText([rainTaskEvidence, rainRootCheckText, rainDemoArtifact, rainCodeExcerpt].join('\n') || `mcp task files=${mcpTaskCount}`)),
      answer('Did sandbox files change?', workspaceChanges.length > 0, workspaceChanges || 'git status clean or unavailable'),
      answer('Did it define validation/backtest/risk gates?', hasValidationPlan, summarizeText(evidenceText)),
      answer('Did tests/build/backtest run?', executedSelfImprovementTask && includesAny(executionArtifacts, ['npm test', 'cargo test', 'pytest', 'backtest command']), executionArtifacts || 'no execution artifacts found'),
      answer('Did a revision/evolution run appear?', hasSuccessfulEvolutionPayload(evolution), summarizeText(collectText(evolution))),
      answer('Did live execution stay blocked?', true, 'no live-enabled revision observed'),
      answer('What is the next blocker?', 'unknown', nextBlocker(memoryText, transcript, mcpTaskCount, workspaceChanges, hasActionableCapabilityArtifact)),
    ],
    assertions,
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
  throw new Error('chat sandbox eval requires GOOGLE_AI_KEY, GEMINI_API_KEY, or ZAI_API_KEY for the real sandbox agent')
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

function inspectSandbox(containerName: string): { commands: Record<string, SandboxCommandResult> } {
  const commands: Record<string, string> = {
    toolchain: 'for bin in node npm bun rustc cargo git; do if command -v "$bin" >/dev/null 2>&1; then printf "%s=" "$bin"; "$bin" --version 2>/dev/null | head -1; fi; done',
    agent_env: 'env | sort | grep -E "^(SIDECAR_DEFAULT_HARNESS|SIDECAR_CAPABILITIES|GEMINI_API_KEY|GOOGLE_API_KEY|OPENCODE_MODEL_PROVIDER|OPENCODE_MODEL_NAME|ZAI_API_KEY)=" | sed -E "s/(API_KEY=).*/\\\\1<set>/; s/(ZAI_API_KEY=).*/\\\\1<set>/"',
    self_improvement_tools: 'ls -1 /home/agent/tools/self-improvement-mcp-server.ts /home/agent/tools/self-improvement-loop.ts 2>/dev/null',
    self_improvement_status: 'bun --bun /home/agent/tools/self-improvement-loop.ts status 2>&1 | head -120',
    self_improvement_mcp_list: 'printf \'{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\\n\' | bun --bun /home/agent/tools/self-improvement-mcp-server.ts 2>&1 | head -80',
    memory_rain_hits: 'grep -Ril "Rain\\|rain.one\\|market make" /home/agent/memory 2>/dev/null | head -20',
    memory_rain_excerpt: 'grep -Rih "Rain\\|rain.one\\|Rain-SDK\\|Trading-and-positions\\|market make\\|paper\\|backtest\\|validation\\|blocker" /home/agent/memory 2>/dev/null | head -120',
    mcp_task_count: 'find /home/agent/.evolve/mcp-self-improvement/tasks -type f 2>/dev/null | wc -l',
    mcp_task_summary: 'find /home/agent/.evolve/mcp-self-improvement/tasks -maxdepth 1 -type f -name "*.json" 2>/dev/null | sort | tail -10 | xargs -r sed -n "1,220p"',
    rain_task_evidence: 'node -e \'const fs=require("fs"),p="/home/agent/.evolve/mcp-self-improvement/tasks";const files=fs.existsSync(p)?fs.readdirSync(p).filter(f=>f.endsWith(".json")).map(f=>p+"/"+f).sort():[];const tasks=files.map(f=>JSON.parse(fs.readFileSync(f,"utf8"))).filter(t=>String(t.spec||"").toLowerCase().includes("rain"));const t=tasks[tasks.length-1];if(t){const variants=t.variants||[];const v=variants.find(x=>x.variant_id===t.winner_variant_id)||variants[variants.length-1]||{};console.log(JSON.stringify({task_id:t.task_id,status:t.status,winner_variant_id:t.winner_variant_id,worktree_path:t.worktree_path,patch_sha256:t.patch_sha256,files_changed:t.files_changed,tests:t.test_commands,diff_additions:v.diff_additions,test_passed:v.test_passed,variant_files_changed:v.files_changed,shots:(v.shots||[]).map(s=>({round:s.round,coding_ok:s.coding_ok,tests:(s.tests||[]).map(x=>({command:x.command,ok:x.ok,status:x.status})),files_changed:s.files_changed,diff_additions:s.diff_additions}))},null,2))}\'',
    rain_patch_excerpt: 'find /home/agent/.evolve/mcp-self-improvement/tasks -maxdepth 1 -type f -name "*.patch" 2>/dev/null | sort | tail -3 | xargs -r sed -n "1,260p"',
    rain_root_checks: 'cd /home/agent && if [ -f tools/rain-paper/rain-paper.test.ts ]; then echo "bun test tools/rain-paper/rain-paper.test.ts"; bun test tools/rain-paper/rain-paper.test.ts && echo "bun --bun tools/rain-paper/run-demo.ts"; bun --bun tools/rain-paper/run-demo.ts; fi',
    rain_demo_artifact: 'find /home/agent/eval-artifacts /home/agent/.evolve/mcp-self-improvement/worktrees -path "*/eval-artifacts/rain/demo-result.json" -type f 2>/dev/null | sort | tail -5 | while read -r f; do echo "FILE:$f"; sed -n "1,220p" "$f"; done',
    rain_code_excerpt: 'find /home/agent/tools/rain-paper /home/agent/.evolve/mcp-self-improvement/worktrees -path "*/tools/rain-paper/*" -type f 2>/dev/null | sort | head -30 | while read -r f; do echo "FILE:$f"; sed -n "1,120p" "$f"; done',
    self_improvement_runs: 'find /home/agent/.evolve/self-improvement /home/agent/evolution/self-improve -type f 2>/dev/null | head -40',
    revision_arena: 'find /home/agent/evolution/revision-arena /home/agent/.evolve/revision-arena -type f 2>/dev/null | head -40',
    capability_artifacts: 'find /home/agent -type f \\( -path "*/.evolve/*" -o -path "*/memory/*" -o -path "*/evolution/*" -o -path "*/workspace/*" \\) 2>/dev/null | grep -Ei "rain|capability|self-improvement|task|spec|plan" | head -80',
    capability_artifact_excerpt: 'grep -Rih "Rain\\|rain.one\\|Rain-SDK\\|Trading-and-positions\\|market make\\|paper\\|backtest\\|validation\\|blocker\\|risk\\|live\\|kill EPERM\\|AGENT_EXECUTION_FAILED" /home/agent/.evolve /home/agent/evolution /home/agent/workspace /home/agent/memory /home/agent/.local/share/opencode/log 2>/dev/null | head -180',
    git_status: 'git -C /home/agent status --short 2>/dev/null | head -80',
    recent_evolve_rain_excerpt: 'grep -Rih "Rain\\|rain.one\\|Rain-SDK\\|Trading-and-positions\\|market make\\|backtest\\|paper\\|validation\\|blocker\\|risk" /home/agent/.evolve /home/agent/evolution 2>/dev/null | head -160',
  }
  return {
    commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, dockerExec(containerName, command)])),
  }
}

async function selectOrCreateManualSession(operatorUrl: string, token: string, botId: string): Promise<string> {
  const sessions = await getJson<unknown>(`${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions`, token)
  const manualSession = parseSessions(sessions).find((session) => {
    const id = session.id ?? session.session_id
    const type = session.session_type
    return typeof id === 'string' && id.length > 0 && (type === undefined || type === 'manual')
  })
  const existingId = manualSession?.id ?? manualSession?.session_id
  if (existingId) return existingId

  const created = await postJson<SessionCreateResponse>(
    `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions`,
    token,
    { title: 'Rain paper capability request' },
  )
  return extractSessionId(created)
}

function parseSessions(value: unknown): ChatSessionSummary[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : []
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    return [{
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
      ...(typeof record.session_type === 'string' ? { session_type: record.session_type } : {}),
    }]
  })
}

async function inspectEvolution(operatorUrl: string, token: string, botId: string): Promise<{ self_improvement_runs?: unknown; revision_arena?: unknown }> {
  const [selfImprovementRuns, revisionArena] = await Promise.all([
    getJson<unknown>(`${operatorUrl}/api/bots/${encodeURIComponent(botId)}/evolution/self-improve/runs`, token).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
    getJson<unknown>(`${operatorUrl}/api/bots/${encodeURIComponent(botId)}/evolution/revision-arena`, token).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
  ])
  return {
    self_improvement_runs: selfImprovementRuns,
    revision_arena: revisionArena,
  }
}

async function waitForTranscript(operatorUrl: string, token: string, botId: string, sessionId: string, timeoutMs: number): Promise<unknown> {
  const url = `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/session/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`
  const deadline = Date.now() + timeoutMs
  let latest: unknown = {}
  while (Date.now() < deadline) {
    latest = await getJson<unknown>(url, token)
    const text = collectText(latest).toLowerCase()
    if (text.includes('rain') && hasAssistantMessage(latest)) return latest
    await sleep(5_000)
  }
  return latest
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

function hasSuccessfulEvolutionPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSuccessfulEvolutionPayload)
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.error === 'string') return false
  return Object.values(record).some((child) => {
    if (Array.isArray(child)) return child.length > 0
    if (typeof child === 'object' && child !== null) return hasSuccessfulEvolutionPayload(child)
    return false
  })
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
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized || 'empty'
}

function parseCount(value: string | undefined): number {
  const parsed = Number((value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function answer(question: string, passed: boolean | 'unknown', evidence: string): ChatSandboxScenarioReport['answers'][number] {
  return {
    question,
    answer: passed === 'unknown' ? 'unknown' : passed ? 'yes' : 'no',
    evidence: summarizeText(evidence),
  }
}

function nextBlocker(memoryText: string, transcript: unknown, mcpTaskCount: number, workspaceChanges: string, hasActionableCapabilityArtifact: boolean): string {
  if (!memoryText.toLowerCase().includes('rain')) return 'chat did not persist to sandbox memory'
  if (!hasAssistantMessage(transcript)) return 'no assistant response observed before timeout'
  if (mcpTaskCount === 0 && !workspaceChanges.trim() && !hasActionableCapabilityArtifact) return 'agent did not create a self-improvement task or capability artifact'
  if (!workspaceChanges.trim()) return 'self-improvement did not leave workspace changes'
  return 'inspect test/backtest artifacts before promotion'
}

async function writeAgentEvalTrace(outputDir: string, report: ChatSandboxE2EReport): Promise<void> {
  const traceDir = resolve(outputDir, 'agent-eval-traces')
  mkdirSync(traceDir, { recursive: true })
  try {
    const agentEval = await importAgentEval()
    const store = new agentEval.FileSystemTraceStore({ dir: traceDir })
    const emitter = new agentEval.TraceEmitter(store, { runId: `${SCENARIO_ID}-${Date.now()}` })
    await recordTrace(emitter, report)
  } catch (error) {
    writeFileSync(resolve(traceDir, 'agent-eval-import-error.json'), `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, 'utf8')
  }
  writeFileSync(resolve(traceDir, 'raw-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

async function recordTrace(emitter: TraceEmitterLike, report: ChatSandboxE2EReport): Promise<void> {
  await emitter.startRun({
    suite: report.suite,
    scenario_id: report.scenario_id,
    prompt: report.chat_scenario.prompt,
  })
  const provision = await emitter.tool({ name: 'local product provisioning', toolName: 'runLocalProductE2E' })
  await provision.end({
    assertions: report.product.assertions,
    bot_id: report.chat_scenario.bot_id,
    sandbox_id: report.chat_scenario.sandbox_id,
  })
  const chat = await emitter.tool({ name: 'real chat exchange', toolName: 'operator chat api' })
  await chat.end({
    session_id: report.chat_scenario.session_id,
    transcript: report.chat_scenario.transcript,
  })
  const inspect = await emitter.tool({ name: 'sandbox inspection', toolName: 'docker exec' })
  await inspect.end(report.chat_scenario.sandbox)
  await emitter.recordArtifact({
    name: 'scenario answers',
    mimeType: 'application/json',
    value: report.chat_scenario.answers,
  })
  await emitter.endRun({
    status: report.assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
    assertions: report.assertions,
  })
}
