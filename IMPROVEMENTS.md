# Backend Improvements Required for Frontend

Changes needed in the existing trading blueprint crates to support the
`trading-arena-web` frontend. The frontend is built ON TOP of the blueprints —
all mutations go through Tangle job submission, all reads go to per-bot HTTP
APIs or on-chain contract reads. These improvements fill gaps where the
existing APIs don't expose enough data for the frontend's needs.

No code changes should be made until this document is reviewed and approved.

---

## Priority 1: Critical Path (Frontend cannot ship without these)

### 1.1 Bot Listing & Discovery API

**Problem**: There is no way to list all bots or query bots by operator. The
per-bot HTTP APIs only know about themselves. The `PersistentStore<TradingBotRecord>`
in `state.rs` has the data but it's only accessible inside the blueprint binary
process. The frontend needs a global view of all bots across all operators.

**Required Changes**: Add an Axum HTTP server to `trading-blueprint-bin` that
runs alongside the `BlueprintRunner`. This "operator API" exposes the persistent
store data that the blueprint binary already has:

- `GET /api/bots` — list all `TradingBotRecord` entries (paginated, filterable)
- `GET /api/bots/:botId` — single bot record + Docker container status
- `GET /api/bots?operator=0x...` — filter by operator address
- `GET /api/bots?strategy=dex` — filter by strategy type
- `GET /api/bots?status=active` — filter by trading_active

This is NOT a separate service — it's an Axum router spawned inside the same
binary process, reading from the same `OnceCell<PersistentStore>`. The
`BlueprintRunner` handles Tangle jobs on one port; this handles frontend reads
on another.

**Files affected**:
- `trading-blueprint-lib/src/state.rs` — add `list_bots()`, `bots_by_operator()` query methods
- `trading-blueprint-bin/src/main.rs` — spawn Axum server alongside BlueprintRunner
- New: `trading-blueprint-bin/src/operator_api.rs` — route handlers

### 1.2 Trade History API

**Problem**: For live (non-paper) trades, the on-chain transactions are visible
via block explorers and Tangle job results. But: (a) paper trades have no
on-chain footprint, (b) validator reasoning/scores are ephemeral — they're
returned in the `/validate` response but not stored, and (c) there's no unified
endpoint to list all trades for a bot with their reasoning attached.

**What already works without changes**:
- Live trade tx hashes are on-chain — the frontend can index these via viem event
  watching on the vault contract (`TradeExecuted` events)
- Tangle job results for `JOB_WORKFLOW_TICK` capture execution outcomes

**What needs an API extension** (`trading-http-api`):
- Persist validator responses (score, reasoning, signature) and paper trade
  records to an append-only store after each `/validate` + `/execute` cycle
- `GET /trades` — paginated trade history with validator reasoning attached
- `GET /trades/:tradeId` — single trade detail

This is specifically for: (a) paper trades and (b) attaching validator
reasoning to trade records. Live execution data comes from on-chain events.

**Files affected**: `trading-http-api/src/routes/execute.rs` (persist after call),
new `trading-http-api/src/routes/trades.rs`,
`trading-http-api/src/lib.rs` (add TradeStore to state)

### 1.3 Validator Reasoning Persistence

**Problem**: Validator responses (score, reasoning, signature) are returned
inline but not stored. The reasoning log page needs historical access.

**Required Changes** (`trading-http-api`):
- Store each `ValidatorResponse` alongside the `TradeRecord`
- Include the full AI reasoning text, not just the score
- Index by bot_id + timestamp for efficient retrieval

**Files affected**: `trading-http-api/src/routes/execute.rs` (persist after validation)

### 1.4 CORS Configuration

**Problem**: Bot HTTP APIs don't set CORS headers. Browser requests from the
frontend domain will be blocked.

**Required Changes**:
- Add `tower-http` CORS middleware to the Axum routers
- Configurable allowed origins via env var `CORS_ALLOWED_ORIGINS`
- Allow `Authorization` header in preflight

**Files affected**: `trading-http-api/src/lib.rs`, `trading-blueprint-bin/src/main.rs`

---

## Priority 2: Important (Frontend works but limited without these)

### 2.1 Metrics Time-Series Endpoint

**Problem**: The current `/metrics` endpoint returns a single snapshot. The
frontend needs historical data for equity curves, drawdown charts, and daily
returns heatmaps.

