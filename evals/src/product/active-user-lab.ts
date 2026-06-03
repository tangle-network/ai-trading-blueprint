import { activeUserLabPromptProfile } from '../profiles/active-user-lab.js'
import { runProfileJson } from '../sim/llm-call.js'
import {
  deterministicAgentEnv,
  lastAssistantId,
  OperatorClient,
} from '../sim/operator-client.js'
import type { StrategyType } from '../sim/strategy-type.js'

export const DEFAULT_REPO = 'tangle-network/ai-trading-blueprint'
export const DEFAULT_LIN_LOGIN = 'vutuanlinh2k2'
export const DEFAULT_OPERATOR_URL = 'https://178.104.232.124.sslip.io'
export const DEFAULT_APP_URL = 'https://trading-arena.blueprint.tangle.tools'

export type CoverageStatus = 'covered' | 'partial' | 'gap'

export interface LabIssue {
  number: number
  title: string
  body: string
  url: string
  author: string
  assignees: string[]
  labels: string[]
}

export interface LabBot {
  id: string
  name: string
  strategy_type: string | null
  prompt: string | null
  paper_trade: boolean | null
  sandbox_id: string | null
  vault_address: string | null
  created_at: number | string | null
  strategy_config: unknown
}

export interface BotEvidence {
  recentRun: {
    status: string
    workflowKind: string
    startedAt: number | string | null
    transcriptAvailable: boolean | null
  } | null
  recentTrade: {
    timestamp: string
    action: string
    targetProtocol: string
    notionalUsd: string
    executionStatus: string
  } | null
}

export interface IssueScenario {
  issueNumber: number
  key: string
  expectedSurface: string
  exactMatchers: string[]
  exactMatchMode?: 'any' | 'all'
  partialMatchers: string[]
  staticPrompts: string[]
  freshBot?: FreshBotSpec | undefined
}

export interface FreshBotSpec {
  strategyType: StrategyType
  name: string
  prompt: string
}

export interface IssueCoverageCandidate {
  bot: LabBot
  score: number
  exact: boolean
  evidence: BotEvidence | null
}

export interface IssueCoverage {
  issue: LabIssue
  scenario: IssueScenario
  status: CoverageStatus
  reason: string
  candidates: IssueCoverageCandidate[]
}

export interface AuditOptions {
  repo?: string | undefined
  linLogin?: string | undefined
  operatorUrl?: string | undefined
  githubToken?: string | undefined
  includeEvidence?: boolean | undefined
  fetchImpl?: typeof fetch | undefined
}

export interface AuditResult {
  repo: string
  linLogin: string
  operatorUrl: string
  issues: LabIssue[]
  bots: LabBot[]
  coverage: IssueCoverage[]
}

export interface DispatchOptions extends AuditOptions {
  appUrl?: string | undefined
  token?: string | undefined
  privateKey?: string | undefined
  issueNumbers?: number[] | undefined
  botId?: string | undefined
  turns?: number | undefined
  watch?: boolean | undefined
  replyTimeoutMs?: number | undefined
  pollIntervalMs?: number | undefined
  prompts?: string[] | undefined
  generateIdeas?: boolean | undefined
  configureSecrets?: boolean | undefined
  freshBot?: boolean | undefined
  dryRun?: boolean | undefined
}

export interface DispatchResult {
  issueNumber: number
  issueTitle: string
  botId: string
  botName: string
  sessionId: string
  chatUrl: string
  prompts: string[]
  replies: Array<{ prompt: string; reply: string; endedBy: 'reply' | 'timeout' | 'skipped' }>
}

const DEFAULT_DISPATCH_ISSUES = [57, 46, 45, 41, 9]

