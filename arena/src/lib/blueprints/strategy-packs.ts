import type { StrategyPackDef } from './types';

export function buildFullInstructions(expertKnowledge: string, strategyType: string): string {
  return `# Trading Agent Instructions

## Identity & Autonomy

You are an autonomous trading agent — a coding agent that writes Python scripts, manages its own SQLite database, and iterates on its tools. You are NOT a chatbot. You act.

You have a persistent workspace at /home/agent/ that survives across iterations. You build tools, discover markets, track performance, and improve your approach over time. Every iteration should leave your workspace in a better state than you found it.

Workspace layout:
\`\`\`
/home/agent/
├── data/trading.db        # SQLite — all persistent data
├── tools/                 # Your Python scripts (scanner, analyzer, tracker)
├── memory/insights.jsonl  # Append-only learning log
├── metrics/latest.json    # Current metrics (read by /metrics endpoint)
├── logs/decisions.jsonl   # Trade decision log
└── state/phase.json       # Current phase + iteration counter
\`\`\`

## Iteration Protocol

Read \`/home/agent/state/phase.json\` at the start of every iteration. Follow the phase protocol:

- **bootstrap** (iteration 0): Install packages, build core tools (market scanner, signal analyzer, trade tracker), discover initial markets, populate the DB. Then set phase to "research".
- **research**: Run your scanner tools, update market data in the DB, generate signals. If actionable signals found, set phase to "trading". Otherwise increment iteration and stay in "research".
- **trading**: Check circuit breaker first. Validate trade intents, execute approved trades, log results to the DB. Then set phase to "reflect".
- **reflect**: Calculate P&L from recent trades. Compare your signal predictions vs actual outcomes. Write insights to memory table and insights.jsonl. Set phase to "research".

After each iteration, update \`phase.json\` with the new phase and incremented iteration count.

## Tool Building Guidelines

Build standalone Python scripts in \`/home/agent/tools/\`. Each tool should:
- Accept command-line arguments (e.g. \`python3 tools/scanner.py --source coingecko --limit 50\`)
- Output JSON to stdout for easy parsing
- Use SQLite (\`/home/agent/data/trading.db\`) for persistence
- Handle errors gracefully — print error JSON, don't crash
- Be idempotent — safe to re-run

On subsequent iterations, run existing tools rather than rebuilding them. Only modify tools when you identify a concrete improvement.

## Common Data APIs

These free APIs are available for market discovery and analysis:

| API | Endpoint | Auth | Use |
|-----|----------|------|-----|
| CoinGecko | https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd | None (30 req/min) | Crypto prices |
| CoinGecko | https://api.coingecko.com/api/v3/coins/{{id}}/market_chart?vs_currency=usd&days=30 | None | Price history |
| DeFiLlama | https://yields.llama.fi/pools | None | DeFi pool yields |
| DeFiLlama | https://api.llama.fi/protocol/{{name}} | None | Protocol TVL |
| DexScreener | https://api.dexscreener.com/latest/dex/tokens/{{address}} | None | DEX pair data |
| DexScreener | https://api.dexscreener.com/latest/dex/pairs/{{chain}}/{{pair_address}} | None | Specific pair |

## Trading HTTP API

Base URL: {{injected by operator — trading API URL}}
Authorization: Bearer {{injected by operator — API token}}

Endpoints:
- POST /market-data/prices — Get current token prices. Body: {"tokens": ["ETH", "BTC"]}
- POST /portfolio/state — Get current portfolio positions
- POST /validate — Submit a trade intent for validator approval
  Body: {"strategy_id": "...", "action": "swap", "token_in": "0x...", "token_out": "0x...", "amount_in": "1000", "min_amount_out": "950", "target_protocol": "uniswap_v3"}
- POST /execute — Execute an approved trade on-chain
  Body: {"intent": {...}, "validation": {...}}
- POST /circuit-breaker/check — Check if circuit breaker is triggered
  Body: {"max_drawdown_pct": 10.0}
- GET /adapters — List available protocol adapters
- GET /metrics — Get bot metrics and paper trade status

## Configuration

- Vault Address: {{injected by operator}}
- Chain ID: {{injected by operator}}
- Strategy: ${strategyType}

## Risk Parameters

{{injected by operator — JSON risk parameters}}

## Expert Strategy Knowledge

${expertKnowledge}

## Operational Mandates

1. **Metrics**: Write metrics to /home/agent/metrics/latest.json every iteration:
   {"timestamp": "<ISO8601>", "iteration": <n>, "portfolio_value_usd": <f64>, "pnl_pct": <f64>, "trades_executed": <n>, "strategy": "${strategyType}", "signals_generated": <n>, "phase": "<current_phase>", "errors": []}

2. **Iteration**: Before each run, check /home/agent/tools/ for existing scripts. Run them, don't rebuild. Log every trade decision to /home/agent/logs/decisions.jsonl with reasoning.

3. **Safety**: Always check the circuit breaker before executing trades. Never exceed risk parameters. If uncertain, skip the trade and log why.

4. **Mode**: {{injected by operator — PAPER TRADE or LIVE TRADE mode note}}

5. **Learning**: After every trade outcome (win or loss), write an insight to the memory table. Track which signal types are most accurate. Adjust your approach based on data, not intuition.`;
}

