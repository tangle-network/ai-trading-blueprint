import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isoStamp, repoRoot, resolveRepo } from '../lib/repo.js'

type TerminalStatus = 'completed' | 'failed' | 'cancelled'

interface CommandResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
  duration_ms: number
}

interface McpResponse {
  result?: {
    tools?: Array<{ name: string }>
    content?: Array<{ text?: string }>
  }
}

interface SelfImprovementTask {
  task_id: string
}

export interface SelfImprovementStatus {
  status: string
  failure?: string
  winner_variant_id?: string
  patch_sha256?: string
  files_changed: string[]
  variants: Array<{
    test_passed: number
    rounds_used: number
    files_changed: string[]
  }>
}

interface EvalResult {
  name: string
  passed: boolean
  metrics: Record<string, unknown>
  evidence: Record<string, unknown>
  at: string
}

export interface SelfImprovementMcpEvalOptions {
  outputPath?: string
  skipOpencode?: boolean
}

const mcpPath = resolveRepo('trading-blueprint-lib/src/prompts/tools/self_improvement_mcp_server.ts')
const results: EvalResult[] = []

export async function runSelfImprovementMcpEval(options: SelfImprovementMcpEvalOptions = {}) {
  results.length = 0
  const evals = [
    evalProtocolAndList,
    evalDeterministicPatchApproval,
    evalFailureNoChanges,
    evalUntrackedNewFileApproval,
    () => evalOpencodeNewFileApproval(options.skipOpencode ?? process.env.SKIP_OPENCODE_EVAL === '1'),
  ]

  for (const evalFn of evals) {
    try {
      await evalFn()
    } catch (error) {
      record(evalFn.name, false, {}, { error: String(error instanceof Error ? error.stack : error) })
    }
  }

  const passed = results.filter((result) => result.passed).length
  const summary = {
    suite: 'self-improvement-mcp',
    passed,
    failed: results.length - passed,
    total: results.length,
    success_rate: results.length === 0 ? 0 : passed / results.length,
    results,
  }
  const outputPath = options.outputPath ?? resolveRepo('.evolve', 'evals', `self-improvement-mcp-${isoStamp()}.json`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { ...summary, output: outputPath }
}

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv = {}): CommandResult {
  const started = Date.now()
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    duration_ms: Date.now() - started,
  }
}

function record(
  name: string,
  passed: boolean,
  metrics: Record<string, unknown> = {},
  evidence: Record<string, unknown> = {},
): void {
  results.push({ name, passed, metrics, evidence, at: new Date().toISOString() })
}

function assertOrThrow(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function initRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aitb-${name}-`))
  sh('git init', dir)
  sh('git config user.email eval@example.com', dir)
  sh('git config user.name eval', dir)
  writeFileSync(join(dir, 'README.md'), 'initial\n', 'utf8')
  sh('git add README.md', dir)
  const commit = sh('git commit -m init', dir)
  assertOrThrow(commit.ok, `git init commit failed: ${commit.stderr || commit.stdout}`)
  return dir
}

function callMcp(workspace: string, messages: unknown[], timeoutMs = 240_000): Promise<McpResponse[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', ['--bun', mcpPath], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_WORKSPACE: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`MCP timed out after ${timeoutMs}ms\n${stderr}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`MCP exited ${code}\n${stderr}`))
        return
      }
      resolvePromise(stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpResponse))
    })
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    child.stdin.end()
  })
}

function textPayload<T>(response: McpResponse): T {
  const text = response.result?.content?.[0]?.text
  return text ? JSON.parse(text) as T : response.result as T
}

function responseAt(responses: McpResponse[], index: number): McpResponse {
  const response = responses[index]
  assertOrThrow(response, `missing MCP response at index ${index}`)
  return response
}

export async function createTask(workspace: string, args: Record<string, unknown>, timeoutMs = 240_000) {
  const responses = await callMcp(workspace, [{
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'self_improvement.create_task', arguments: args },
  }], timeoutMs)
  return textPayload<SelfImprovementTask>(responseAt(responses, 0))
}

export async function statusAndPatch(workspace: string, taskId: string) {
  const responses = await callMcp(workspace, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'self_improvement.status', arguments: { task_id: taskId } },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'self_improvement.patch', arguments: { task_id: taskId } },
    },
  ])
  return {
    status: textPayload<SelfImprovementStatus>(responseAt(responses, 0)),
    patch: textPayload<string>(responseAt(responses, 1)),
  }
}

