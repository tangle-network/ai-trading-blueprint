import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { repoRoot } from '../lib/repo.js'
import { runProductBrowserEval, type ProductBrowserEvalReport } from './browser-driver.js'

const DEFAULT_E2E_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538c9c9d5e636d8d43c4f88e4a70e58b332a'

export interface LocalProductE2EOptions {
  baseUrl?: string
  operatorUrl?: string
  outputPath?: string
  outputDir?: string
  startStack?: boolean
  keepStack?: boolean
  maxTurns?: number
}

export interface LocalProductE2EReport {
  suite: 'arena-real-local-product-e2e'
  base_url: string
  operator_url: string
  output_dir: string
  storage_state: string
  browser: ProductBrowserEvalReport
  assertions: Array<{ name: string; passed: boolean; detail: string }>
}

export async function runLocalProductE2E(options: LocalProductE2EOptions = {}): Promise<LocalProductE2EReport> {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.ARENA_EVAL_BASE_URL ?? 'http://127.0.0.1:1337')
  const operatorUrl = trimTrailingSlash(options.operatorUrl ?? `${baseUrl}/operator-api`)
  const outputDir = resolve(repoRoot, options.outputDir ?? `.evolve/evals/local-product-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(outputDir, { recursive: true })

  preflight()

  const privateKey = process.env.ARENA_E2E_PRIVATE_KEY ?? DEFAULT_E2E_PRIVATE_KEY
  const address = cast(['wallet', 'address', privateKey]).toLowerCase()
  let stack: ChildProcessWithoutNullStreams | null = null
  try {
    if (options.startStack ?? true) {
      stack = startDevnet(address, outputDir)
    }

    await waitForJson(`${baseUrl}/operator-api/api/meta`, 900_000, stack, outputDir)
    await waitForJson(`${baseUrl}/instance-operator-api/api/meta`, 180_000, stack, outputDir)

    const session = await createOperatorSession(operatorUrl, privateKey)
    const storageState = writeStorageState(baseUrl, address, session.token, session.expires_at, outputDir)
    const beforeBots = await listBots(operatorUrl, session.token)
    const beforeProvisions = await listProvisions(operatorUrl)
    const intent = `Local E2E ${Date.now()}: create a conservative ETH/USDC Uniswap paper trading agent. Research momentum and mean reversion, backtest before live trading, and propose self-improvements only after validation.`

    const browser = runProductBrowserEval({
      baseUrl,
      outputDir: resolve(outputDir, 'bad'),
      runBad: true,
      realProvision: true,
      realProvisionIntent: intent,
      storageStatePath: storageState,
      maxTurns: options.maxTurns ?? 32,
    })

    const after = await waitForProvisionDelta(operatorUrl, session.token, beforeBots.ids, beforeProvisions.callIds, 240_000)
    const assertions = [
      {
        name: 'browser agent completed create flow',
        passed: browser.failed === 0,
        detail: `${browser.passed}/${browser.total} BAD cases passed`,
      },
      {
        name: 'operator recorded a new bot',
        passed: after.newBotIds.length > 0,
        detail: after.newBotIds.join(', ') || 'no new bot ids',
      },
      {
        name: 'operator recorded provision progress',
        passed: after.newProvisionCallIds.length > 0,
        detail: after.newProvisionCallIds.join(', ') || 'no new provision call ids',
      },
    ]

    const report: LocalProductE2EReport = {
      suite: 'arena-real-local-product-e2e',
      base_url: baseUrl,
      operator_url: operatorUrl,
      output_dir: outputDir,
      storage_state: storageState,
      browser,
      assertions,
    }
    const outputPath = resolve(repoRoot, options.outputPath ?? `${outputDir}/report.json`)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    if (assertions.some((assertion) => !assertion.passed)) {
      throw new Error(`local product e2e failed: ${assertions.map((a) => `${a.name}=${a.passed}`).join(', ')}`)
    }
    return report
  } finally {
    if (stack && !options.keepStack) {
      stack.kill('SIGTERM')
      await sleep(1_000)
      if (!stack.killed) stack.kill('SIGKILL')
    }
  }
}

function preflight(): void {
  for (const command of ['anvil', 'forge', 'cast', 'docker', 'bad', 'pnpm']) {
    const found = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' })
    if (found.status !== 0) throw new Error(`Missing required command on PATH: ${command}`)
  }
  const docker = spawnSync('docker', ['info'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (docker.status !== 0) throw new Error(`Docker is not reachable:\n${docker.stderr}`)

  const image = process.env.SIDECAR_IMAGE ?? 'blueprint-sidecar:all-harness'
  const pullEnabled = process.env.SIDECAR_PULL_IMAGE === 'true'
  const localImage = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (localImage.status !== 0) {
    const remoteHint = pullEnabled ? ' The operator may pull remote images, but this eval requires a pre-pulled image so failures are caught before the full devnet starts.' : ''
    throw new Error(`Missing local sidecar image ${image}. Build or pull it before running the real product E2E.${remoteHint}`)
  }
}

function startDevnet(e2eAddress: string, outputDir: string): ChildProcessWithoutNullStreams {
  const logPath = resolve(outputDir, 'run-devnet.log')
  const child = spawn('bash', ['scripts/run-devnet.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      START_VALIDATOR: process.env.START_VALIDATOR ?? 'false',
      SESSION_AUTH_SECRET: process.env.SESSION_AUTH_SECRET ?? 'dev-secret-key-do-not-use-in-production',
      VITE_OPERATOR_E2E_AUTH_ADDRESS: e2eAddress,
      SIDECAR_PULL_IMAGE: process.env.SIDECAR_PULL_IMAGE ?? 'false',
    },
  })
  const append = (chunk: Buffer) => {
    writeFileSync(logPath, chunk, { flag: 'a' })
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.on('exit', (code, signal) => {
    writeFileSync(logPath, `\nrun-devnet exited code=${code} signal=${signal}\n`, { flag: 'a' })
  })
  return child
}

async function createOperatorSession(operatorUrl: string, privateKey: string): Promise<{ token: string; expires_at: number }> {
  const challenge = await postJson<{ nonce: string; message: string }>(`${operatorUrl}/api/auth/challenge`, {})
  const signature = cast(['wallet', 'sign', '--private-key', privateKey, challenge.message])
  return postJson<{ token: string; expires_at: number }>(`${operatorUrl}/api/auth/session`, {
    nonce: challenge.nonce,
    signature,
  })
}

function writeStorageState(baseUrl: string, address: string, token: string, expiresAt: number, outputDir: string): string {
  const apiUrl = '/operator-api'
  const key = `arena.operator_auth.${address.toLowerCase()}::${apiUrl}`
  const path = resolve(outputDir, 'browser-storage-state.json')
  writeFileSync(path, `${JSON.stringify({
    cookies: [],
    origins: [
      {
        origin: new URL(baseUrl).origin,
        localStorage: [
          {
            name: key,
            value: JSON.stringify({ token, expiresAt }),
          },
        ],
      },
    ],
  }, null, 2)}\n`, 'utf8')
  return path
}

async function listBots(operatorUrl: string, token: string): Promise<{ ids: Set<string> }> {
  const json = await getJson<unknown>(`${operatorUrl}/api/bots?limit=200`, token)
  const bots = Array.isArray((json as { bots?: unknown[] }).bots) ? (json as { bots: unknown[] }).bots : []
  return {
    ids: new Set(bots.map((bot) => (bot as { id?: unknown }).id).filter((id): id is string => typeof id === 'string')),
  }
}

async function listProvisions(operatorUrl: string): Promise<{ callIds: Set<string> }> {
  const json = await getJson<unknown>(`${operatorUrl}/api/provisions`)
  const provisions = Array.isArray((json as { provisions?: unknown[] }).provisions) ? (json as { provisions: unknown[] }).provisions : []
  return {
    callIds: new Set(provisions.map((item) => String((item as { call_id?: unknown }).call_id ?? '')).filter(Boolean)),
  }
}

async function waitForProvisionDelta(
  operatorUrl: string,
  token: string,
  beforeBotIds: Set<string>,
  beforeProvisionCallIds: Set<string>,
  timeoutMs: number,
): Promise<{ newBotIds: string[]; newProvisionCallIds: string[] }> {
  const deadline = Date.now() + timeoutMs
  let latest = { newBotIds: [] as string[], newProvisionCallIds: [] as string[] }
  while (Date.now() < deadline) {
    const bots = await listBots(operatorUrl, token)
    const provisions = await listProvisions(operatorUrl)
    latest = {
      newBotIds: [...bots.ids].filter((id) => !beforeBotIds.has(id)),
      newProvisionCallIds: [...provisions.callIds].filter((id) => !beforeProvisionCallIds.has(id)),
    }
    if (latest.newBotIds.length > 0 && latest.newProvisionCallIds.length > 0) return latest
    await sleep(5_000)
  }
  return latest
}

async function waitForJson(
  url: string,
  timeoutMs: number,
  stack: ChildProcessWithoutNullStreams | null = null,
  outputDir?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const exitedStack = stack && (stack.exitCode !== null || stack.signalCode !== null) ? stack : null
    if (exitedStack) {
      const logPath = outputDir ? resolve(outputDir, 'run-devnet.log') : undefined
      const tail = logPath && existsSync(logPath)
        ? readFileSync(logPath, 'utf8').split('\n').slice(-80).join('\n')
        : ''
      throw new Error(`Devnet exited before ${url} was ready. code=${exitedStack.exitCode} signal=${exitedStack.signalCode}${logPath ? ` log=${logPath}` : ''}\n${tail}`)
    }
    try {
      const res = await fetch(url)
      last = await res.text()
      if (res.ok) {
        JSON.parse(last)
        return
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(1_000)
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`)
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const init: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {}
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`GET ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

function cast(args: string[]): string {
  const result = spawnSync('cast', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`cast ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
