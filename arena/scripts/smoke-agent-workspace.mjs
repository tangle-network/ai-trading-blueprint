#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_SECTIONS = ['performance', 'portfolio', 'runs', 'chat', 'operations'];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARENA_DIR = path.resolve(SCRIPT_DIR, '..');
const FIXTURE_BOT_ID = 'smoke-hyperliquid-agent';
const FIXTURE_OPERATOR = '0x1234567890abcdef1234567890abcdef12345678';
const FIXTURE_VAULT = '0x0000000000000000000000000000000000001001';
const FIXTURE_OWNER_TOKEN = 'fixture-owner-token';
const FIXTURE_OWNER_AUTH_KEY = `arena.operator_auth.${FIXTURE_OPERATOR.toLowerCase()}::/operator-api`;
const FIXTURE_WALLET_ADDRESS = FIXTURE_OPERATOR;
const FIXTURE_WALLET_CHAIN_ID = 84532;

const SECTION_EXPECTATIONS = {
  performance: [
    ['Market', 'NAV', 'Price'],
    ['ETH', 'Performance', 'Awaiting first checkpoint'],
    ['Fills', 'Latest Trades', 'Copilot'],
  ],
  portfolio: [
    'Portfolio',
    ['Equity', 'Value'],
    ['Executions', 'No executions recorded'],
  ],
  runs: [
    ['ETH Macro Scalper', 'No runs yet'],
    ['Reasoning', 'fast_backtest', 'Breakout retest', 'Evidence replay', 'Decision Path'],
  ],
  chat: [
    ['Review the ETH breakout retest', 'ETH breakout review', 'No chat sessions yet'],
    ['fast_backtest', 'hyperliquid_nav', 'No chat sessions yet'],
  ],
  operations: ['Operations', 'Validation', 'Evidence'],
};
const LIVE_SECTION_EXPECTATIONS = {
  performance: [
    ['Market', 'NAV', 'Price', 'Performance'],
    ['Fills', 'Latest Trades', 'Copilot', 'Awaiting checkpoint'],
  ],
  portfolio: [
    'Portfolio',
    ['Market', 'Executions', 'No executions recorded', 'Equity', 'Value'],
  ],
  runs: [
    'Runs',
    ['Trading Trace', 'No runs yet'],
    ['Run details', 'Run failed', 'Result', 'Error', 'Workflow', 'Decision', 'Transcript'],
  ],
  chat: [
    'Chat',
    ['No chat sessions yet', 'Ask', 'Owner Sign In'],
  ],
  operations: [
    'Operations',
    ['Validation', 'Validator', 'Controls', 'Terminal', 'Envelope'],
  ],
};
const FIXTURE_HOME_EXPECTATIONS = ['Home', 'Volume', 'Fills', 'ETH Macro Scalper'];
const FIXTURE_LEADERBOARD_EXPECTATIONS = ['Agents', '24H Vol', 'Active', 'ETH Macro Scalper', 'HL Perp'];
const FIXTURE_ACTIVITY_EXPECTATIONS = ['Activity', '24H Vol', 'Fills', 'ETH Macro Scalper', 'ETH-PERP'];
const FIXTURE_DASHBOARD_EXPECTATIONS = ['My Agents', 'ETH Macro Scalper', 'PNL', 'NAV'];
const FIXTURE_OBSERVATORY_EXPECTATIONS = [
  'Observatory',
  'ETH Macro Scalper',
  'Output',
  'Trace',
  'Findings',
  'Ideas',
  'Delegations',
  'Agent',
  '1 tool, 1 response',
  'Source-grounded finding is recorded.',
];
const FIXTURE_CREATE_EXPECTATIONS = ['New Agent', 'Mandate', 'Agent Profile', 'Prediction Markets', 'Launch Paper Agent'];
const FIXTURE_PROVISION_EXPECTATIONS = [
  'Activate Agent',
  'Connect a wallet to provision the runtime',
  'Connect Wallet',
];
const FIXTURE_PROVISION_CONNECTED_EXPECTATIONS = [
  'Activate',
  'Base Sepolia',
  'Agent Profile',
  'Agent Identity',
  'Activation Review',
  'Hyperliquid Guardrails',
  'Review Activation',
];