export const ISSUE_SCENARIOS: IssueScenario[] = [
  {
    issueNumber: 57,
    key: 'hyperliquid-perp-envelope',
    expectedSurface: 'Hyperliquid perp bot with dedicated perp envelope state',
    exactMatchers: ['strategy:hyperliquid_perp'],
    partialMatchers: ['hyperliquid perp', 'hyperliqu perp', 'hyperliquid', 'strategy:perp', 'perp'],
    freshBot: {
      strategyType: 'hyperliquid_perp',
      name: 'QA Hyperliquid ETH perp envelope',
      prompt: 'QA issue #57: create a paper Hyperliquid ETH-PERP agent focused on dedicated perp envelope evidence, account equity, margin, leverage, position scope, max order notional, and fail-closed risk gates. Do not execute live funds.',
    },
    staticPrompts: [
      'Inspect your current perp venue/envelope setup. Are you operating as a Hyperliquid perp agent, and what exact paper-safe risk envelope would block live execution today?',
      'Compare the current perp envelope to what a dedicated Hyperliquid model should expose: account equity, margin, leverage, position, order intent, and venue-specific failure modes.',
      'Summarize the evidence a user should see in Chat, Runs, Portfolio, and executions to know this Hyperliquid perp path is real rather than a generic perp placeholder.',
    ],
  },
  {
    issueNumber: 46,
    key: 'cross-strategy-allocation',
    expectedSurface: 'Cross-strategy / multi-strategy allocation bot',
    exactMatchers: ['strategy:multi', 'cross-strategy', 'diversified'],
    partialMatchers: ['strategy:yield', 'strategy:dex', 'strategy:mm'],
    freshBot: {
      strategyType: 'multi',
      name: 'QA cross-strategy allocation',
      prompt: 'QA issue #46: create a paper cross-strategy allocation agent that compares prediction, yield, perps, and DEX opportunities, enforces no-unsupported-execution guardrails, logs allocation/no-rebalance reasoning, and exposes sub-strategy decisions. Do not execute live funds.',
    },
    staticPrompts: [
      'Inspect your current allocation policy as a cross-strategy bot. What target weights, rebalance band, venues, and paper risk limits are active right now?',
      'Challenge a drift case: one leg is overweight and another venue has stale liquidity. What should you do, and what exact guard blocks a bad rebalance?',
      'Describe what the product should show after your next paper tick so a user can verify allocations, fills, and risk decisions without reading logs.',
    ],
  },
  {
    issueNumber: 45,
    key: 'market-making-inventory',
    expectedSurface: 'Market-making bot with spread and inventory behavior',
    exactMatchers: ['strategy:mm', 'market making', 'market-making'],
    partialMatchers: ['aerodrome', 'uniswap', 'dex'],
    freshBot: {
      strategyType: 'mm',
      name: 'QA Aerodrome ETH/USDC market maker',
      prompt: 'QA issue #45: create a paper market-making agent for ETH/USDC on Aerodrome or Uniswap-style DEX venues. Track fair value, spread, inventory skew, quote/no-quote decisions, paper-only guardrails, and fill reasoning. Do not execute live funds.',
    },
    staticPrompts: [
      'Inspect your market-making state: pair, venue, spread/band, target inventory, paper equity, and the next quote or no-quote decision.',
      'Stress the inventory edge case: inventory is far from target and the spread narrows. What do you quote, what do you refuse, and why?',
      'Summarize which values need to be visible in the UI for a market-making user: bid/ask intent, inventory skew, fill, notional, slippage, PnL, and validation.',
    ],
  },
  {
    issueNumber: 44,
    key: 'volatility-strategy',
    expectedSurface: 'Volatility strategy bot',
    exactMatchers: ['strategy:volatility', 'volatility', 'variance', 'vol surface'],
    partialMatchers: ['perp', 'dex', 'momentum'],
    freshBot: {
      strategyType: 'volatility',
      name: 'QA volatility paper strategy',
      prompt: 'QA issue #44: create a paper volatility strategy agent that inspects realized versus implied volatility proxies, funding rates, market spreads, delta-hedging assumptions, paper-only guardrails, and no-trade reasoning. Do not execute live funds.',
    },
    staticPrompts: [
      'Inspect whether you are actually configured as a volatility strategy. If not, say exactly which configuration fields are missing.',
      'Design the paper-safe volatility decision you would need: signal window, realized/implied vol input, position sizing, max loss, and stop condition.',
      'List the UI evidence needed before this can be considered covered by a real bot rather than a placeholder.',
    ],
  },
  {
    issueNumber: 43,
    key: 'gmx-vertex-perp',
    expectedSurface: 'GMX and Vertex perpetual strategy bot',
    exactMatchers: ['gmx', 'vertex'],
    exactMatchMode: 'all',
    partialMatchers: ['strategy:perp', 'perp', 'hyperliquid'],
    freshBot: {
      strategyType: 'perp',
      name: 'QA GMX Vertex perp paper strategy',
      prompt: 'QA issue #43: create a paper GMX and Vertex perpetual futures strategy on Arbitrum. Inspect funding, price, margin, leverage, order type, validator rejection, no-trade decisions, and venue API failures. Do not use Hyperliquid native execution and do not execute live funds.',
    },
    staticPrompts: [
      'Inspect your perp venue coverage. Are GMX or Vertex actually configured, or are you only covering a generic/Hyperliquid perp path?',
      'For a GMX/Vertex paper perp test, specify the venue fields, margin inputs, order type, risk limits, and failure states the product must expose.',
      'State whether this issue is testable with your current bot. If partial only, give the smallest concrete bot config needed to make it exact.',
    ],
  },
  {
    issueNumber: 41,
    key: 'polymarket-clob',
    expectedSurface: 'Polymarket / prediction market CLOB bot',
    exactMatchers: ['strategy:prediction', 'polymarket', 'prediction market', 'clob'],
    partialMatchers: ['market', 'order book'],
    freshBot: {
      strategyType: 'prediction',
      name: 'QA Polymarket CLOB paper trader',
      prompt: 'QA issue #41: create a paper Polymarket prediction-market CLOB agent. Track market discovery, outcome, order book, limit price, collateral cap, order intent, validation rejection, and paper/live status. Do not execute live funds.',
    },
    staticPrompts: [
      'Inspect your prediction-market setup: market, outcome, CLOB assumptions, paper order intent, risk limits, and missing live credentials.',
      'Challenge the stale-order case: market odds move sharply after you decide. What should the bot cancel, resize, or refuse?',
      'Describe the exact chat/runs/execution fields needed to prove a Polymarket CLOB flow is real: outcome, side, limit price, size, order id, status, and validation.',
    ],
  },
  {
    issueNumber: 17,
    key: 'production-ready-checklist',
    expectedSurface: 'Fleet-level production QA checklist',
    exactMatchers: ['strategy:mm', 'strategy:multi', 'strategy:dex', 'strategy:yield', 'strategy:prediction', 'strategy:perp'],
    partialMatchers: ['trading'],
    freshBot: {
      strategyType: 'multi',
      name: 'QA production readiness multi-strategy',
      prompt: 'QA issue #17: create a paper production-readiness smoke agent that checks paper/live mode, secrets, venue access, risk gates, recent runs, recent fills, and user-visible evidence across the trading arena. Do not execute live funds.',
    },
    staticPrompts: [
      'Act as a production QA user. Inspect your current readiness: paper/live mode, secrets, venue access, risk gates, recent runs, and recent fills.',
      'Name the top three production blockers that would matter to a real trading user and the exact UI evidence that should prove each blocker is resolved.',
      'Summarize whether you should be included in a production-ready fleet smoke and why.',
    ],
  },
  {
    issueNumber: 16,
    key: 'vault-collateral-admin',
    expectedSurface: 'Vault collateral admin cap/write-down workflow',
    exactMatchers: ['collateral-admin-workflow'],
    partialMatchers: ['vault', 'factory:', 'paper', 'collateral', 'write-down', 'writedown', 'cap setting'],
    staticPrompts: [
      'Inspect your vault/collateral context. What cap, collateral, vault address, and paper/live constraints can you actually observe?',
      'Challenge an admin write-down scenario. Which actor, authorization, accounting values, and audit trail must exist before this is safe?',
      'State whether this bot can test vault collateral admin today, or whether we only have a partial paper/vault placeholder.',
    ],
  },
  {
    issueNumber: 9,
    key: 'trade-history-validator-reasoning',
    expectedSurface: 'Trade history with validator reasoning',
    exactMatchers: ['strategy:mm', 'strategy:multi', 'strategy:dex', 'strategy:yield'],
    partialMatchers: ['strategy:prediction', 'strategy:perp'],
    freshBot: {
      strategyType: 'mm',
      name: 'QA trade history validator reasoning',
      prompt: 'QA issue #9: create a paper agent for trade-history and validator-reasoning QA. The bot should make fill-to-decision-to-validation evidence explicit across chat, runs, portfolio, and executions. Do not execute live funds.',
    },
    staticPrompts: [
      'Inspect your recent trade history and validator reasoning. Which fields prove the last paper fill was valid, priced, and risk-approved?',
      'Find any missing reasoning fields. If agent reasoning is null or generic, say what should have been recorded and where.',
      'Tell us how Chat, Runs, Portfolio, and executions should cross-link so a user can go from fill to decision to validation without guessing.',
    ],
  },
  {
    issueNumber: 7,
    key: 'tee-confidential-bot',
    expectedSurface: 'TEE / confidential bot provisioning and runtime lock',
    exactMatchers: ['tee', 'confidential'],
    partialMatchers: ['sandbox', 'runtime', 'secrets'],
    staticPrompts: [
      'Inspect whether you are a TEE/confidential bot. If not, identify the missing runtime proof, lock state, and provisioning evidence.',
      'Specify the minimum TEE wizard and runtime-lock evidence a user needs before trusting this bot with sensitive strategy data.',
      'State whether this fleet has an exact TEE test bot or only ordinary sandbox coverage.',
    ],
  },
  {
    issueNumber: 3,
    key: 'leaderboard-rankings-filtering',
    expectedSurface: 'Public leaderboard rankings and filtering',
    exactMatchers: ['strategy:mm', 'strategy:multi', 'strategy:dex', 'strategy:yield', 'strategy:prediction', 'strategy:perp'],
    partialMatchers: ['trading'],
    freshBot: {
      strategyType: 'multi',
      name: 'QA leaderboard ranking candidate',
      prompt: 'QA issue #3: create a paper leaderboard QA agent whose status, strategy, return, PnL, volume, drawdown, fills, and paper/live mode can be compared against other public agents. Do not execute live funds.',
    },
    staticPrompts: [
      'As a public leaderboard candidate, summarize the fields that should rank you: return, PnL, volume, drawdown, fills, status, strategy, and paper/live mode.',
      'Challenge the filtering case: how should users compare you against bots from other strategies without misleading rankings?',
      'Name the missing or stale leaderboard fields that would make this bot hard to evaluate as a real crypto trading user.',
    ],
  },
]

