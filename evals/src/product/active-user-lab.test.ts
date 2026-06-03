import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChatUrl,
  buildCoverage,
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