function parseArgs(argv) {
  const args = {
    url: process.env.ARENA_SMOKE_URL ?? 'http://127.0.0.1:1337/',
    allowEmpty: false,
    chrome: process.env.CHROME_BIN ?? '',
    fixture: false,
    fixtureEmptyRunTranscript: false,
    ownerPerformance: false,
    serveFixture: false,
    themeMatrix: false,
    readyFile: '',
    screenshotDir: process.env.ARENA_SMOKE_SCREENSHOT_DIR ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--url') {
      args.url = argv[index + 1] ?? args.url;
      index += 1;
    } else if (arg === '--chrome') {
      args.chrome = argv[index + 1] ?? args.chrome;
      index += 1;
    } else if (arg === '--allow-empty') {
      args.allowEmpty = true;
    } else if (arg === '--fixture') {
      args.fixture = true;
    } else if (arg === '--fixture-empty-run-transcript') {
      args.fixture = true;
      args.fixtureEmptyRunTranscript = true;
    } else if (arg === '--serve-fixture') {
      args.fixture = true;
      args.serveFixture = true;
    } else if (arg === '--ready-file') {
      args.readyFile = argv[index + 1] ?? args.readyFile;
      index += 1;
    } else if (arg === '--owner-performance') {
      args.ownerPerformance = true;
      args.fixture = true;
    } else if (arg === '--theme-matrix') {
      args.themeMatrix = true;
    } else if (arg === '--screenshot-dir') {
      args.screenshotDir = argv[index + 1] ?? args.screenshotDir;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: pnpm smoke:agent-workspace -- --url http://127.0.0.1:1337/

Checks:
  - discovers a rendered /arena/bot/:id link
  - verifies Performance, Portfolio, Runs, Chat, Operations do not body-scroll at 1440x900 and 1280x800
  - verifies browser-visible operator API health and CORS when the deployed build exposes an operator URL
  - verifies Portfolio -> Chat -> browser Back -> Portfolio
  - verifies Chat -> Performance changes route in one click

Options:
  --url <url>       App base URL. Defaults to ARENA_SMOKE_URL or http://127.0.0.1:1337/
  --chrome <path>   Chromium/Chrome binary. Defaults to CHROME_BIN or common system names.
  --fixture         Start a deterministic mock operator + local app server, then smoke a fixture agent.
  --fixture-empty-run-transcript
                    Fixture run reports transcript_available but returns no visible messages.
  --serve-fixture   Start the deterministic mock operator + local app server and keep them alive until SIGTERM.
  --ready-file <path>
                    With --serve-fixture, write the app URL to a file after the server is ready.
  --owner-performance
                    Start fixture mode with dev owner auth and verify the owner Performance copilot.
  --theme-matrix    Check forced light and dark themes and suffix screenshots with -light/-dark.
  --screenshot-dir <dir>
                    Save PNG screenshots for each checked workspace/viewport.
  --allow-empty     Exit 0 when no agent route is discoverable. Use only for local UI iteration, not release gates.`);
}

function findChrome(explicitPath) {
  if (explicitPath) return explicitPath;
  for (const candidate of [
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
    '/snap/bin/chromium',
  ]) {
    const result = spawnSync('bash', ['-lc', `command -v ${candidate}`], {
      encoding: 'utf8',
    });
    const resolved = result.stdout.trim();
    if (result.status === 0 && resolved) return resolved;
  }
  throw new Error('No Chromium/Chrome binary found. Set CHROME_BIN or pass --chrome.');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForShutdownSignal() {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

function waitForProcessExit(child, timeoutMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', handleExit);
    };
    const handleExit = () => {
      cleanup();
      resolve(true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    child.once('exit', handleExit);
  });
}

async function removeDirectoryWithRetries(directory) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      lastError = error;
      await wait(150 * attempt);
    }
  }

  throw lastError;
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('Could not allocate a local port'));
      });
    });
  });
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function fixtureIso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function buildFixtureBotRecord() {
  return {
    id: FIXTURE_BOT_ID,
    name: 'ETH Macro Scalper',
    operator_address: FIXTURE_OPERATOR,
    submitter_address: FIXTURE_OPERATOR,
    vault_address: FIXTURE_VAULT,
    strategy_type: 'hyperliquid_perp',
    strategy_config: {
      asset: 'ETH',
      market_type: 'hyperliquid_perp',
      initial_capital_usd: '25000',
      position_sizing: { fraction: 0.12 },
      risk_limits: { max_drawdown_pct: 5, max_position_notional_usd: 3000 },
    },
    risk_params: {
      max_drawdown_pct: '5',
      max_position_size_pct: '12',
      stop_loss_pct: '1.8',
    },
    chain_id: 84532,
    trading_active: true,
    paper_trade: true,
    created_at: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
    max_lifetime_days: 30,
    trading_api_url: 'fixture://trading-api',
    trading_api_token: '',
    sandbox_id: 'sandbox-smoke-agent',
    sandbox_exists: true,
    sandbox_state: 'running',
    lifecycle_status: 'active',
    archived: false,
    control_available: true,
    secrets_configured: true,
    workflow_id: 'wf-smoke-agent',
    wind_down_started_at: null,
    validator_service_ids: [101, 102, 103],
    validator_endpoints: ['fixture-validator-a', 'fixture-validator-b', 'fixture-validator-c'],
    call_id: 101,
    service_id: 9001,
    validation_trust: 'envelope',
  };
}

function buildFixtureTrades() {
  const actions = ['open_long', 'open_long', 'close_long', 'open_short', 'close_short', 'open_long'];
  const prices = [3440, 3456, 3478, 3466, 3438, 3452, 3484, 3496, 3472, 3508, 3520, 3512];
  return Array.from({ length: 12 }).map((_, index) => {
    const action = actions[index % actions.length];
    const price = prices[index] ?? 3440;
    const amount = index % 3 === 0 ? 0.42 : index % 3 === 1 ? 0.31 : 0.26;
    const reduceOnly = action.startsWith('close');
    const paper = index < 9;
    return {
      id: `trade-${String(index + 1).padStart(2, '0')}`,
      bot_id: FIXTURE_BOT_ID,
      timestamp: fixtureIso(140 - index * 11),
      action,
      token_in: action.includes('short') ? 'USDC' : 'ETH',
      token_out: action.includes('short') ? 'ETH' : 'USDC',
      amount_in: String(amount),
      min_amount_out: String(Math.round(amount * price * 100) / 100),
      amount_out: String(Math.round(amount * price * 100) / 100),
      target_protocol: 'hyperliquid',
      tx_hash: paper ? undefined : `hl:fixture-${index + 1}`,
      paper_trade: paper,
      execution_status: paper ? 'paper' : 'filled',
      clob_order_id: `hl-order-${index + 1}`,
      valuation_status: 'priced',
      entry_price_usd: String(price),
      notional_usd: String(Math.round(amount * price * 100) / 100),
      requested_price_usd: String(price + (index % 2 === 0 ? 1.2 : -0.8)),
      filled_price_usd: String(price),
      filled_amount: String(amount),
      slippage_bps: String(index % 2 === 0 ? 3.5 : 5.2),
      execution_reason: index % 2 === 0
        ? 'Breakout retest confirmed with rising volume.'
        : 'Mean reversion scalp after liquidity sweep.',
      hyperliquid_metadata: {
        asset: 'ETH',
        asset_size: String(amount),
        order_type: index % 2 === 0 ? 'market' : 'limit',
        reduce_only: reduceOnly,
      },
      validation: {
        approved: true,
        aggregate_score: 88 + (index % 5),
        intent_hash: `0xintent${index}`,
        responses: [
          {
            validator: '0x00000000000000000000000000000000000000aa',
            score: 91,
            reasoning: 'Validator approved: liquidity, slippage, and max loss are inside the signed envelope.',
            signature: `0xsig${index}a`,
            chain_id: 84532,
            verifying_contract: '0x0000000000000000000000000000000000002000',
            validated_at: fixtureIso(139 - index * 11),
          },
          {
            validator: '0x00000000000000000000000000000000000000bb',
            score: 87,
            reasoning: 'Scenario replay supports tiny allocation while monitoring drift.',
            signature: `0xsig${index}b`,
            chain_id: 84532,
            verifying_contract: '0x0000000000000000000000000000000000002000',
            validated_at: fixtureIso(139 - index * 11),
          },
        ],
        simulation: {
          success: true,
          gas_used: 0,
          risk_score: 18,
          warnings: [],
          output_amount: String(Math.round(amount * price * 100) / 100),
        },
      },
      decision_source: 'agent_execution',
      runner_signal: {
        strategy_module_id: 'hl-eth-breakout-v3',
        signal: index % 2 === 0 ? 'breakout_retest' : 'liquidity_sweep',
      },
      agent_reasoning: 'Trade sized from envelope budget after fast backtest and live spread check.',
      harness_version: 3,
      candidate_hash: 'sha256:fixture-candidate',
      revision_id: 'rev-live-3',
    };
  }).reverse();
}

function buildTradeEvidence(scope, allTrades, pageTrades) {
  const pricedFills = allTrades.filter((trade) => Number(trade.notional_usd) > 0).length;
  return {
    source: 'trade_store',
    scope,
    exact: true,
    total_fills: allTrades.length,
    loaded_fills: pageTrades.length,
    outside_page_fills: Math.max(0, allTrades.length - pageTrades.length),
    priced_fills: pricedFills,
    unpriced_fills: Math.max(0, allTrades.length - pricedFills),
    valuation_coverage: allTrades.length > 0 ? pricedFills / allTrades.length : 0,
    latest_indexed_at: allTrades[0]?.timestamp ?? null,
    oldest_indexed_at: allTrades.at(-1)?.timestamp ?? null,
    latest_loaded_at: pageTrades[0]?.timestamp ?? null,
    oldest_loaded_at: pageTrades.at(-1)?.timestamp ?? null,
  };
}

function buildFixtureCandles() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 80 * 60;
  return Array.from({ length: 80 }).map((_, index) => {
    const timestamp = start + index * 60;
    const base = 3430 + index * 1.05 + Math.sin(index / 4) * 18;
    const open = base - Math.sin(index / 3) * 5;
    const close = base + Math.cos(index / 5) * 6;
    const high = Math.max(open, close) + 10 + (index % 5);
    const low = Math.min(open, close) - 9 - (index % 4);
    return {
      timestamp,
      token: 'ETH',
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      volume: String(1800 + index * 12 + (index % 7) * 90),
    };
  });
}

function buildFixtureChartStudies(candles) {
  const first = candles[18];
  const middle = candles[44];
  const last = candles.at(-1);
  if (!first || !middle || !last) return [];

  const support = Number(first.close) - 18;
  const resistance = Number(last.close) + 24;
  return [
    {
      schema_version: 1,
      study_id: 'study-smoke-breakout-map',
      bot_id: FIXTURE_BOT_ID,
      token: 'ETH',
      venue: 'hyperliquid',
      interval: '1m',
      title: 'Breakout guard',
      summary: 'Agent-authored chart context for the current ETH perp thesis.',
      author: 'agent',
      created_at_ms: Date.now() - 9 * 60_000,
      valid_from_ms: first.timestamp * 1000,
      valid_to_ms: last.timestamp * 1000,
      run_id: 'run-smoke-1',
      trace_id: 'trace-smoke-1',
      overlays: [
        {
          overlay_id: 'agent-support',
          kind: 'level',
          label: 'Invalidation',
          color: '#F2B84B',
          confidence: 'medium',
          value: support,
          points: [],
        },
        {
          overlay_id: 'agent-resistance',
          kind: 'level',
          label: 'Take-profit watch',
          color: '#B788FF',
          confidence: 'medium',
          value: resistance,
          points: [],
        },
        {
          overlay_id: 'vwap-reclaim-path',
          kind: 'line',
          label: 'VWAP reclaim path',
          color: '#50D2C1',
          confidence: 'medium',
          points: [
            { timestamp_ms: first.timestamp * 1000, value: Number(first.close) - 6 },
            { timestamp_ms: middle.timestamp * 1000, value: Number(middle.close) + 4 },
            { timestamp_ms: last.timestamp * 1000, value: Number(last.close) + 8 },
          ],
        },
      ],
    },
  ];
}

function buildFixtureMetrics() {
  return Array.from({ length: 32 }).map((_, index) => {
    const value = 25_000 + index * 42 + Math.sin(index / 3) * 220;
    const highWater = 25_000 + index * 58;
    return {
      timestamp: new Date(Date.now() - (31 - index) * 45 * 60_000).toISOString(),
      bot_id: FIXTURE_BOT_ID,
      account_value_usd: Math.round(value * 100) / 100,
      unrealized_pnl: Math.round((value - 25_000) * 100) / 100,
      realized_pnl: Math.round(index * 18.5 * 100) / 100,
      high_water_mark: Math.round(highWater * 100) / 100,
      drawdown_pct: Math.max(0, Math.round(((highWater - value) / highWater) * 10_000) / 100),
      positions_count: 2,
      trade_count: Math.min(12, Math.floor(index / 2)),
    };
  });
}

function buildFixtureMessages() {
  const created = Date.now() - 20 * 60_000;
  return [
    {
      id: 'msg-user-1',
      role: 'user',
      timestamp: new Date(created).toISOString(),
      parts: [{ type: 'text', text: 'Review the ETH breakout retest and keep risk bounded.' }],
    },
    {
      id: 'msg-agent-1',
      role: 'assistant',
      timestamp: new Date(created + 45_000).toISOString(),
      success: true,
      parts: [
        {
          type: 'reasoning',
          text: 'Breakout retest is valid only if liquidity remains above the envelope threshold and spread stays tight.',
        },
        {
          type: 'tool',
          id: 'tool-backtest',
          tool: 'fast_backtest',
          state: {
            status: 'complete',
            input: { symbol: 'ETH', window: '7d', strategy: 'breakout_retest' },
            output: { net_pnl_pct: 2.8, max_drawdown_pct: 0.9, trades: 47 },
          },
        },
        {
          type: 'text',
          text: 'Breakout retest passed the fast replay. I kept size small, placed the probe, and will demote if live drift exceeds the budget.',
        },
      ],
    },
  ];
}

function buildFixtureObservatoryOverview(bot) {
  const reflectionCreatedAt = fixtureIso(20);
  return {
    schema_version: 1,
    bot_count: 1,
    totals: {
      reflection_runs: 1,
      ideas: 1,
      delegated_work_sessions: 1,
    },
    bots: [
      {
        bot_id: bot.id,
        bot_name: bot.name,
        strategy_type: bot.strategy_type,
        trading_active: bot.trading_active,
        paper_trade: bot.paper_trade,
        error: null,
        records: {
          schema_version: 1,
          world_signal_digests: [
            {
              digest_id: 'digest-smoke-1',
              bot_id: bot.id,
              created_at: reflectionCreatedAt,
              source_status: 'captured',
              freshness: fixtureIso(21),
              confidence: 'medium',
              source_count: 2,
              signals: [
                'ETH liquidity remained above the envelope threshold.',
                'Funding drift stayed inside the paper promotion gate.',
              ],
              unavailable_reason: null,
              evidence_ref: 'artifact://fixture/observatory/context#digest-smoke-1',
            },
          ],
          reflection_runs: [
            {
              run_id: 'observatory-smoke-1',
              bot_id: bot.id,
              bot_name: bot.name,
              created_at: reflectionCreatedAt,
              trigger: 'manual',
              requested_by: FIXTURE_OPERATOR,
              mode: 'agentic-observatory',
              world_model_questions: ['What signal am I missing before the next ETH perp tick?'],
              evidence: {
                fills_checked: 12,
                market_context: 'fixture',
              },
              conclusions: ['External signal coverage is present but should stay paper gated.'],
              uncertainties: ['News and cross-venue liquidity are simulated in this fixture.'],
              findings: [
                {
                  code: 'external-signal-coverage',
                  severity: 'medium',
                  summary: 'The bot has recent ETH signal context but needs continued delegated review.',
                },
              ],
              idea_ids: ['idea-smoke-1'],
              delegated_session_ids: ['research-session-smoke-1'],
              delegation_pressure: {
                unique_sessions: 1,
                active_sessions: 1,
                terminal_sessions: 0,
                duplicate_rows_removed: 0,
                by_status: { queued_research: 1 },
                by_source: { 'owner-feedback:research': 1 },
                usage_reporting_status: 'partial',
                usage_event_count: 2,
                total_tokens: 2760,
                cost_usd: 0.0184,
                limits: { max_active_delegations: 3, max_cpu_pressure: 0.85, min_free_memory_mb: 512 },
                pressure_level: 'low',
                allows_new_delegation: true,
                deny_reasons: ['active_delegation_cap'],
              },
              usage_summary: {
                event_count: 2,
                reporting_status: 'partial',
                input_tokens: 1842,
                output_tokens: 918,
                total_tokens: 2760,
                cost_usd: 0.0184,
                providers: ['fixture'],
                models: ['fixture-agent'],
              },
            },
          ],
          ideas: [
            {
              idea_id: 'idea-smoke-1',
              bot_id: bot.id,
              created_at: reflectionCreatedAt,
              title: 'Research ETH cross-venue signal gap',
              thesis: 'The bot should keep delegating external signal checks before sizing up.',
              evidence_refs: ['artifact://fixture/observatory/context#digest-smoke-1'],
              expected_value: 'Give the bot fresher market context without touching funds.',
              risk: 'paper_only_until_existing_promotion_gates_pass',
              proposed_action: 'delegate_research',
              status: 'open',
              source_run_id: 'observatory-smoke-1',
            },
          ],
          research_tasks: [
            {
              task_id: 'research-smoke-1',
              bot_id: bot.id,
              idea_id: 'idea-smoke-1',
              feedback_id: 'feedback-smoke-1',
              owner: FIXTURE_OPERATOR,
              created_at: reflectionCreatedAt,
              updated_at: fixtureIso(18),
              status: 'queued_research',
              worker: 'observatory-research-queue',
              worker_launch: 'manual_or_research_tick',
              title: 'Research ETH cross-venue signal gap',
              thesis: 'The bot should keep delegating external signal checks before sizing up.',
              evidence_refs: ['artifact://fixture/observatory/context#digest-smoke-1'],
              prompt: `Research-only Observatory task for bot ${bot.id}.`,
              acceptance_criteria: ['Source-grounded finding is recorded.'],
              safety_limits: { can_touch_funds: false, can_trade: false, can_promote: false },
              result_ref: 'artifact://fixture/observatory/research-results#research-smoke-1',
              result_summary: 'Source-grounded finding is recorded. ETH liquidity context remains paper gated until promotion checks pass.',
            },
          ],
          delegated_work_sessions: [
            {
              session_id: 'research-session-smoke-1',
              bot_id: bot.id,
              source: 'owner-feedback:research',
              status: 'queued_research',
              created_at: reflectionCreatedAt,
              idea_id: 'idea-smoke-1',
              task_id: 'research-smoke-1',
              summary: 'Owner queued read-only ETH signal research.',
              artifact_ref: 'artifact://fixture/observatory/research-tasks#research-smoke-1',
            },
          ],
          owner_feedback: [],
          delegation_pressure: {
            unique_sessions: 1,
            active_sessions: 1,
            terminal_sessions: 0,
            duplicate_rows_removed: 0,
            by_status: { queued_research: 1 },
            by_source: { 'owner-feedback:research': 1 },
            usage_reporting_status: 'partial',
            usage_event_count: 2,
            total_tokens: 2760,
            cost_usd: 0.0184,
            limits: { max_active_delegations: 3, max_cpu_pressure: 0.85, min_free_memory_mb: 512 },
            pressure_level: 'low',
            allows_new_delegation: true,
            deny_reasons: ['active_delegation_cap'],
          },
        },
      },
    ],
  };
}

function startFixtureOperatorServer({ emptyRunTranscript = false } = {}) {
  const bot = buildFixtureBotRecord();
  const trades = buildFixtureTrades();
  const candles = buildFixtureCandles();
  const chartStudies = buildFixtureChartStudies(candles);
  const metrics = buildFixtureMetrics();
  const messages = buildFixtureMessages();
  const observatoryOverview = buildFixtureObservatoryOverview(bot);
  const platformBuckets = Array.from({ length: 24 }).map((_, index) => ({
    timestamp: new Date(Date.now() - (23 - index) * 60 * 60_000).toISOString(),
    bucket_usd: 12_000 + index * 530,
    paper_usd: 9_000 + index * 410,
    live_usd: 3_000 + index * 120,
    priced_trade_count: 2 + (index % 3),
    total_trade_count: 2 + (index % 3),
  }));

  const server = createHttpServer((req, res) => {
    if (!req.url || !req.method) {
      text(res, 400, 'Bad request');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      });
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://fixture.local');
    const pathname = url.pathname;

    if (pathname === '/api/meta') {
      json(res, 200, {
        api_version: '1',
        deployment_kind: 'fleet',
        features: { chat: true, terminal: false },
      });
      return;
    }
    if (pathname === '/api/observatory/overview') {
      json(res, 200, observatoryOverview);
      return;
    }
    if (pathname === '/api/bots') {
      json(res, 200, { bots: [bot] });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}`) {
      json(res, 200, bot);
      return;
    }
    if (pathname === '/api/platform/volume') {
      json(res, 200, {
        from: url.searchParams.get('from') ?? fixtureIso(24 * 60),
        to: url.searchParams.get('to') ?? new Date().toISOString(),
        bucket: url.searchParams.get('bucket') === 'day' ? 'day' : 'hour',
        buckets: platformBuckets,
        summary: platformBuckets.reduce((summary, bucket) => ({
          total_usd: summary.total_usd + bucket.bucket_usd,
          paper_usd: summary.paper_usd + bucket.paper_usd,
          live_usd: summary.live_usd + bucket.live_usd,
          priced_trade_count: summary.priced_trade_count + bucket.priced_trade_count,
          total_trade_count: summary.total_trade_count + bucket.total_trade_count,
        }), {
          total_usd: 0,
          paper_usd: 0,
          live_usd: 0,
          priced_trade_count: 0,
          total_trade_count: 0,
        }),
      });
      return;
    }
    if (pathname === '/api/platform/trades') {
      const limit = Number(url.searchParams.get('limit') ?? trades.length);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const pageTrades = trades.slice(offset, offset + limit);
      json(res, 200, {
        trades: pageTrades,
        total: trades.length,
        limit,
        offset,
        evidence: buildTradeEvidence('platform', trades, pageTrades),
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/trades`) {
      const limit = Number(url.searchParams.get('limit') ?? trades.length);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const pageTrades = trades.slice(offset, offset + limit);
      json(res, 200, {
        trades: pageTrades,
        total: trades.length,
        limit,
        offset,
        evidence: buildTradeEvidence('bot', trades, pageTrades),
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/portfolio/state`) {
      json(res, 200, {
        total_value_usd: 26842.55,
        cash_balance: 21940.2,
        source: 'hyperliquid_nav',
        observed_at: new Date().toISOString(),
        stale: false,
        warnings: [],
        has_unpriced_positions: false,
        has_value_only_positions: false,
        positions: [
          {
            token: 'ETH',
            symbol: 'ETH',
            amount: '1.42',
            value_usd: '4986.64',
            entry_price: '3438.20',
            current_price: '3511.72',
            pnl_percent: '2.14',
            unrealized_pnl_usd: '104.39',
            weight: '18.58',
            protocol: 'hyperliquid',
            position_type: 'long_perp',
            margin_used_usd: '498.66',
            notional_usd: '4986.64',
            leverage: '10',
            liquidation_price: '3182.40',
            valuation_status: 'priced',
          },
          {
            token: 'USDC',
            symbol: 'USDC',
            amount: '21940.2',
            value_usd: '21940.2',
            current_price: '1',
            weight: '81.42',
            protocol: 'hyperliquid',
            position_type: 'cash',
            valuation_status: 'value_only',
          },
        ],
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/metrics/history`) {
      json(res, 200, { snapshots: metrics });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/metrics`) {
      json(res, 200, {
        portfolio_value_usd: 26842.55,
        total_pnl: 1842.55,
        trade_count: 12,
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/market-data/candles`) {
      json(res, 200, { candles, total: candles.length });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/chart/studies`) {
      const limit = Number(url.searchParams.get('limit') ?? chartStudies.length);
      json(res, 200, {
        studies: chartStudies.slice(0, limit),
        total: chartStudies.length,
        limit,
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/runs`) {
      json(res, 200, {
        runs: [
          {
            run_id: 'run-smoke-1',
            workflow_id: 7001,
            workflow_kind: 'trading',
            status: 'completed',
            started_at: Math.floor(Date.now() / 1000) - 900,
            completed_at: Math.floor(Date.now() / 1000) - 720,
            session_id: null,
            transcript_available: true,
            trace_id: 'trace-smoke-1',
            duration_ms: 180_000,
            input_tokens: 1842,
            output_tokens: 934,
            result: 'Placed a bounded ETH breakout probe after fast replay and liquidity check.',
            error: null,
          },
        ],
        next_cursor: null,
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/runs/run-smoke-1/messages`) {
      json(res, 200, { messages: emptyRunTranscript ? [] : messages });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/session/sessions`) {
      json(res, 200, {
        sessions: [
          {
            id: `trading-${FIXTURE_BOT_ID}`,
            title: 'ETH breakout review',
            created_at: fixtureIso(30),
            updated_at: fixtureIso(15),
          },
        ],
      });
      return;
    }
    if (pathname === `/api/bots/${FIXTURE_BOT_ID}/session/sessions/trading-${FIXTURE_BOT_ID}/messages`) {
      json(res, 200, { messages });
      return;
    }

    text(res, 404, `Fixture route not found: ${pathname}`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Fixture operator did not bind to a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        async close() {
          await new Promise((closeResolve) => server.close(closeResolve));
        },
      });
    });
  });
}

async function startFixtureAppServer(operatorUrl, { ownerPerformance = false } = {}) {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn('pnpm', [
    'exec',
    'react-router',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: ARENA_DIR,
    env: {
      ...process.env,
      VITE_OPERATOR_API_URL: '/operator-api',
      VITE_CLOUD_OPERATOR_API_URL: '/operator-api',
      VITE_INSTANCE_OPERATOR_API_URL: '',
      VITE_TEE_OPERATOR_API_URL: '',
      VITE_OPERATOR_PROXY_TARGET: operatorUrl,
      VITE_USE_LOCAL_CHAIN: 'false',
      VITE_CHAIN_ID: String(FIXTURE_WALLET_CHAIN_ID),
      ...(ownerPerformance ? { VITE_OPERATOR_E2E_AUTH_ADDRESS: FIXTURE_OPERATOR } : {}),
      BROWSER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  await waitFor(async () => {
    if (child.exitCode != null) {
      throw new Error(`Fixture app server exited early (${child.exitCode}).\n${output}`);
    }
    try {
      const response = await fetch(url, { headers: { Accept: 'text/html' } });
      return response.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 60_000, intervalMs: 500 });

  return {
    url,
    async close() {
      if (child.exitCode == null) {
        child.kill('SIGTERM');
      }
      await wait(250);
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
    },
  };
}

async function launchChrome(chromePath) {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'arena-smoke-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Chromium did not expose a DevTools endpoint.\n${stderr}`));
    }, 8000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools was ready: ${code}\n${stderr}`));
    });
  });

  const port = Number(new URL(endpoint).port);
  return {
    child,
    port,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const exited = await waitForProcessExit(child, 2000);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForProcessExit(child, 2000);
        }
      }
      await removeDirectoryWithRetries(profileDir);
    },
  };
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.handleMessage(event));
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    const listeners = this.events.get(message.method);
    if (!listeners) return;
    for (const listener of listeners) listener(message.params ?? {});
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }

  on(method, listener) {
    const listeners = this.events.get(method) ?? new Set();
    listeners.add(listener);
    this.events.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.ws.close();
  }
}

async function newPage(port) {
  const target = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return page;
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
	  });
	  if (result.exceptionDetails) {
	    const details = result.exceptionDetails;
	    const description = details.exception?.description
	      ?? details.exception?.value
	      ?? details.text
	      ?? 'Runtime.evaluate failed';
	    throw new Error(description);
	  }
  return result.result?.value;
}

async function installFixtureOwnerAuth(page) {
  const session = {
    token: FIXTURE_OWNER_TOKEN,
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      try {
        const address = ${JSON.stringify(FIXTURE_OPERATOR)};
        const storageKeys = [
          ${JSON.stringify(FIXTURE_OWNER_AUTH_KEY)},
          'arena.operator_auth.' + address.toLowerCase() + '::/operator-api',
          'arena.operator_auth.' + address.toLowerCase() + '::',
        ];
        const session = ${JSON.stringify(session)};
        window.sessionStorage?.setItem('arena.operator_auth.address', address);
        window.localStorage?.setItem('arena.operator_auth.address', address);
        for (const storageKey of storageKeys) {
          window.sessionStorage?.setItem(storageKey, JSON.stringify(session));
          window.localStorage?.setItem(storageKey, JSON.stringify(session));
        }
      } catch {
        // Storage can be unavailable in constrained browser contexts.
      }
    })();`,
  });
}

async function installFixtureWallet(page) {
  const chainIdHex = `0x${FIXTURE_WALLET_CHAIN_ID.toString(16)}`;
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const address = ${JSON.stringify(FIXTURE_WALLET_ADDRESS)};
      let chainId = ${JSON.stringify(chainIdHex)};
      const listeners = new Map();
      const emit = (event, payload) => {
        const handlers = listeners.get(event);
        if (!handlers) return;
        for (const handler of Array.from(handlers)) {
          try {
            handler(payload);
          } catch {
            // Fixture wallet listeners are best-effort browser test plumbing.
          }
        }
      };
      const addListener = (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return provider;
      };
      const removeListener = (event, handler) => {
        listeners.get(event)?.delete(handler);
        return provider;
      };
      const provider = {
        isMetaMask: true,
        isConnected: () => true,
        _state: { accounts: [address], isConnected: true, isUnlocked: true },
        request: async ({ method, params }) => {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [address];
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [address] }] }];
            case 'eth_chainId':
              return chainId;
            case 'net_version':
              return String(Number.parseInt(chainId, 16));
            case 'wallet_switchEthereumChain': {
              const nextChainId = params?.[0]?.chainId;
              if (typeof nextChainId === 'string' && nextChainId) {
                chainId = nextChainId;
                emit('chainChanged', chainId);
              }
              return null;
            }
            case 'wallet_addEthereumChain': {
              const nextChainId = params?.[0]?.chainId;
              if (typeof nextChainId === 'string' && nextChainId) {
                chainId = nextChainId;
                emit('chainChanged', chainId);
              }
              return null;
            }
            case 'personal_sign':
            case 'eth_sign':
            case 'eth_signTypedData':
            case 'eth_signTypedData_v4':
              return '0x' + '11'.repeat(65);
            default:
              throw Object.assign(new Error('Unsupported fixture wallet method: ' + method), {
                code: 4200,
              });
          }
        },
        on: addListener,
        addListener,
        removeListener,
        off: removeListener,
      };

      Object.defineProperty(window, 'ethereum', {
        value: provider,
        configurable: true,
        enumerable: true,
        writable: false,
      });
      try {
        window.localStorage?.setItem('wagmi.recentConnectorId', JSON.stringify('metaMask'));
        window.localStorage?.removeItem('wagmi.metaMask.disconnected');
      } catch {
        // Storage can be unavailable in constrained browser contexts.
      }
      window.dispatchEvent(new Event('ethereum#initialized'));
    })();`,
  });
}

async function navigate(page, url) {
  await page.send('Page.navigate', { url });
  await waitForDocument(page);
  await wait(250);
}

async function reload(page) {
  await page.send('Page.reload', { ignoreCache: true });
  await waitForDocument(page);
  await wait(500);
}

async function waitForDocument(page) {
  await waitFor(async () => {
    const readyState = await evaluate(page, 'document.readyState');
    return readyState === 'interactive' || readyState === 'complete';
  }, { timeoutMs: 15_000 });
  await waitFor(async () => {
    return evaluate(page, `Boolean(document.body && document.body.children.length > 0)`);
  }, { timeoutMs: 15_000, intervalMs: 100 });
}

function withTheme(baseUrl, theme = '') {
  const url = new URL(baseUrl);
  if (theme) url.searchParams.set('theme', theme);
  return url.toString();
}

function withPath(baseUrl, pathPart, theme = '') {
  const url = new URL(baseUrl);
  url.pathname = pathPart;
  url.search = '';
  if (theme) url.searchParams.set('theme', theme);
  url.hash = '';
  return url.toString();
}

function themeSuffix(theme = '') {
  return theme ? `-${theme}` : '';
}

function textIncludes(bodyText, expected) {
  const normalizedBody = bodyText.toLowerCase();
  return expected.every((item) => {
    if (Array.isArray(item)) {
      return item.some((text) => normalizedBody.includes(text.toLowerCase()));
    }
    return normalizedBody.includes(item.toLowerCase());
  });
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function discoverOperatorApiUrlFromBuild(baseUrl) {
  const html = await fetchText(baseUrl);
  const assetPaths = Array.from(html.matchAll(/(?:src|href)="([^"]*\/assets\/meta-[^"]+\.js)"/g))
    .map((match) => match[1])
    .filter(Boolean);

  for (const assetPath of assetPaths) {
    const assetUrl = new URL(assetPath, baseUrl).toString();
    const source = await fetchText(assetUrl);
    const urls = Array.from(source.matchAll(/https?:\/\/[^"',\s)]+/g))
      .map((match) => match[0])
      .filter((url) => !url.includes('fonts.googleapis.com') && !url.includes('fonts.gstatic.com'));
    const operatorUrl = urls.find((url) => /sslip\.io|operator|api/i.test(url));
    if (operatorUrl) {
      return operatorUrl.replace(/\/+$/, '');
    }
  }

  return null;
}

function parseBotIdFromHref(href) {
  try {
    const match = new URL(href).pathname.match(/\/arena\/bot\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function chooseRecentlyTradedBotId(baseUrl, candidateIds) {
  if (candidateIds.length === 0) return null;
  const candidateSet = new Set(candidateIds);
  let operatorApiUrl = null;
  try {
    operatorApiUrl = await discoverOperatorApiUrlFromBuild(baseUrl);
  } catch {
    operatorApiUrl = null;
  }
  if (!operatorApiUrl) return null;

  try {
    const payload = await fetchJson(`${operatorApiUrl}/api/platform/trades?limit=100`);
    const trades = Array.isArray(payload?.trades) ? payload.trades : [];
    const match = trades
      .map((trade) => (typeof trade?.bot_id === 'string' ? trade.bot_id : null))
      .find((botId) => botId && candidateSet.has(botId));
    if (match) {
      console.log(`[arena-smoke] selected recently traded bot ${match}`);
      return match;
    }
  } catch {
    return null;
  }

  return null;
}

async function assertBrowserOperatorApis(page, baseUrl) {
  let operatorApiUrl = null;
  try {
    operatorApiUrl = await discoverOperatorApiUrlFromBuild(baseUrl);
  } catch (error) {
    throw new Error(`Could not inspect deployed operator URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!operatorApiUrl) {
    console.warn('[arena-smoke] no deployed operator URL found in build metadata; skipping browser API/CORS check');
    return;
  }

  const now = Date.now();
  const from = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now).toISOString();
  const endpoints = [
    '/api/meta',
    '/api/bots?limit=1',
    '/api/platform/trades?limit=1',
    `/api/platform/volume?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=hour`,
  ];

  await navigate(page, baseUrl);
  const results = await evaluate(page, `(async () => {
    const operatorApiUrl = ${JSON.stringify(operatorApiUrl)};
    const endpoints = ${JSON.stringify(endpoints)};
    return Promise.all(endpoints.map(async (endpoint) => {
      const url = new URL(endpoint, operatorApiUrl).toString();
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
        const body = await response.text();
        return {
          endpoint,
          ok: response.ok,
          status: response.status,
          corsOrigin: response.headers.get('access-control-allow-origin'),
          body: body.slice(0, 160),
        };
      } catch (error) {
        return {
          endpoint,
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  })()`);

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    throw new Error(`Browser operator API/CORS check failed for ${operatorApiUrl}:\n${failures.map((failure) =>
      `- ${failure.endpoint}: status=${failure.status}${failure.error ? ` error=${failure.error}` : ''} body=${JSON.stringify(failure.body ?? '')}`,
    ).join('\n')}`);
  }

  console.log(`[arena-smoke] browser operator API/CORS passed for ${operatorApiUrl}`);
}