export async function auditLinIssues(options: AuditOptions = {}): Promise<AuditResult> {
  const repo = options.repo ?? DEFAULT_REPO
  const linLogin = options.linLogin ?? DEFAULT_LIN_LOGIN
  const operatorUrl = (options.operatorUrl ?? process.env.TRADING_OPERATOR_API_URL ?? DEFAULT_OPERATOR_URL).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const [issues, bots] = await Promise.all([
    fetchLinOpenIssues({ repo, linLogin, token: options.githubToken, fetchImpl }),
    fetchBots({ operatorUrl, fetchImpl }),
  ])
  const coverage = buildCoverage(issues, bots)
  if (options.includeEvidence ?? true) {
    await attachEvidence(operatorUrl, coverage, fetchImpl)
  }
  return { repo, linLogin, operatorUrl, issues, bots, coverage }
}

export async function dispatchActiveUserLab(options: DispatchOptions = {}): Promise<DispatchResult[]> {
  const audit = await auditLinIssues({ ...options, includeEvidence: true })
  const selected = selectDispatchCoverage(audit.coverage, options.issueNumbers)
  const operatorUrl = audit.operatorUrl
  const appUrl = (options.appUrl ?? process.env.TRADING_ARENA_APP_URL ?? DEFAULT_APP_URL).replace(/\/$/, '')
  const dryRun = options.dryRun ?? false
  const client = dryRun ? null : await buildOperatorClient({ ...options, operatorUrl })
  const turns = clampTurns(options.turns)
  const results: DispatchResult[] = []

  for (const coverage of selected) {
    const bot = options.freshBot
      ? await provisionFreshLabBot(coverage, client, dryRun)
      : chooseCandidate(coverage, options.botId)?.bot
    if (!bot) {
      throw new Error(`issue #${coverage.issue.number} has no candidate bot; run audit first or dispatch with --fresh-bot`)
    }
    const prompts = options.prompts?.length
      ? options.prompts.slice(0, turns)
      : options.generateIdeas
        ? await generateRuntimePrompts(coverage, bot, turns)
        : buildStaticPromptPack(coverage, bot, turns)
    const sessionTitle = `QA #${coverage.issue.number} ${coverage.scenario.key}`
    const sessionId = dryRun
      ? `dry-run-${coverage.issue.number}-${bot.id}`
      : await client!.createSession(bot.id, sessionTitle)
    const chatUrl = buildChatUrl(appUrl, bot.id, sessionId)

    if (!dryRun && options.configureSecrets) {
      await client!.configureSecrets(bot.id, deterministicAgentEnv())
    }

    let sinceMessageId: string | null = null
    if (!dryRun && options.watch) {
      sinceMessageId = lastAssistantId(await client!.getTranscript(bot.id, sessionId))
    }

    const replies: DispatchResult['replies'] = []
    for (const prompt of prompts) {
      if (dryRun) {
        replies.push({ prompt, reply: '', endedBy: 'skipped' })
        continue
      }
      await client!.sendMessage(bot.id, sessionId, prompt)
      if (!options.watch) {
        replies.push({ prompt, reply: '', endedBy: 'skipped' })
        continue
      }
      const reply = await client!.waitForAssistantReply({
        botId: bot.id,
        sessionId,
        sinceMessageId,
        timeoutMs: options.replyTimeoutMs ?? 180_000,
        pollIntervalMs: options.pollIntervalMs ?? 5_000,
      })
      sinceMessageId = reply.latestAssistantId
      replies.push({ prompt, reply: reply.text, endedBy: reply.endedBy })
    }

    results.push({
      issueNumber: coverage.issue.number,
      issueTitle: coverage.issue.title,
      botId: bot.id,
      botName: bot.name,
      sessionId,
      chatUrl,
      prompts,
      replies,
    })
  }

  return results
}

