import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChatUrl,
  buildCoverage,
  dispatchActiveUserLab,
  formatAuditTable,
  type LabBot,
  type LabIssue,
} from './active-user-lab.js'

const baseIssue: Omit<LabIssue, 'number' | 'title'> = {
  body: '',
  url: 'https://github.test/issue',
  author: 'vutuanlinh2k2',
  assignees: [],
  labels: [],
}

function issue(number: number, title: string): LabIssue {
  return { ...baseIssue, number, title }
}

function bot(input: Partial<LabBot> & Pick<LabBot, 'id' | 'name' | 'strategy_type'>): LabBot {
  return {
    prompt: null,
    paper_trade: true,
    chain_id: 84532,
    sandbox_id: 'sandbox-test',
    vault_address: 'factory:0xvault',
    created_at: 1,
    strategy_config: null,
    ...input,
  }
}

test('buildCoverage maps Lin QA issues to exact and partial live bot candidates', () => {
  const coverage = buildCoverage(
    [
      issue(46, '[QA] Cross-strategy bot'),
      issue(43, '[QA] Perp bot - GMX and Vertex'),
      issue(41, '[QA] Polymarket bot'),
    ],
    [
      bot({ id: 'bot-multi', name: 'Multi ETH/USDC allocation', strategy_type: 'multi' }),
      bot({ id: 'bot-perp', name: 'Hyperliquid ETH perp', strategy_type: 'perp' }),
      bot({ id: 'bot-prediction', name: 'Polymarket politics CLOB', strategy_type: 'prediction' }),
    ],
  )

  const crossStrategy = coverage.find((entry) => entry.issue.number === 46)
  assert.equal(crossStrategy?.status, 'covered')
  assert.equal(crossStrategy?.candidates[0]?.bot.id, 'bot-multi')

  const gmxVertex = coverage.find((entry) => entry.issue.number === 43)
  assert.equal(gmxVertex?.status, 'partial')
  assert.equal(gmxVertex?.candidates[0]?.bot.id, 'bot-perp')

  const polymarket = coverage.find((entry) => entry.issue.number === 41)
  assert.equal(polymarket?.status, 'covered')
  assert.equal(polymarket?.candidates[0]?.bot.id, 'bot-prediction')
})

test('buildCoverage requires GMX Vertex config proof before marking perp QA covered', () => {
  const [coverage] = buildCoverage(
    [issue(43, '[QA] Perp bot - GMX and Vertex')],
    [
      bot({
        id: 'bot-gmx-vertex-complete',
        name: 'QA GMX Vertex perp paper strategy',
        strategy_type: 'perp',
        chain_id: 84532,
        strategy_config: {
          paper_trade: true,
          protocol_chain_id: 42161,
          available_protocols: ['gmx_v2', 'vertex'],
          perps: { venues: ['gmx_v2', 'vertex'], max_leverage: 2 },
        },
      }),
    ],
  )

  assert.equal(coverage?.status, 'covered')
  assert.equal(coverage?.candidates[0]?.exact, true)
})

test('buildCoverage requires volatility config and evidence proof before marking volatility QA covered', () => {
  const [partial] = buildCoverage(
    [issue(44, '[QA] Volatility bot — paper-only volatility strategy')],
    [
      bot({
        id: 'bot-vol-label-only',
        name: 'QA volatility paper strategy',
        strategy_type: 'volatility',
      }),
    ],
  )
  assert.equal(partial?.status, 'partial')

  const [covered] = buildCoverage(
    [issue(44, '[QA] Volatility bot — paper-only volatility strategy')],
    [
      bot({
        id: 'bot-vol-complete',
        name: 'QA volatility paper strategy',
        strategy_type: 'volatility',
        strategy_config: {
          paper_trade: true,
          available_protocols: ['polymarket_clob', 'gmx_v2', 'vertex'],
          volatility_params: { realized_window_hours: 24 },
          decision_evidence: { tool_module: 'volatility-tick.js' },
        },
      }),
    ],
  )

  assert.equal(covered?.status, 'covered')
  assert.equal(covered?.candidates[0]?.exact, true)
})

test('buildCoverage does not treat negative Hyperliquid mentions as exact Hyperliquid coverage', () => {
  const [coverage] = buildCoverage(
    [issue(57, 'Migrate Hyperliquid to a dedicated perp envelope model')],
    [
      bot({
        id: 'bot-gmx-vertex',
        name: 'QA GMX Vertex perp paper strategy',
        strategy_type: 'perp',
        prompt: 'Do not use Hyperliquid native execution.',
      }),
      bot({
        id: 'bot-hyperliquid',
        name: 'QA Hyperliquid ETH perp envelope',
        strategy_type: 'hyperliquid_perp',
      }),
    ],
  )

  assert.equal(coverage?.status, 'covered')
  assert.equal(coverage?.candidates[0]?.bot.id, 'bot-hyperliquid')
  assert.equal(coverage?.candidates.find((candidate) => candidate.bot.id === 'bot-gmx-vertex')?.exact, false)
})