async function discoverAgentId(page, baseUrl, allowEmpty) {
  await navigate(page, baseUrl);
  let hrefs = [];
  let debugMetrics = null;
  try {
    hrefs = await waitFor(() => evaluate(page, `(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/arena/bot/"]'))
      .map((link) => link.href)
      .filter(Boolean);
    const uniqueLinks = Array.from(new Set(links));
    return uniqueLinks.length > 0 ? uniqueLinks : null;
  })()`), { timeoutMs: 45_000, intervalMs: 250 });
  } catch {
    debugMetrics = await evaluate(page, `(() => ({
      pathname: location.pathname,
      bodyText: document.body.innerText.slice(0, 1200),
      links: Array.from(document.querySelectorAll('a[href*="/arena/bot/"]'))
        .map((link) => link.getAttribute('href'))
        .filter(Boolean)
        .slice(0, 12),
    }))()`).catch(() => null);
    hrefs = [];
  }

  const candidateIds = hrefs
    .map((href) => parseBotIdFromHref(href))
    .filter((botId) => typeof botId === 'string' && botId.length > 0);
  const recentlyTradedBotId = await chooseRecentlyTradedBotId(baseUrl, candidateIds);
  if (recentlyTradedBotId) {
    return recentlyTradedBotId;
  }

  const href = hrefs.find((url) => /\/arena\/bot\/[^/]+\/performance(?:$|[?#])/.test(new URL(url).pathname))
    || hrefs.find((url) => /\/arena\/bot\/[^/]+/.test(new URL(url).pathname))
    || null;
  if (!href) {
    const debugSuffix = debugMetrics
      ? ` body="${debugMetrics.bodyText}" links=${JSON.stringify(debugMetrics.links)}`
      : '';
    const message = `No rendered /arena/bot/:id link found. Run against a live app with agents or a fixture deployment.${debugSuffix}`;
    if (allowEmpty) {
      console.warn(`[arena-smoke] ${message}`);
      return null;
    }
    throw new Error(message);
  }

  const match = new URL(href).pathname.match(/\/arena\/bot\/([^/]+)/);
  if (!match) throw new Error(`Could not parse bot id from ${href}`);
  return decodeURIComponent(match[1]);
}

async function setViewport(page, viewport) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function captureScreenshot(page, screenshotDir, viewport, section, suffix = '') {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  const filename = `${viewport.width}x${viewport.height}-${section}${suffix}.png`;
  await writeFile(path.join(screenshotDir, filename), Buffer.from(result.data, 'base64'));
}

function getSectionExpectations(section, {
  fixture = false,
  fixtureEmptyRunTranscript = false,
  ownerPerformance = false,
} = {}) {
  if (ownerPerformance && section === 'performance') {
    return ['Price', 'ETH', 'Fills'];
  }
  if (!fixture) {
    return LIVE_SECTION_EXPECTATIONS[section] ?? [];
  }
  if (fixtureEmptyRunTranscript && section === 'runs') {
    return ['Decision Path', 'Evidence Record', 'No visible messages'];
  }
  return SECTION_EXPECTATIONS[section] ?? [];
}

async function assertWorkspaceFits(page, baseUrl, botId, {
  fixture = false,
  fixtureEmptyRunTranscript = false,
  ownerPerformance = false,
  screenshotDir = '',
  theme = '',
} = {}) {
  const failures = [];
  const sections = ownerPerformance ? ['performance'] : WORKSPACE_SECTIONS;

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    for (const section of sections) {
      const route = `/arena/bot/${encodeURIComponent(botId)}/${section}`;
      await navigate(page, withPath(baseUrl, route, theme));
      let metrics;
      try {
        metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
        const scrolling = document.scrollingElement || document.documentElement;
        const main = document.querySelector('main');
        const workspaceNav = document.querySelector('[aria-label="Agent workspace sections"]');
        const workspaceShell = workspaceNav?.closest('aside')?.parentElement ?? workspaceNav?.parentElement ?? main;
        let minWorkspaceOpacity = 1;
        let transformedWorkspaceAncestor = null;
        for (let el = workspaceShell; el && el !== document.body; el = el.parentElement) {
          const style = window.getComputedStyle(el);
          const opacity = Number.parseFloat(style.opacity || '1');
          if (Number.isFinite(opacity)) minWorkspaceOpacity = Math.min(minWorkspaceOpacity, opacity);
          if (!transformedWorkspaceAncestor && style.transform && style.transform !== 'none') {
            transformedWorkspaceAncestor = {
              tagName: el.tagName.toLowerCase(),
              className: typeof el.className === 'string' ? el.className.slice(0, 140) : '',
              transform: style.transform,
            };
          }
        }
        return {
          title: document.title,
          pathname: location.pathname,
          bodyText: document.body.innerText.slice(0, 20000),
          performanceSurfaceReady: Boolean(document.querySelector('[data-testid="tradingview-performance-chart"]'))
            || /No performance snapshots available yet|Live performance unavailable/i.test(document.body.innerText),
          scrollHeight: scrolling.scrollHeight,
          clientHeight: scrolling.clientHeight,
          innerHeight: window.innerHeight,
          mainScrollHeight: main?.scrollHeight ?? 0,
          mainClientHeight: main?.clientHeight ?? 0,
          minWorkspaceOpacity,
          transformedWorkspaceAncestor,
        };
      })()`);
        const expected = getSectionExpectations(section, {
          fixture,
          fixtureEmptyRunTranscript,
          ownerPerformance,
        });
        const hasExpectedText = textIncludes(nextMetrics.bodyText, expected);
        const performanceFillsStillLoading = section === 'performance'
          && /\bFills\s+Loading\b/i.test(nextMetrics.bodyText);
        const isStillLoading = /Loading bot data|Loading workspace|Loading autonomous runs|Loading performance/i.test(nextMetrics.bodyText)
          || performanceFillsStillLoading;
        const performanceSurfaceMissing = section === 'performance' && !nextMetrics.performanceSurfaceReady;
        return hasExpectedText && !isStillLoading && !performanceSurfaceMissing ? nextMetrics : false;
        }, { timeoutMs: 12_000, intervalMs: 250 });
      } catch {
        const debugMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 900),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        failures.push(`${viewport.width}x${viewport.height} ${section}: timed out waiting for ${JSON.stringify(getSectionExpectations(section, { fixture, fixtureEmptyRunTranscript, ownerPerformance }))}; body="${debugMetrics.bodyText}"`);
        continue;
      }

      if (metrics.scrollHeight > metrics.innerHeight + 2) {
        failures.push(`${viewport.width}x${viewport.height} ${section}: document scrollHeight ${metrics.scrollHeight} > innerHeight ${metrics.innerHeight}`);
      }
      if (!metrics.pathname.endsWith(`/${section}`)) {
        failures.push(`${viewport.width}x${viewport.height} ${section}: ended on ${metrics.pathname}`);
      }
      if (/Bot Not Found|Unexpected Application Error/i.test(metrics.bodyText)) {
        failures.push(`${viewport.width}x${viewport.height} ${section}: route rendered an error state`);
      }
      if (metrics.minWorkspaceOpacity < 0.98) {
        failures.push(`${viewport.width}x${viewport.height} ${section}: workspace captured mid-fade with ancestor opacity ${metrics.minWorkspaceOpacity}`);
      }
      if (metrics.transformedWorkspaceAncestor) {
        failures.push(`${viewport.width}x${viewport.height} ${section}: workspace ancestor still transformed ${JSON.stringify(metrics.transformedWorkspaceAncestor)}`);
      }
      for (const text of getSectionExpectations(section, {
        fixture,
        fixtureEmptyRunTranscript,
        ownerPerformance,
      })) {
        if (!textIncludes(metrics.bodyText, [text])) {
          failures.push(`${viewport.width}x${viewport.height} ${section}: missing expected text "${text}"`);
        }
      }
      if (ownerPerformance && section === 'performance' && /Trade Tape|Decision Tape/i.test(metrics.bodyText)) {
        failures.push(`${viewport.width}x${viewport.height} ${section}: owner copilot rendered with public decision tape still visible`);
      }
      await captureScreenshot(page, screenshotDir, viewport, section, `${themeSuffix(theme)}${ownerPerformance ? '-owner' : ''}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Workspace viewport fit failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureHomeDashboard(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, withTheme(baseUrl, theme));
    let metrics;
    let reloadedHydrationFallback = false;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 5000),
            bodyHtml: document.body.innerHTML.slice(0, 5000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        if (
          !reloadedHydrationFallback
          && nextMetrics.bodyText.trim().length === 0
          && /__reactRouterContext|clientLoader|hydrateFallback/i.test(nextMetrics.bodyHtml)
        ) {
          reloadedHydrationFallback = true;
          await reload(page);
          return false;
        }
        return textIncludes(nextMetrics.bodyText, FIXTURE_HOME_EXPECTATIONS) ? nextMetrics : false;
      }, { timeoutMs: 30_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 900),
        bodyHtml: document.body.innerHTML.slice(0, 900),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} home: timed out waiting for ${JSON.stringify(FIXTURE_HOME_EXPECTATIONS)}; body="${debugMetrics.bodyText}" html="${debugMetrics.bodyHtml}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} home: route rendered an error state`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'home', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Home dashboard smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureLeaderboardDashboard(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, withPath(baseUrl, '/leaderboard', theme));
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 5000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        return nextMetrics.pathname.endsWith('/leaderboard')
          && textIncludes(nextMetrics.bodyText, FIXTURE_LEADERBOARD_EXPECTATIONS)
          ? nextMetrics
          : false;
      }, { timeoutMs: 12_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 900),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} leaderboard: timed out waiting for ${JSON.stringify(FIXTURE_LEADERBOARD_EXPECTATIONS)}; body="${debugMetrics.bodyText}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} leaderboard: route rendered an error state`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'leaderboard', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Leaderboard dashboard smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureActivityDashboard(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, withPath(baseUrl, '/activity', theme));
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 5000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        return nextMetrics.pathname.endsWith('/activity')
          && textIncludes(nextMetrics.bodyText, FIXTURE_ACTIVITY_EXPECTATIONS)
          ? nextMetrics
          : false;
      }, { timeoutMs: 12_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 900),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} activity: timed out waiting for ${JSON.stringify(FIXTURE_ACTIVITY_EXPECTATIONS)}; body="${debugMetrics.bodyText}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} activity: route rendered an error state`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'activity', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Activity dashboard smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureObservatoryDashboard(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, withPath(baseUrl, '/observatory', theme));
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 8000),
            hasDriverTrace: Boolean(document.querySelector('[data-observatory-trace-role="user"]')),
            hasAgentTrace: Boolean(document.querySelector('[data-observatory-trace-role="assistant"]')),
            hasRunGroup: Boolean(document.querySelector('[data-observatory-trace-role="assistant"] [data-state]')),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        return nextMetrics.pathname.endsWith('/observatory')
          && nextMetrics.hasDriverTrace
          && nextMetrics.hasAgentTrace
          && nextMetrics.hasRunGroup
          && textIncludes(nextMetrics.bodyText, FIXTURE_OBSERVATORY_EXPECTATIONS)
          ? nextMetrics
          : false;
      }, { timeoutMs: 12_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 1200),
        hasDriverTrace: Boolean(document.querySelector('[data-observatory-trace-role="user"]')),
        hasAgentTrace: Boolean(document.querySelector('[data-observatory-trace-role="assistant"]')),
        hasRunGroup: Boolean(document.querySelector('[data-observatory-trace-role="assistant"] [data-state]')),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} observatory: timed out waiting for ${JSON.stringify(FIXTURE_OBSERVATORY_EXPECTATIONS)}; metrics=${JSON.stringify(debugMetrics)}`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} observatory: route rendered an error state`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'observatory', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Observatory dashboard smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureCreateCommand(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, withPath(baseUrl, '/create', theme));
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 5000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        return nextMetrics.pathname.endsWith('/create')
          && textIncludes(nextMetrics.bodyText, FIXTURE_CREATE_EXPECTATIONS)
          ? nextMetrics
          : false;
      }, { timeoutMs: 12_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 900),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} create: timed out waiting for ${JSON.stringify(FIXTURE_CREATE_EXPECTATIONS)}; body="${debugMetrics.bodyText}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} create: route rendered an error state`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'create', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Create command smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureProvisionGate(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, withPath(baseUrl, '/provision', theme));
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            bodyText: document.body.innerText.slice(0, 5000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        return nextMetrics.pathname.endsWith('/provision')
          && textIncludes(nextMetrics.bodyText, FIXTURE_PROVISION_EXPECTATIONS)
          ? nextMetrics
          : false;
      }, { timeoutMs: 12_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 900),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} provision: timed out waiting for ${JSON.stringify(FIXTURE_PROVISION_EXPECTATIONS)}; body="${debugMetrics.bodyText}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} provision: route rendered an error state`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'provision', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Provision gate smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureProvisionConnected(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];
  const provisionUrl = new URL('/provision', baseUrl);
  provisionUrl.searchParams.set('blueprint', 'trading-cloud');
  if (theme) provisionUrl.searchParams.set('theme', theme);

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, provisionUrl.toString());
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            search: location.search,
            bodyText: document.body.innerText.slice(0, 8000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        const hasLaunchConsole = nextMetrics.pathname.endsWith('/provision')
          && nextMetrics.search.includes('blueprint=trading-cloud')
          && textIncludes(nextMetrics.bodyText, FIXTURE_PROVISION_CONNECTED_EXPECTATIONS);
        const isStillLoading = /Loading service|Loading operator|Loading blueprint/i.test(nextMetrics.bodyText);
        return hasLaunchConsole && !isStillLoading ? nextMetrics : false;
      }, { timeoutMs: 15_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        search: location.search,
        bodyText: document.body.innerText.slice(0, 1200),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} provision-connected: timed out waiting for ${JSON.stringify(FIXTURE_PROVISION_CONNECTED_EXPECTATIONS)}; body="${debugMetrics.bodyText}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} provision-connected: route rendered an error state`);
    }
    if (/Connect Wallet/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} provision-connected: still rendered disconnected wallet gate`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'provision-connected', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Connected provision smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function assertFixtureOwnerDashboard(page, baseUrl, { screenshotDir = '', theme = '' } = {}) {
  const failures = [];
  const dashboardUrl = new URL('/dashboard', baseUrl);
  if (theme) dashboardUrl.searchParams.set('theme', theme);

  for (const viewport of VIEWPORTS) {
    await setViewport(page, viewport);
    await navigate(page, dashboardUrl.toString());
    let metrics;
    try {
      metrics = await waitFor(async () => {
        const nextMetrics = await evaluate(page, `(() => {
          const scrolling = document.scrollingElement || document.documentElement;
          return {
            pathname: location.pathname,
            search: location.search,
            bodyText: document.body.innerText.slice(0, 8000),
            scrollHeight: scrolling.scrollHeight,
            innerHeight: window.innerHeight,
          };
        })()`);
        return nextMetrics.pathname.endsWith('/dashboard')
          && textIncludes(nextMetrics.bodyText, FIXTURE_DASHBOARD_EXPECTATIONS)
          ? nextMetrics
          : false;
      }, { timeoutMs: 15_000, intervalMs: 250 });
    } catch {
      const debugMetrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        search: location.search,
        bodyText: document.body.innerText.slice(0, 1200),
      }))()`);
      failures.push(`${viewport.width}x${viewport.height} dashboard: timed out waiting for ${JSON.stringify(FIXTURE_DASHBOARD_EXPECTATIONS)}; body="${debugMetrics.bodyText}"`);
      continue;
    }

    if (/Unexpected Application Error/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} dashboard: route rendered an error state`);
    }
    if (/Connect owner wallet/i.test(metrics.bodyText)) {
      failures.push(`${viewport.width}x${viewport.height} dashboard: still rendered disconnected wallet gate`);
    }
    await captureScreenshot(page, screenshotDir, viewport, 'dashboard', themeSuffix(theme));
  }

  if (failures.length > 0) {
    throw new Error(`Owner dashboard smoke failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