async function provisionFreshLabBot(
  coverage: IssueCoverage,
  client: OperatorClient | null,
  dryRun: boolean,
): Promise<LabBot> {
  const spec = coverage.scenario.freshBot
  if (!spec) {
    throw new Error(
      `issue #${coverage.issue.number} cannot be honestly covered by a generic fresh paper bot; ` +
      `use the product flow named by the issue instead`,
    )
  }
  if (dryRun) {
    return {
      id: `dry-run-fresh-${coverage.issue.number}`,
      name: spec.name,
      strategy_type: spec.strategyType,
      prompt: spec.prompt,
      paper_trade: true,
      sandbox_id: 'dry-run',
      vault_address: null,
      created_at: Date.now(),
      strategy_config: null,
    }
  }
  if (!client) throw new Error('fresh bot provisioning requires an authenticated operator client')
  const botId = await client.provisionBot({
    prompt: spec.prompt,
    name: spec.name,
    strategy_type: spec.strategyType,
  })
  await client.waitForVaultResolved(botId)
  await client.configureSecrets(botId, deterministicAgentEnv())
  return {
    id: botId,
    name: spec.name,
    strategy_type: spec.strategyType,
    prompt: spec.prompt,
    paper_trade: true,
    sandbox_id: null,
    vault_address: null,
    created_at: Date.now(),
    strategy_config: null,
  }
}