**Required Changes** (`trading-http-api`):
- Record periodic snapshots (every trading loop tick):
  ```rust
  struct MetricSnapshot {
      timestamp: u64,
      account_value_usd: Decimal,
      unrealized_pnl: Decimal,
      realized_pnl: Decimal,
      high_water_mark: Decimal,
      drawdown_pct: Decimal,
      positions_count: u32,
  }
  ```
- `GET /metrics/history?from=&to=&interval=` — time-series data
- Store in append-only file or SQLite per bot

**Files affected**: `trading-http-api/src/routes/metrics.rs` (new),
`trading-http-api/src/lib.rs` (MetricsStore)

### 2.2 WebSocket / SSE for Real-Time Updates

**Problem**: All current endpoints are request-response. The frontend leaderboard
and trade feed need push updates.

**Required Changes**:
- Add WebSocket endpoint `ws://bot-api/ws` per bot:
  - Events: `trade_executed`, `position_changed`, `metrics_updated`, `status_changed`
- Or SSE endpoint `GET /events` with same event types
- The global gateway should aggregate events from all bots

**Files affected**: `trading-http-api/src/lib.rs` (add WS/SSE handler),
new `trading-http-api/src/routes/ws.rs`

### 2.3 Competition / Leaderboard Display

**Problem**: No concept of "competition" exists. The leaderboard groups bots into
named seasons/arenas for display purposes.

**Approach**: Purely offchain. Competitions are a frontend concept stored in the
Next.js app's local DB. No on-chain prize pools or registration — if a bot
makes money, people deposit into its vault. That's the incentive.

**No blueprint code changes needed.** The frontend stores competition metadata
(name, time range, enrolled bot IDs) in its own PostgreSQL and polls bot APIs
for live metrics to compute rankings.

**Files affected**: None (frontend-only)

### 2.4 Validator Discovery Endpoint

**Problem**: Validator endpoints are resolved from env vars. The frontend needs
a way to list all validators, their addresses, stats, and liveness.

**Required Changes** (`trading-validator-bin` or gateway):
- `GET /api/validators` — list all known validators with metadata
- `GET /api/validators/:address` — single validator stats
- Track per-validator metrics: total validations, avg score, avg latency, uptime

**Files affected**: `trading-validator-lib/src/server.rs` (add stats tracking),
`trading-validator-lib/src/scoring.rs` (record metrics per call)

### 2.5 Bot Status Polling Endpoint (Lightweight)

**Problem**: `JOB_STATUS` is an on-chain Tangle job, which is slow and costs gas
for a simple status check. The frontend needs a fast polling endpoint.

**Required Changes**:
- The gateway/binary should expose `GET /api/bots/:botId/status` that reads
  directly from the persistent store + Docker status, no Tangle job needed
- Return: `{ state, trading_active, last_trade_at, portfolio_summary }`

**Files affected**: `trading-blueprint-bin/src/main.rs`

---

## Priority 3: Nice-to-Have (Polish and scale)

### 3.1 Aggregate Leaderboard Computation

**Problem**: Rankings (Sharpe ratio, max drawdown, win rate) must be computed
across all trades. Currently no aggregation logic exists.

**Required Changes**:
- Add `LeaderboardAggregator` that computes:
  - Return % (current AV / starting capital - 1)
  - Sharpe ratio (from daily returns series)
  - Max drawdown (from equity curve high-water marks)
  - Win rate (profitable trades / total trades)
  - Trade count, avg hold time, long/short ratio
- Can live in BFF or in a new `trading-analytics` crate

### 3.2 Paper Trade Enrichment

**Problem**: Paper trades store minimal data. The frontend paper trading view
needs the same richness as live trades.

**Required Changes**:
- Paper trade records should include: simulated price impact, hypothetical
  gas costs, slippage estimation
- `GET /paper-trades?bot_id=&from=&to=` — paginated retrieval

**Files affected**: `trading-http-api/src/routes/execute.rs`

### 3.3 Webhook Event Log

**Problem**: Webhook dispatches (`JOB_WEBHOOK_EVENT`) are fire-and-forget.
The dashboard needs to show webhook history.

**Required Changes**:
- Store webhook event + dispatch results
- `GET /api/webhooks/history` — paginated log

**Files affected**: `trading-blueprint-lib/src/jobs/webhook_event.rs`

### 3.4 Rate Limiting & API Keys for Frontend

**Problem**: Bot HTTP APIs use a single `api_token` for the sidecar. The
frontend BFF layer needs its own auth mechanism.