async function clickNav(page, label) {
  const clicked = await waitFor(() => evaluate(page, `(async () => {
    const normalize = (value) => value.replace(/\\s+/g, ' ').trim().toLowerCase();
    const target = normalize(${JSON.stringify(label)});
    const candidates = Array.from(document.querySelectorAll('button, a'));
    const element = candidates.find((item) =>
      normalize(item.textContent || '') === target
      || normalize(item.getAttribute('aria-label') || '') === target
      || normalize(item.getAttribute('title') || '') === target
    );
    if (!element) return false;
    element.click();
    return true;
  })()`), { timeoutMs: 8_000, intervalMs: 150 });
  if (!clicked) throw new Error(`Could not click workspace nav item: ${label}`);
}

async function clickButtonByLabel(page, label) {
  const clicked = await evaluate(page, `(() => {
    const label = ${JSON.stringify(label)};
    const button = Array.from(document.querySelectorAll('button'))
      .find((element) => element.getAttribute('aria-label') === label);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not click button: ${label}`);
}

async function assertRailWidthChange(page, label, beforeExpression, predicateExpression) {
  const before = await evaluate(page, beforeExpression);
  await clickButtonByLabel(page, label);
  const after = await waitFor(async () => {
    const value = await evaluate(page, beforeExpression);
    return await evaluate(page, `(() => {
      const before = ${JSON.stringify(before)};
      const value = ${JSON.stringify(value)};
      return (${predicateExpression})(before, value) ? value : false;
    })()`);
  }, { timeoutMs: 4_000, intervalMs: 100 });
  return { before, after };
}