export function buildCoverage(issues: LabIssue[], bots: LabBot[]): IssueCoverage[] {
  return issues
    .map((issue) => {
      const scenario = scenarioForIssue(issue)
      const candidates = bots
        .map((bot) => scoreBotForScenario(bot, scenario))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) =>
          Number(b.exact) - Number(a.exact) ||
          b.score - a.score ||
          a.bot.id.localeCompare(b.bot.id),
        )
      const status: CoverageStatus = candidates.some((candidate) => candidate.exact)
        ? 'covered'
        : candidates.length > 0
          ? 'partial'
          : 'gap'
      return {
        issue,
        scenario,
        status,
        reason: coverageReason(status, scenario, candidates),
        candidates,
      }
    })
    .sort((a, b) => b.issue.number - a.issue.number)
}

export function formatAuditTable(result: AuditResult): string {
  const rows = result.coverage.map((coverage) => {
    const candidate = coverage.candidates[0]
    const evidence = candidate?.evidence
    const evidenceText = evidence
      ? [
          evidence.recentRun ? `run:${evidence.recentRun.status}` : null,
          evidence.recentTrade ? `trade:${evidence.recentTrade.executionStatus}` : null,
        ].filter(Boolean).join(' ')
      : 'not probed'
    return [
      `#${coverage.issue.number}`,
      coverage.status.toUpperCase(),
      coverage.scenario.key,
      candidate ? `${candidate.bot.strategy_type ?? 'unknown'} ${shorten(candidate.bot.name, 44)}` : 'no candidate',
      evidenceText || 'no live evidence',
      coverage.issue.url,
    ]
  })
  return renderTable([
    ['Issue', 'Status', 'Scenario', 'Best bot', 'Evidence', 'URL'],
    ...rows,
  ])
}