test('buildCoverage keeps vault collateral admin partial without workflow proof', () => {
  const [coverage] = buildCoverage(
    [issue(16, '[QA] Vault collateral admin — cap setting and write-down')],
    [
      bot({
        id: 'bot-vault',
        name: 'Vault paper trading bot',
        strategy_type: 'yield',
        prompt: 'Inspect collateral cap and paper vault state, but do not run admin mutation workflow.',
      }),
    ],
  )

  assert.equal(coverage?.status, 'partial')
  assert.equal(coverage?.candidates[0]?.exact, false)
})

test('buildChatUrl deep-links a lab-created session into the app chat surface', () => {
  assert.equal(
    buildChatUrl('https://trading-arena.blueprint.tangle.tools/', 'trading abc', 'qa #46'),
    'https://trading-arena.blueprint.tangle.tools/arena/bot/trading%20abc/chat?session=qa%20%2346',
  )
})

test('formatAuditTable exposes status, scenario, best bot, evidence, and URL', () => {
  const coverage = buildCoverage(
    [issue(45, '[QA] Market making bot')],
    [bot({ id: 'bot-mm', name: 'MM ETH/USDC Aerodrome', strategy_type: 'mm' })],
  )
  coverage[0]!.candidates[0]!.evidence = {
    recentRun: {
      status: 'completed',
      workflowKind: 'trading',
      startedAt: 1,
      transcriptAvailable: false,
    },
    recentTrade: {
      timestamp: '2026-06-03T17:00:00Z',
      action: 'swap',
      targetProtocol: 'aerodrome',
      notionalUsd: '100',
      executionStatus: 'paper',
    },
  }

  const table = formatAuditTable({
    repo: 'tangle-network/ai-trading-blueprint',
    linLogin: 'vutuanlinh2k2',
    operatorUrl: 'https://operator.test',
    issues: [],
    bots: [],
    coverage,
  })

  assert.match(table, /#45/)
  assert.match(table, /COVERED/)
  assert.match(table, /market-making-inventory/)
  assert.match(table, /run:completed trade:paper/)
})

test('dispatchActiveUserLab can dry-run a fresh owned QA bot for exact issue coverage', async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('api.github.com')) {
      return jsonResponse([
        {
          number: 44,
          title: '[QA] Volatility bot — paper-only volatility strategy',
          body: 'Volatility strategy pack selection and paper-only guardrails.',
          html_url: 'https://github.test/44',
          user: { login: 'vutuanlinh2k2' },
          assignees: [],
          labels: [],
        },
      ])
    }
    if (href.endsWith('/api/bots?limit=200')) return jsonResponse({ bots: [] })
    return jsonResponse({})
  }

  const [result] = await dispatchActiveUserLab({
    repo: 'tangle-network/ai-trading-blueprint',
    linLogin: 'vutuanlinh2k2',
    operatorUrl: 'https://operator.test',
    appUrl: 'https://arena.test',
    issueNumbers: [44],
    freshBot: true,
    dryRun: true,
    turns: 1,
    fetchImpl,
  })

  assert.equal(result?.botId, 'dry-run-fresh-44')
  assert.equal(result?.botName, 'QA volatility paper strategy')
  assert.equal(result?.chatUrl, 'https://arena.test/arena/bot/dry-run-fresh-44/chat?session=dry-run-44-dry-run-fresh-44')
  assert.match(result?.prompts[0] ?? '', /Volatility/)
})

test('dispatchActiveUserLab refuses to fake TEE coverage with a generic fresh bot', async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('api.github.com')) {
      return jsonResponse([
        {
          number: 7,
          title: '[QA] Provision TEE (confidential) bot — TEE wizard and runtime lock',
          body: 'TEE wizard and runtime lock.',
          html_url: 'https://github.test/7',
          user: { login: 'vutuanlinh2k2' },
          assignees: [],
          labels: [],
        },
      ])
    }
    if (href.endsWith('/api/bots?limit=200')) return jsonResponse({ bots: [] })
    return jsonResponse({})
  }

  await assert.rejects(
    dispatchActiveUserLab({
      repo: 'tangle-network/ai-trading-blueprint',
      linLogin: 'vutuanlinh2k2',
      operatorUrl: 'https://operator.test',
      issueNumbers: [7],
      freshBot: true,
      dryRun: true,
      fetchImpl,
    }),
    /cannot be honestly covered/,
  )
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