async function assertCollapsibleRails(page, baseUrl, botId) {
  await setViewport(page, { width: 1600, height: 900 });
  await navigate(page, withPath(baseUrl, '/dashboard'));
  try {
    await waitFor(async () => {
      const metrics = await evaluate(page, `(() => {
        const nav = document.querySelector('nav[aria-label="Tangle navigation"]');
        const labels = Array.from(nav?.querySelectorAll('a, button') ?? [])
          .map((element) => [
            element.textContent,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ].filter(Boolean).join(' '))
          .join(' ');
        return {
          pathname: location.pathname,
          labels,
          bodyText: document.body.innerText.slice(0, 900),
        };
      })()`);
      return metrics.pathname.endsWith('/dashboard')
        && /My Agents/i.test(metrics.labels)
        && /Home/i.test(metrics.labels)
        && /New Agent/i.test(metrics.labels)
        ? metrics
        : false;
    }, { timeoutMs: 12_000, intervalMs: 250 });
  } catch (error) {
    const debugMetrics = await evaluate(page, `(() => ({
      pathname: location.pathname,
      navText: document.querySelector('nav[aria-label="Tangle navigation"]')?.textContent ?? '',
      bodyText: document.body.innerText.slice(0, 900),
    }))()`).catch(() => null);
    throw new Error(`Dashboard sidebar did not render expected navigation: ${JSON.stringify(debugMetrics)}; ${error instanceof Error ? error.message : String(error)}`);
  }

  const globalWidthExpression = `(() => document.querySelector('nav[aria-label="Tangle navigation"]')?.closest('aside')?.getBoundingClientRect().width ?? 0)()`;
  const initialGlobalWidth = await evaluate(page, globalWidthExpression);
  if (initialGlobalWidth <= 96) {
    const global = await assertRailWidthChange(
      page,
      'Expand sidebar',
      globalWidthExpression,
      '((before, value) => before <= 96 && value >= 220)',
    );
    if (global.after <= global.before) {
      throw new Error(`Global sidebar did not expand: ${global.before} -> ${global.after}`);
    }
    await clickButtonByLabel(page, 'Collapse sidebar');
  } else {
    const global = await assertRailWidthChange(
      page,
      'Collapse sidebar',
      globalWidthExpression,
      '((before, value) => before >= 220 && value <= 96)',
    );
    if (global.after >= global.before) {
      throw new Error(`Global sidebar did not collapse: ${global.before} -> ${global.after}`);
    }
    await clickButtonByLabel(page, 'Expand sidebar');
  }

  await navigate(page, withPath(baseUrl, `/arena/bot/${encodeURIComponent(botId)}/performance`));
  try {
    await waitFor(async () => {
      const metrics = await evaluate(page, `(() => ({
        pathname: location.pathname,
        bodyText: document.body.innerText.slice(0, 1200),
      }))()`);
      return metrics.pathname.endsWith('/performance') && /Performance|Market|Account/i.test(metrics.bodyText)
        ? metrics
        : false;
    }, { timeoutMs: 12_000, intervalMs: 250 });
  } catch (error) {
    const debugMetrics = await evaluate(page, `(() => ({
      pathname: location.pathname,
      bodyText: document.body.innerText.slice(0, 900),
    }))()`).catch(() => null);
    throw new Error(`Agent performance route did not settle after sidebar collapse check: ${JSON.stringify(debugMetrics)}; ${error instanceof Error ? error.message : String(error)}`);
  }

  const hasGlobalAgentChrome = await evaluate(page, `Boolean(document.querySelector('nav[aria-label="Tangle navigation"]'))`);
  if (hasGlobalAgentChrome) {
    throw new Error('Agent workspace route still rendered global arena navigation');
  }
}