export function buildChatUrl(appUrl: string, botId: string, sessionId: string): string {
  const base = appUrl.replace(/\/$/, '')
  return `${base}/arena/bot/${encodeURIComponent(botId)}/chat?session=${encodeURIComponent(sessionId)}`
}

function scenarioForIssue(issue: LabIssue): IssueScenario {
  const exact = ISSUE_SCENARIOS.find((scenario) => scenario.issueNumber === issue.number)
  if (exact) return exact

  const text = `${issue.title}\n${issue.body}`.toLowerCase()
  if (text.includes('polymarket') || text.includes('prediction')) return scenarioByIssue(41)
  if (text.includes('market making') || text.includes('spread')) return scenarioByIssue(45)
  if (text.includes('perp')) return scenarioByIssue(43)
  return {
    issueNumber: issue.number,
    key: 'unclassified',
    expectedSurface: 'No explicit scenario mapping',
    exactMatchers: [],
    partialMatchers: ['trading'],
    staticPrompts: [
      `Inspect issue #${issue.number}: ${issue.title}. State whether your current bot can test it and what evidence is missing.`,
    ],
  }
}

function scenarioByIssue(issueNumber: number): IssueScenario {
  const scenario = ISSUE_SCENARIOS.find((candidate) => candidate.issueNumber === issueNumber)
  if (!scenario) throw new Error(`missing issue scenario ${issueNumber}`)
  return scenario
}

function scoreBotForScenario(bot: LabBot, scenario: IssueScenario): IssueCoverageCandidate {
  const haystack = botHaystack(bot)
  const exactHits = scenario.exactMatchers.filter((matcher) => haystack.includes(matcher.toLowerCase()))
  const partialHits = scenario.partialMatchers.filter((matcher) => haystack.includes(matcher.toLowerCase()))
  const exact = scenario.exactMatchMode === 'all'
    ? exactHits.length === scenario.exactMatchers.length && exactHits.length > 0
    : exactHits.length > 0
  return {
    bot,
    score:
      exactHits.reduce((score, hit) => score + (hit.startsWith('strategy:') ? 20 : 10), 0) +
      partialHits.reduce((score, hit) => score + (hit.startsWith('strategy:') ? 6 : 3), 0) +
      (bot.sandbox_id ? 1 : 0),
    exact,
    evidence: null,
  }
}

function botHaystack(bot: LabBot): string {
  return [
    bot.id,
    bot.name,
    bot.strategy_type ? `strategy:${bot.strategy_type}` : '',
    bot.strategy_type ?? '',
    bot.prompt ?? '',
    bot.vault_address ?? '',
    bot.strategy_config ? JSON.stringify(bot.strategy_config) : '',
  ].join('\n').toLowerCase()
}

function coverageReason(
  status: CoverageStatus,
  scenario: IssueScenario,
  candidates: IssueCoverageCandidate[],
): string {
  if (status === 'gap') return `No live bot matches ${scenario.expectedSurface}.`
  const best = candidates[0]
  if (!best) return `No live bot matches ${scenario.expectedSurface}.`
  if (status === 'covered') return `Best live bot matches ${scenario.expectedSurface}: ${best.bot.id}.`
  return `Only partial coverage for ${scenario.expectedSurface}: best candidate ${best.bot.id}.`
}