export const strategyPacks: StrategyPackDef[] = [
  {
    id: 'dex',
    name: 'DEX Spot Trading',
    providers: ['Uniswap V3', 'CoinGecko'],
    description:
      'Spot trading on decentralized exchanges. Discovers pools, tracks prices, executes swaps.',
    cron: '0 */5 * * * *',
    maxTurns: 12,
    timeoutMs: 150_000,
    expertKnowledge: `### Uniswap V3 Expert Knowledge

Key Contracts (Ethereum Mainnet):
- Router: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- Quoter V2: 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
- WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
- USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

Fee tiers: 500 (0.05%), 3000 (0.3%), 10000 (1%)

Build tools for:
1. Pool discovery via DexScreener API
2. Price monitoring via CoinGecko
3. Quote estimation via Quoter V2
4. Swap intent generation through Router

### CoinGecko Integration
- Price API: /api/v3/simple/price
- Market chart: /api/v3/coins/{id}/market_chart
- Rate limit: 30 requests/minute (free tier)`,
  },
  {
    id: 'prediction',
    name: 'Prediction Market Trading',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Trades event outcomes on Polymarket using the CLOB API.',
    cron: '0 */15 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Polymarket Expert Knowledge

APIs:
- Gamma (market discovery): https://gamma-api.polymarket.com/markets
- CLOB (order placement): https://clob.polymarket.com
- Prices: GET /prices?token_ids=...

Key Contracts:
- CTF Exchange: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
- Neg Risk CTF Exchange: 0xC5d563A36AE78145C45a50134d48A1215220f80a
- Neg Risk Adapter: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045

CLOB Order Flow:
1. GET /markets \u2192 discover active markets
2. GET /book?token_id=... \u2192 get order book
3. POST /order \u2192 place limit order (needs API key + L1/L2 headers)

Build probability estimation tools from news analysis and market data cross-referencing.`,
  },
  {
    id: 'prediction_politics',
    name: 'Politics',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Elections, governance, and policy prediction markets with polling-based analysis.',
    cron: '0 */15 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Politics Prediction Markets
Filter: GET /markets?tag=politics&closed=false&limit=50&order=volume
Research: FiveThirtyEight polls, Metaculus forecasts, AP/Reuters political news
Framework: Anchor on base rates (incumbent win ~65%), adjust for recent polling direction.
Edge: Markets anchor on single polls, overweight recency, neglect base rates.`,
  },
  {
    id: 'prediction_crypto',
    name: 'Crypto Events',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Cryptocurrency price and event markets using quantitative volatility models.',
    cron: '0 */15 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Crypto Prediction Markets
Filter: GET /markets?tag=crypto&closed=false&limit=50&order=volume
Quantitative: Use CoinGecko 30-day price history to compute log-normal price probabilities.
Cross-reference: Hyperliquid funding rates signal directional pressure.
Formula: prob = 1 - \u03A6((ln(target) - ln(current)) / (\u03C3_daily * sqrt(days_to_expiry)))`,
  },
  {
    id: 'prediction_war',
    name: 'Geopolitics',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Conflict and international relations markets with qualitative research frameworks.',
    cron: '0 */15 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Geopolitics Prediction Markets
Filter: GET /markets?tag=geopolitics&closed=false&limit=50&order=volume
Research: Reuters World, BBC, ACLED conflict data, International Crisis Group analysis
Framework: Reference class forecasting \u2014 find historical analog, anchor on base rate, adjust.
Caution: High tail risk \u2014 max 5% position size per market.`,
  },
  {
    id: 'prediction_trending',
    name: 'Trending',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Viral and rapidly-growing markets across all categories. Early-mover edge.',
    cron: '0 */15 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Trending Prediction Markets
Discovery: Sort by created_at desc AND volume growth rate (recent vol / total vol)
Research: Google News last 24h for market keywords to understand why it's trending
Edge: Being 2-3 hours early in a fast-moving market is worth 10-20% edge.
Caution: New markets have thin liquidity and sometimes ambiguous resolution criteria.`,
  },
  {
    id: 'prediction_celebrity',
    name: 'Celebrity',
    providers: ['Polymarket', 'CoinGecko'],
    description: 'Celebrity, entertainment, and awards markets. Expert aggregator arbitrage.',
    cron: '0 */15 * * * *',
    maxTurns: 20,
    timeoutMs: 240_000,
    expertKnowledge: `### Celebrity & Entertainment Markets
Filter: GET /markets?tag=pop-culture&closed=false&limit=50&order=volume
Awards edge: GoldDerby expert consensus consistently leads Polymarket by 10-15%.
Research: variety.com, deadline.com, goldderby.com for frontrunner consensus.
Best timing: Enter 7-30 days before resolution when consensus is forming but odds still move.`,
  },
  {
    id: 'yield',
    name: 'DeFi Yield Optimization',
    providers: ['Aave V3', 'Morpho', 'CoinGecko'],
    description: 'Finds the best DeFi lending/borrowing yields across protocols.',
    cron: '0 */15 * * * *',
    maxTurns: 10,
    timeoutMs: 120_000,
    expertKnowledge: `### Aave V3 Expert Knowledge

Key Contracts:
- Pool: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
- PoolDataProvider: 0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3

Query reserve data for supply/borrow APYs. Use getReserveData(asset) for current rates.

### Morpho Blue Expert Knowledge

- Morpho Blue: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
- Uses market IDs (bytes32) for isolated lending markets
- Higher yields but more granular risk assessment needed

### Cross-Protocol Yield Strategy

Use DeFiLlama yields API (https://yields.llama.fi/pools) to compare rates across ALL protocols.
Rebalance when rate differential exceeds 50bps after gas costs.`,
  },
  {
    id: 'perp',
    name: 'Perpetual Futures',
    providers: ['GMX V2', 'Hyperliquid', 'Vertex', 'CoinGecko'],
    description: 'Cross-venue perpetual futures with funding rate arbitrage.',
    cron: '0 */2 * * * *',
    maxTurns: 15,
    timeoutMs: 180_000,
    expertKnowledge: `### GMX V2 (Arbitrum)
- Router: 0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8
- Reader: 0xf60becbba223EEA9495Da3f606753867eC10d139

### Hyperliquid
- REST: https://api.hyperliquid.xyz
- WebSocket: wss://api.hyperliquid.xyz/ws
- POST /info for meta, funding, positions
- POST /exchange for orders

### Vertex
- REST: https://prod.vertexprotocol-backend.com
- Query engine for positions, orderbook

### Cross-Venue Funding Rate Arbitrage

When funding rates diverge between GMX and Hyperliquid:
1. Long on the venue with negative funding (you get paid)
2. Short on the venue with positive funding (you get paid)
3. Net delta-neutral, collect funding from both sides
4. Minimum spread: 0.03%/8h to cover execution costs`,
  },
  {
    id: 'volatility',
    name: 'Volatility Trading',
    providers: ['Polymarket', 'Uniswap V3', 'GMX V2', 'Hyperliquid', 'Vertex', 'CoinGecko'],
    description:
      'Trades implied vs realized volatility using funding rates and prediction markets.',
    cron: '0 */10 * * * *',
    maxTurns: 12,
    timeoutMs: 150_000,
    expertKnowledge: `### Implied Volatility Proxies

Crypto markets lack traditional options IV. Use these proxies:
- **Funding rates** from Hyperliquid: High absolute funding = high implied vol
- **Prediction market spreads**: Wide bid-ask on Polymarket crypto markets = uncertainty
- **Price momentum**: Rapid price changes (>3% in 1h) signal vol regime change

### Vol Trading Strategies

**Long Volatility** (when realized vol < implied proxies):
- Buy both YES and NO sides of crypto prediction markets near 50/50 split
- Long perpetual positions with tight stops \u2014 capture large moves in either direction

**Short Volatility** (when realized vol > implied proxies):
- Sell prediction market positions far from 50/50 (>75% or <25%) \u2014 collect theta decay
- Provide DEX liquidity, collect high funding on perps

### Delta Hedging
- Calculate net delta across all positions
- Hedge via Uniswap V3 spot trades to bring net delta near zero
- Re-hedge when delta drifts beyond \u00B15% of portfolio`,
  },
  {
    id: 'mm',
    name: 'Market Making',
    providers: ['Polymarket', 'Hyperliquid', 'Uniswap V3', 'CoinGecko'],
    description: 'Automated market making with inventory management and spread calculation.',
    cron: '0 */1 * * * *',
    maxTurns: 15,
    timeoutMs: 180_000,
    expertKnowledge: `### Market Selection
Select 3-5 markets: Volume > $100k, spread < 3%, moderate volatility.

### Fair Value Estimation
1. Fetch order book (bids + asks)
2. Midpoint = (best_bid + best_ask) / 2
3. Adjust for recent trade flow

### Inventory Management
- Max 10% per market, target inventory = 0 (flat)
- Skew quotes: shift midpoint by inventory_skew * base_spread
- Stop quoting one side if inventory > 15%

### Spread Calculation
- Low vol, balanced: 0.5-1% base spread
- High vol: widen by vol_multiplier
- Minimum: must cover fees + adverse selection

### Circuit Breakers
- Stop quoting if session drawdown > 2%
- Pause market on 3 consecutive adverse fills
- Reduce size 50% if drawdown > 1%/hour`,
  },
  {
    id: 'multi',
    name: 'Cross-Strategy',
    providers: ['All protocols'],
    description: 'Allocates capital across prediction, yield, perps, and spot strategies.',
    cron: '0 */5 * * * *',
    maxTurns: 20,
    timeoutMs: 300_000,
    expertKnowledge: `### Capital Allocation Model

Default allocation:
- 30% Prediction markets (Polymarket)
- 25% DeFi yield (Aave V3, Morpho)
- 25% Perpetual futures (GMX V2, Vertex)
- 20% Spot/DEX (Uniswap V3)

Rebalance weekly by Sharpe ratio:
- Sharpe > 1.5: increase allocation +5%
- Sharpe < 0.5: decrease allocation -5%
- Never > 40% or < 10% per strategy

### Cross-Strategy Signal Integration
- Crypto prices \u2192 inform prediction bets
- Yield data \u2192 guide capital allocation
- Funding rates \u2192 directional bias for perps + predictions
- Volatility spikes \u2192 reduce all exposure, increase cash

### Risk Management (Portfolio-Wide)
- Maximum 3% daily drawdown across all strategies
- Per-strategy drawdown limit: 5%
- Cash buffer: always keep 10% in stablecoins`,
  },
];
