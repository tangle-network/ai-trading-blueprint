import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isoStamp, resolveRepo } from '../lib/repo.js'

interface TemplateCase {
  file: string
  sourceFile: string
  decisionExport: string
  expectedDecisionAction: string
  expectedRunAction: string
  fixture: Record<string, unknown>
}

interface Assertion {
  subject: string
  passed: boolean
  message: string
  detail?: unknown
}

export interface StrategyTemplateEvalSummary {
  suite: 'strategy-templates'
  output: string
  total: number
  passed: number
  failed: number
  assertions: Assertion[]
}

const templateCases: TemplateCase[] = [
  {
    file: 'market-maker.js',
    sourceFile: 'market_maker.js',
    decisionExport: 'decideMarketMaker',
    expectedDecisionAction: 'quote',
    expectedRunAction: 'quote',
    fixture: { bid: 0.48, ask: 0.52, inventory: 0, maxInventory: 10, minSpreadBps: 50, orderUsd: 100 },
  },
  {
    file: 'momentum-breakout.js',
    sourceFile: 'momentum_breakout.js',
    decisionExport: 'decideMomentum',
    expectedDecisionAction: 'trade',
    expectedRunAction: 'paper_validated',
    fixture: { closes: [100, 101, 102, 104], tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '500000000' },
  },
  {
    file: 'mean-reversion.js',
    sourceFile: 'mean_reversion.js',
    decisionExport: 'decideMeanReversion',
    expectedDecisionAction: 'trade',
    expectedRunAction: 'paper_validated',
    fixture: {
      prices: [100, 101, 100.5, 99.8, 100.2, 101.1, 100.4, 97.8],
      assetToken: 'WETH',
      cashToken: 'USDC',
      amountIn: '300000000',
    },
  },
  {
    file: 'portfolio-rebalance.js',
    sourceFile: 'portfolio_rebalance.js',
    decisionExport: 'decideRebalance',
    expectedDecisionAction: 'trade',
    expectedRunAction: 'trade',
    fixture: {
      totalUsd: 10_000,
      weights: { WETH: 0.35, USDC: 0.65 },
      targetWeights: { WETH: 0.5, USDC: 0.5 },
      cashToken: 'USDC',
    },
  },
  {
    file: 'risk-off-guard.js',
    sourceFile: 'risk_off_guard.js',
    decisionExport: 'decideRiskOff',
    expectedDecisionAction: 'risk_off',
    expectedRunAction: 'risk_off',
    fixture: { drawdownPct: 6, volatilityPct: 4, lossStreak: 1 },
  },
]

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(raw.length > 0 ? JSON.parse(raw) : {})
      } catch {
        resolveBody({})
      }
    })
  })
}

async function withFakeTradingApi<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    await readBody(req)

    if (path === '/circuit-breaker/check') return respond(res, 200, { should_break: false })
    if (path === '/validate') return respond(res, 200, { approved: true, aggregate_score: 1, validator_responses: [] })
    if (path === '/execute') return respond(res, 200, { ok: true, tx_hash: '0xstrategytemplatepaper' })
    if (path === '/portfolio/state') return respond(res, 200, { total_value_usd: '10000', positions: [] })
    if (path === '/market-data/prices') return respond(res, 200, { prices: { WETH: 3000, USDC: 1 } })
    if (path === '/supported-assets') return respond(res, 200, { assets: [{ symbol: 'WETH' }, { symbol: 'USDC' }] })
    return respond(res, 404, { error: `unexpected path ${path}` })
  })

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind fake trading API')

  try {
    return await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    })
  }
}

function assert(assertions: Assertion[], subject: string, passed: boolean, message: string, detail?: unknown): void {
  assertions.push({ subject, passed, message, ...(detail === undefined ? {} : { detail }) })
}