async function attachEvidence(
  operatorUrl: string,
  coverage: IssueCoverage[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const seen = new Map<string, BotEvidence>()
  const candidates = coverage.flatMap((item) => item.candidates.slice(0, 3))
  await Promise.all(candidates.map(async (candidate) => {
    const existing = seen.get(candidate.bot.id)
    if (existing) {
      candidate.evidence = existing
      return
    }
    const evidence = await fetchBotEvidence(operatorUrl, candidate.bot.id, fetchImpl)
    seen.set(candidate.bot.id, evidence)
    candidate.evidence = evidence
  }))
}

async function fetchBotEvidence(
  operatorUrl: string,
  botId: string,
  fetchImpl: typeof fetch,
): Promise<BotEvidence> {
  const [runs, trades] = await Promise.all([
    safeFetchJson<{ runs?: Array<Record<string, unknown>> }>(
      `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/runs?limit=1`,
      fetchImpl,
    ),
    safeFetchJson<{ trades?: Array<Record<string, unknown>>; fills?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }>(
      `${operatorUrl}/api/bots/${encodeURIComponent(botId)}/trades?limit=1`,
      fetchImpl,
    ),
  ])
  const run = runs?.runs?.[0] ?? null
  const trade = (trades?.trades ?? trades?.fills ?? trades?.items ?? [])[0] ?? null
  return {
    recentRun: run
      ? {
          status: stringValue(run.status) ?? 'unknown',
          workflowKind: stringValue(run.workflow_kind) ?? 'unknown',
          startedAt: (run.started_at as number | string | null | undefined) ?? null,
          transcriptAvailable: typeof run.transcript_available === 'boolean'
            ? run.transcript_available
            : null,
        }
      : null,
    recentTrade: trade
      ? {
          timestamp: stringValue(trade.timestamp) ?? 'unknown',
          action: stringValue(trade.action) ?? 'unknown',
          targetProtocol: stringValue(trade.target_protocol) ?? 'unknown',
          notionalUsd: stringValue(trade.notional_usd) ?? 'unknown',
          executionStatus: stringValue(trade.execution_status) ?? 'unknown',
        }
      : null,
  }
}

async function fetchLinOpenIssues(input: {
  repo: string
  linLogin: string
  token: string | undefined
  fetchImpl: typeof fetch
}): Promise<LabIssue[]> {
  const issues: LabIssue[] = []
  for (let page = 1; page <= 5; page += 1) {
    const res = await input.fetchImpl(
      `https://api.github.com/repos/${input.repo}/issues?state=open&per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'tangle-active-user-lab',
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
      },
    )
    if (!res.ok) throw new Error(`GitHub issue fetch failed ${res.status}: ${await res.text()}`)
    const pageIssues = await res.json() as Array<Record<string, unknown>>
    if (pageIssues.length === 0) break
    for (const raw of pageIssues) {
      if (raw.pull_request) continue
      const author = loginOf(raw.user) ?? ''
      const assignees = Array.isArray(raw.assignees)
        ? raw.assignees.map(loginOf).filter((login): login is string => Boolean(login))
        : []
      if (author !== input.linLogin && !assignees.includes(input.linLogin)) continue
      issues.push({
        number: numberValue(raw.number),
        title: stringValue(raw.title) ?? '',
        body: stringValue(raw.body) ?? '',
        url: stringValue(raw.html_url) ?? '',
        author,
        assignees,
        labels: Array.isArray(raw.labels)
          ? raw.labels
            .map((label) => stringValue((label as Record<string, unknown>).name))
            .filter((label): label is string => Boolean(label))
          : [],
      })
    }
    if (pageIssues.length < 100) break
  }
  return issues.sort((a, b) => b.number - a.number)
}

async function fetchBots(input: { operatorUrl: string; fetchImpl: typeof fetch }): Promise<LabBot[]> {
  const res = await input.fetchImpl(`${input.operatorUrl}/api/bots?limit=200`)
  if (!res.ok) throw new Error(`bot list fetch failed ${res.status}: ${await res.text()}`)
  const raw = await res.json() as { bots?: unknown } | unknown[]
  const bots = Array.isArray(raw) ? raw : Array.isArray(raw.bots) ? raw.bots : []
  return bots.map((entry) => normalizeBot(entry)).filter((bot): bot is LabBot => bot !== null)
}

function normalizeBot(entry: unknown): LabBot | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const id = stringValue(raw.id)
  if (!id) return null
  return {
    id,
    name: stringValue(raw.name) ?? id,
    strategy_type: stringValue(raw.strategy_type) ?? null,
    prompt: stringValue(raw.prompt) ?? null,
    paper_trade: typeof raw.paper_trade === 'boolean' ? raw.paper_trade : null,
    sandbox_id: stringValue(raw.sandbox_id) ?? null,
    vault_address: stringValue(raw.vault_address) ?? null,
    created_at: (raw.created_at as string | number | null | undefined) ?? null,
    strategy_config: raw.strategy_config,
  }
}

function selectDispatchCoverage(
  coverage: IssueCoverage[],
  issueNumbers: number[] | undefined,
): IssueCoverage[] {
  const requested = new Set(issueNumbers?.length ? issueNumbers : DEFAULT_DISPATCH_ISSUES)
  const selected = coverage.filter((item) => requested.has(item.issue.number))
  if (selected.length === 0) {
    throw new Error(`no selected issues found; requested ${Array.from(requested).join(', ')}`)
  }
  return selected
}

function chooseCandidate(
  coverage: IssueCoverage,
  requestedBotId: string | undefined,
): IssueCoverageCandidate | null {
  if (requestedBotId) return coverage.candidates.find((candidate) => candidate.bot.id === requestedBotId) ?? null
  return coverage.candidates[0] ?? null
}

async function buildOperatorClient(
  options: DispatchOptions & { operatorUrl: string },
): Promise<OperatorClient> {
  const privateKey = options.privateKey ?? process.env.TRADING_OPERATOR_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY
  if (privateKey) return OperatorClient.authenticate(options.operatorUrl, privateKey)
  const token = options.token ?? process.env.TRADING_OPERATOR_SESSION_TOKEN ?? process.env.OPERATOR_SESSION_TOKEN
  if (!token) {
    throw new Error('dispatch requires --token/OPERATOR_SESSION_TOKEN or --private-key/TRADING_OPERATOR_PRIVATE_KEY')
  }
  return new OperatorClient({ operatorUrl: options.operatorUrl, token })
}

function buildStaticPromptPack(coverage: IssueCoverage, bot: LabBot, turns: number): string[] {
  const prefix = [
    'We are operating this platform as active customer QA users.',
    `Issue #${coverage.issue.number}: ${coverage.issue.title}`,
    `Target bot: ${bot.name} (${bot.id}, strategy=${bot.strategy_type ?? 'unknown'}, paper=${bot.paper_trade ?? 'unknown'}).`,
    'Keep this paper-safe. Do not execute live funds. Be concrete and reference observable state.',
  ].join('\n')
  return coverage.scenario.staticPrompts
    .slice(0, turns)
    .map((prompt, index) => `${prefix}\n\nTurn ${index + 1}/${turns}: ${prompt}`)
}

async function generateRuntimePrompts(
  coverage: IssueCoverage,
  bot: LabBot,
  turns: number,
): Promise<string[]> {
  const { result, raw } = await runProfileJson<{ prompts?: unknown }>(
    activeUserLabPromptProfile,
    {
      message: [
        `Issue #${coverage.issue.number}: ${coverage.issue.title}`,
        `Body excerpt: ${shorten(coverage.issue.body || '(empty)', 1600)}`,
        `Scenario: ${coverage.scenario.expectedSurface}`,
        `Bot: ${bot.name} (${bot.id})`,
        `Strategy: ${bot.strategy_type ?? 'unknown'}`,
        `Need ${turns} prompts.`,
      ].join('\n'),
    },
  )
  if (!raw.ok) throw new Error(`agent-runtime prompt generation failed: ${raw.stderr}`)
  const prompts = Array.isArray(result?.prompts)
    ? result.prompts.filter((prompt): prompt is string => typeof prompt === 'string' && prompt.trim().length > 0)
    : []
  if (prompts.length === 0) throw new Error(`agent-runtime prompt generation returned no prompts: ${raw.output}`)
  return prompts.slice(0, turns)
}

async function safeFetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

function renderTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, index) =>
    Math.min(72, Math.max(...rows.map((row) => row[index]?.length ?? 0))),
  )
  return rows
    .map((row, rowIndex) => {
      const line = row.map((cell, index) => shorten(cell, widths[index]!).padEnd(widths[index]!)).join('  ')
      if (rowIndex === 0) return `${line}\n${widths.map((width) => '-'.repeat(width)).join('  ')}`
      return line
    })
    .join('\n')
}

function shorten(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`
}

function clampTurns(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 3, 6))
}

function loginOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  return stringValue((value as Record<string, unknown>).login) ?? null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