async function assertRouteNavigation(page, baseUrl, botId) {
  await setViewport(page, VIEWPORTS[0]);
  await navigate(page, withPath(baseUrl, `/arena/bot/${encodeURIComponent(botId)}/portfolio`));
  await clickNav(page, 'Chat');
  await waitFor(async () => {
    const pathname = await evaluate(page, 'location.pathname');
    return pathname.endsWith('/chat');
  });
  await page.send('Page.navigateToHistoryEntry', {
    entryId: (await page.send('Page.getNavigationHistory')).entries.at(-2).id,
  });
  await waitFor(async () => {
    const pathname = await evaluate(page, 'location.pathname');
    return pathname.endsWith('/portfolio');
  });

  await clickNav(page, 'Chat');
  await waitFor(async () => {
    const pathname = await evaluate(page, 'location.pathname');
    return pathname.endsWith('/chat');
  });
  await clickNav(page, 'Back to agent');
  await waitFor(async () => {
    const pathname = await evaluate(page, 'location.pathname');
    return pathname.endsWith('/portfolio');
  });

  await navigate(page, withPath(baseUrl, `/arena/bot/${encodeURIComponent(botId)}/chat`));
  await clickNav(page, 'Back to agent');
  await waitFor(async () => {
    const pathname = await evaluate(page, 'location.pathname');
    return pathname.endsWith('/performance');
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fixtureOperator = null;
  let fixtureApp = null;

  if (args.fixture) {
    fixtureOperator = await startFixtureOperatorServer({
      emptyRunTranscript: args.fixtureEmptyRunTranscript,
    });
    fixtureApp = await startFixtureAppServer(fixtureOperator.url, {
      ownerPerformance: args.ownerPerformance,
    });
    args.url = fixtureApp.url;
    args.allowEmpty = false;
    console.log(`[arena-smoke] fixture app ${args.url} -> operator ${fixtureOperator.url}`);

    if (args.serveFixture) {
      try {
        if (args.readyFile) {
          await mkdir(path.dirname(args.readyFile), { recursive: true });
          await writeFile(args.readyFile, `${args.url}\n`);
        }
        console.log(`[arena-smoke] serving fixture app ${args.url}`);
        await waitForShutdownSignal();
      } finally {
        if (fixtureApp) await fixtureApp.close();
        if (fixtureOperator) await fixtureOperator.close();
      }
      return;
    }
  }

  const chromePath = findChrome(args.chrome);
  const browser = await launchChrome(chromePath);
  const page = await newPage(browser.port);
  const themes = args.themeMatrix ? ['light', 'dark'] : [''];

  try {
    if (args.fixture) {
      await installFixtureOwnerAuth(page);
    }
    const botId = args.fixture
      ? FIXTURE_BOT_ID
      : await discoverAgentId(page, args.url, args.allowEmpty);
    if (!botId) return;
    if (!args.fixture) {
      await assertBrowserOperatorApis(page, args.url);
    }
    if (args.fixture && !args.ownerPerformance) {
      for (const theme of themes) {
        await assertFixtureHomeDashboard(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
        await assertFixtureLeaderboardDashboard(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
        await assertFixtureActivityDashboard(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
        await assertFixtureObservatoryDashboard(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
        await assertFixtureCreateCommand(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
        await assertFixtureProvisionGate(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
      }
      await installFixtureWallet(page);
      for (const theme of themes) {
        await assertFixtureProvisionConnected(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
        await assertFixtureOwnerDashboard(page, args.url, {
          screenshotDir: args.screenshotDir,
          theme,
        });
      }
    }
    for (const theme of themes) {
      await assertWorkspaceFits(page, args.url, botId, {
        fixture: args.fixture,
        fixtureEmptyRunTranscript: args.fixtureEmptyRunTranscript,
        ownerPerformance: args.ownerPerformance,
        screenshotDir: args.screenshotDir,
        theme,
      });
    }
    if (!args.ownerPerformance) {
      await assertCollapsibleRails(page, args.url, botId);
      await assertRouteNavigation(page, args.url, botId);
    }
    console.log(`[arena-smoke] agent workspace passed for bot ${botId}${args.ownerPerformance ? ' (owner performance)' : ''}`);
  } finally {
    page.close();
    await browser.close();
    if (fixtureApp) await fixtureApp.close();
    if (fixtureOperator) await fixtureOperator.close();
  }
}

main().catch((error) => {
  console.error(`[arena-smoke] ${error.message}`);
  process.exit(1);
});