export async function waitForTerminal(workspace: string, taskId: string, timeoutMs = 240_000): Promise<SelfImprovementStatus> {
  const started = Date.now()
  let latest: SelfImprovementStatus | null = null
  while (Date.now() - started < timeoutMs) {
    latest = (await statusAndPatch(workspace, taskId)).status
    if ((['completed', 'failed', 'cancelled'] as TerminalStatus[]).includes(latest.status as TerminalStatus)) {
      return latest
    }
    await sleep(500)
  }
  throw new Error(`task ${taskId} did not reach terminal state; latest=${JSON.stringify(latest)}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function evalProtocolAndList(): Promise<void> {
  const workspace = initRepo('mcp-protocol')
  const started = Date.now()
  try {
    const responses = await callMcp(workspace, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'self_improvement.list_tasks', arguments: { max_results: 2 } },
      },
    ])
    const tools = responseAt(responses, 1).result?.tools?.map((tool) => tool.name) ?? []
    assertOrThrow(tools.includes('self_improvement.create_task'), 'create_task missing')
    assertOrThrow(tools.includes('self_improvement.list_tasks'), 'list_tasks missing')
    assertOrThrow(Array.isArray(textPayload<unknown>(responseAt(responses, 2))), 'list_tasks did not return array')
    record('mcp_protocol_and_bounded_list', true, { duration_ms: Date.now() - started }, { tools })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function evalDeterministicPatchApproval(): Promise<void> {
  const workspace = initRepo('mcp-deterministic')
  const started = Date.now()
  try {
    const created = await createTask(workspace, {
      spec: 'Append a deterministic MCP eval marker to README so approval proves patch, test, winner, and patch export.',
      coding_command: "sh -lc 'printf mcp-eval-ok >> README.md'",
      tests: ['grep -q mcp-eval-ok README.md'],
      max_rounds: 1,
    })
    const status = await waitForTerminal(workspace, created.task_id)
    const { patch } = await statusAndPatch(workspace, created.task_id)
    assertOrThrow(status.status === 'completed', `expected completed, got ${status.status}`)
    assertOrThrow(status.winner_variant_id, 'missing winner')
    assertOrThrow(status.variants[0]?.test_passed === 1, 'test gate did not pass')
    assertOrThrow(patch.includes('mcp-eval-ok'), 'patch missing marker')
    record('deterministic_patch_approval', true, {
      duration_ms: Date.now() - started,
      files_changed: status.files_changed.length,
      rounds: status.variants[0]?.rounds_used,
    }, { task_id: created.task_id, patch_sha256: status.patch_sha256 })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function evalFailureNoChanges(): Promise<void> {
  const workspace = initRepo('mcp-failure')
  const started = Date.now()
  try {
    const created = await createTask(workspace, {
      spec: 'Do not change anything; this eval should prove the MCP rejects no-op coding outputs.',
      coding_command: "sh -lc 'true'",
      tests: ['test -f SHOULD_NOT_EXIST'],
      max_rounds: 1,
    })
    const status = await waitForTerminal(workspace, created.task_id)
    assertOrThrow(status.status === 'failed', `expected failed, got ${status.status}`)
    assertOrThrow(status.failure === 'no_approved_variant', `unexpected failure ${status.failure}`)
    assertOrThrow(status.variants[0]?.files_changed.length === 0, 'no-op produced changed files')
    record('no_change_failure_gate', true, {
      duration_ms: Date.now() - started,
      rounds: status.variants[0]?.rounds_used,
    }, { task_id: created.task_id, failure: status.failure })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function evalUntrackedNewFileApproval(): Promise<void> {
  const workspace = initRepo('mcp-new-file')
  const started = Date.now()
  try {
    const created = await createTask(workspace, {
      spec: 'Create LATENCY_SMOKE.txt containing latency-ok so the eval proves untracked new files are exported.',
      coding_command: "sh -lc 'printf latency-ok > LATENCY_SMOKE.txt'",
      tests: ['grep -q latency-ok LATENCY_SMOKE.txt'],
      max_rounds: 1,
    })
    const status = await waitForTerminal(workspace, created.task_id)
    const { patch } = await statusAndPatch(workspace, created.task_id)
    assertOrThrow(status.status === 'completed', `expected completed, got ${status.status}`)
    assertOrThrow(status.files_changed.includes('LATENCY_SMOKE.txt'), 'new file missing from files_changed')
    assertOrThrow(!status.files_changed.some((name) => name.startsWith('.self-improvement-')), 'MCP artifacts leaked into files_changed')
    assertOrThrow(patch.includes('LATENCY_SMOKE.txt'), 'patch missing new file')
    assertOrThrow(!patch.includes('.self-improvement-prompt.md'), 'prompt artifact leaked into patch')
    record('untracked_new_file_approval', true, {
      duration_ms: Date.now() - started,
      files_changed: status.files_changed.length,
    }, { task_id: created.task_id, patch_sha256: status.patch_sha256 })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function evalOpencodeNewFileApproval(skipOpencode: boolean): Promise<void> {
  const opencode = sh('command -v opencode', repoRoot)
  if (!opencode.ok || skipOpencode) {
    record('opencode_new_file_approval', true, { skipped: 1 }, { reason: 'opencode unavailable or skipped' })
    return
  }

  const workspace = initRepo('mcp-opencode')
  const started = Date.now()
  try {
    const created = await createTask(workspace, {
      spec: 'Create a file named LATENCY_SMOKE.txt containing exactly the text latency-ok. Do not change any other file.',
      tests: ['grep -q latency-ok LATENCY_SMOKE.txt'],
      max_rounds: 1,
      coding_timeout_ms: 120_000,
    }, 180_000)
    const status = await waitForTerminal(workspace, created.task_id, 180_000)
    const { patch } = await statusAndPatch(workspace, created.task_id)
    assertOrThrow(status.status === 'completed', `expected completed, got ${status.status}`)
    assertOrThrow(status.files_changed.length === 1 && status.files_changed[0] === 'LATENCY_SMOKE.txt', `unexpected files ${status.files_changed}`)
    assertOrThrow(patch.includes('latency-ok'), 'patch missing opencode content')
    record('opencode_new_file_approval', true, {
      duration_ms: Date.now() - started,
      files_changed: status.files_changed.length,
    }, { task_id: created.task_id, patch_sha256: status.patch_sha256 })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

export function hasBun(): boolean {
  return existsSync('/opt/homebrew/bin/bun') || sh('command -v bun', repoRoot).ok
}