**Required Changes**:
- Support multiple API keys per bot with different permission levels:
  - `read` — can query status, metrics, trades (for frontend)
  - `write` — can trigger validate/execute (for sidecar only)
- Key management via `JOB_CONFIGURE` or direct API
- Rate limiting middleware on public-facing endpoints

### 3.5 Vault ABI & Event Indexing

**Problem**: Vault contracts emit events (Deposit, Withdraw, TradeExecuted)
but nothing indexes them. The frontend vault detail page needs deposit history
and TVL over time.

**Options**:
1. Use a subgraph (The Graph) for vault event indexing
2. Use `viem` `watchContractEvent` in the BFF layer
3. Use an indexing service like Ponder or Envio

**Recommendation**: Start with viem event watching in the BFF for MVP.
Migrate to a proper indexer at scale.

### 3.6 Strategy Pack Metadata

**Problem**: Strategy packs (dex, yield, perp, prediction) have rich metadata
(system prompts, default crons, supported protocols) but no endpoint exposes it.

**Required Changes**:
- `GET /api/strategy-packs` — list available packs with metadata
- Used by the Provision Wizard to populate defaults and descriptions

**Files affected**: `trading-blueprint-lib/src/prompts/packs.rs` (expose metadata)

---

## Summary Table

| # | Improvement | Priority | Effort | Crates Affected |
|---|-------------|----------|--------|-----------------|
| 1.1 | Bot listing API | P1 | Medium | blueprint-bin, blueprint-lib |
| 1.2 | Trade history storage | P1 | Medium | http-api |
| 1.3 | Validator reasoning persistence | P1 | Small | http-api |
| 1.4 | CORS configuration | P1 | Small | http-api, blueprint-bin |
| 2.1 | Metrics time-series | P2 | Medium | http-api |
| 2.2 | WebSocket/SSE | P2 | Large | http-api |
| 2.3 | Competition registry | P2 | Small* | BFF only (recommended) |
| 2.4 | Validator discovery | P2 | Medium | validator-lib, validator-bin |
| 2.5 | Fast status polling | P2 | Small | blueprint-bin |
| 3.1 | Leaderboard aggregation | P3 | Medium | BFF or new crate |
| 3.2 | Paper trade enrichment | P3 | Small | http-api |
| 3.3 | Webhook event log | P3 | Small | blueprint-lib |
| 3.4 | Multi-key auth & rate limiting | P3 | Medium | http-api |
| 3.5 | Vault event indexing | P3 | Large | BFF + indexer |
| 3.6 | Strategy pack metadata | P3 | Small | blueprint-lib |

**Total estimated scope**: P1 items are ~1 week of backend work. P2 items ~2 weeks.
P3 items can be done incrementally as the frontend matures.

---

## What the Frontend Can Build Without Any Backend Changes

The blueprint system already provides everything needed for the core flows.
Here's what works TODAY with zero Rust changes:

### Fully functional now

1. **Provision wizard** — form → `TradingProvisionRequest` ABI encode → wagmi
   `submitJob(JOB_PROVISION)`. The blueprint binary handles everything.
2. **Bot lifecycle** — Start/Stop/Configure/Extend/Deprovision all work via
   Tangle job submission. The frontend just encodes and submits.
3. **Vault deposit/withdraw** — pure on-chain via wagmi contract writes
4. **Single bot detail** — all 7 per-bot HTTP API endpoints work today
   (`/validate`, `/execute`, `/portfolio/state`, `/market-data/prices`,
   `/circuit-breaker/check`, `/metrics`, `/adapters`)
5. **Vault reads** — TVL, share price, depositor count via on-chain reads
6. **Competition system** — store in Next.js PostgreSQL, poll bot APIs for
   metrics. No blueprint changes needed.
7. **Landing page, marketing, how-it-works** — static

### Requires the operator API (improvement 1.1)

- Bot listing / leaderboard (need to discover all bots, not just one)
- Operator dashboard "my bots" view

### Requires trade persistence (improvement 1.2)

- Trade history page
- Reasoning log (need historical data, not just current snapshot)
- Win rate / Sharpe / drawdown computations

**Bottom line**: The frontend can start building immediately. The provision
wizard, vault pages, and single-bot detail pages work with zero backend
changes. The operator API (1.1) and trade persistence (1.2) are needed for
the Arena leaderboard and trade history views — those can be built in
parallel with the frontend.