function copySandboxTools(workspace: string): void {
  const toolsDir = join(workspace, 'tools')
  mkdirSync(join(toolsDir, 'strategies', 'templates'), { recursive: true })
  cpSync(resolveRepo('trading-blueprint-lib/src/prompts/tools/api_client.js'), join(toolsDir, 'api-client.js'))
  cpSync(resolveRepo('trading-blueprint-lib/src/prompts/tools/strategy_sdk.js'), join(toolsDir, 'strategy-sdk.js'))
  cpSync(resolveRepo('trading-blueprint-lib/src/prompts/tools/run_strategy.js'), join(toolsDir, 'run-strategy.js'))
  for (const template of templateCases) {
    cpSync(
      resolveRepo(`trading-blueprint-lib/src/prompts/tools/strategy_templates/${template.sourceFile}`),
      join(toolsDir, 'strategies', 'templates', template.file),
    )
  }
}

function runTemplate(workspace: string, template: TemplateCase): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      'node',
      [join(workspace, 'tools', 'run-strategy.js'), join(workspace, 'tools', 'strategies', 'templates', template.file)],
      {
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENT_HOME: workspace,
          TRADING_API_CONFIG: join(workspace, 'config', 'api.json'),
        },
      },
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`${template.file} timed out`))
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ status: code ?? 1, stdout, stderr })
    })
  })
}

export async function runStrategyTemplateEval(options: { outputPath?: string } = {}): Promise<StrategyTemplateEvalSummary> {
  const output = resolve(options.outputPath ?? resolveRepo(`.evolve/evals/strategy-templates-${isoStamp()}.json`))
  const assertions: Assertion[] = []
  const workspace = mkdtempSync(join(tmpdir(), 'strategy-template-eval-'))
  copySandboxTools(workspace)
  mkdirSync(join(workspace, 'config'), { recursive: true })

  await withFakeTradingApi(async (apiUrl) => {
    for (const template of templateCases) {
      const requireFromWorkspace = createRequire(join(workspace, 'eval.cjs'))
      const modulePath = join(workspace, 'tools', 'strategies', 'templates', template.file)
      const strategy = requireFromWorkspace(modulePath) as Record<string, unknown>
      const decide = strategy[template.decisionExport]
      assert(assertions, `${template.file}:export`, typeof decide === 'function', `${template.decisionExport} is exported`)

      if (typeof decide === 'function') {
        const decision = decide(template.fixture) as { action?: string }
        assert(
          assertions,
          `${template.file}:decision`,
          decision.action === template.expectedDecisionAction,
          `expected decision action ${template.expectedDecisionAction}`,
          decision,
        )
      }

      writeFileSync(
        join(workspace, 'config', 'api.json'),
        `${JSON.stringify({
          api_url: apiUrl,
          token: 'strategy-template-eval-token',
          bot_id: 'strategy-template-eval',
          paper_trade: true,
          strategy_config: {
            paper_trade: true,
            strategy_type: 'strategy_template_eval',
            template_fixture: template.fixture,
            template_dry_run: true,
            supported_assets: [
              { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' },
              { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
            ],
          },
        }, null, 2)}\n`,
      )

      const run = await runTemplate(workspace, template)
      assert(assertions, `${template.file}:process`, run.status === 0, 'template tick exits successfully', run)
      if (run.status === 0) {
        const parsed = JSON.parse(run.stdout.trim()) as { ok?: boolean; decision?: { action?: string } }
        assert(assertions, `${template.file}:ok`, parsed.ok === true, 'run-strategy reports ok', parsed)
        assert(
          assertions,
          `${template.file}:run-action`,
          parsed.decision?.action === template.expectedRunAction,
          `expected run action ${template.expectedRunAction}`,
          parsed,
        )
      }

      assert(
        assertions,
        `${template.file}:artifact-dir`,
        existsSync(join(workspace, 'eval-artifacts', 'strategies')),
        'strategy wrote artifact directory',
      )
    }
  })

  const logPath = join(workspace, 'logs', 'strategy-runs.jsonl')
  const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : []
  assert(assertions, 'strategy-runs:jsonl', logLines.length >= templateCases.length, 'strategy decisions are logged')

  const failed = assertions.filter((item) => !item.passed).length
  const summary: StrategyTemplateEvalSummary = {
    suite: 'strategy-templates',
    output,
    total: assertions.length,
    passed: assertions.length - failed,
    failed,
    assertions,
  }
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}
