# Pursuit: Gen 4 — Hyperliquid + Leaderboard + Aggregation API
Generation: 4
Status: complete

## System Audit

### What existed and worked
- Operator Gateway API: 3500+ lines, bot CRUD, trade history, metrics time-series, terminal relay, chat gateway, session auth — all already built
- Metric snapshot storage with time-series query (MetricSnapshot, snapshots_for_bot)
- Trade record storage with per-bot filtering (TradeRecord, trades_for_bot)
- 7 protocol adapters: uniswap_v3, aave_v3, gmx_v2, morpho, vertex, polymarket, twap
- Hyperliquid provider with expert prompt + event handlers (but NO adapter)

### What was missing
- Hyperliquid on-chain adapter (provider existed, adapter didn't)
- Leaderboard computation (Sharpe, Sortino, win rate, return %, Calmar)
- Bulk aggregation endpoint for frontend leaderboard rendering

## Design

### Thesis
Gen 4 completes the perp adapter trifecta and adds the computation layer the frontend needs to render competitive leaderboards.

### Moonshot considered
Full SQL-backed analytics pipeline (TimescaleDB + materialized views for real-time leaderboards). Rejected: the existing PersistentStore JSON is sufficient at current scale (< 1000 bots), and the computation is O(snapshots) per bot which is fast enough for periodic refresh.

### Changes
| # | Feature | Files | Tests |
|---|---------|-------|-------|
| 1 | Hyperliquid adapter | hyperliquid.rs, mod.rs, executor.rs | 8 |
| 2 | Leaderboard computation | leaderboard.rs, lib.rs | 8 |
| 3 | Aggregation endpoint | operator_api.rs | 0 (integration) |

## Results

### Scores
| Metric | Before | After | Δ |
|--------|--------|-------|---|
| Protocol adapters | 7 | 8 | +1 (Hyperliquid) |
| Perp adapters | 2 (GMX, Vertex) | 3 (+Hyperliquid) | Complete |
| Leaderboard metrics | 0 | 7 (return, Sharpe, Sortino, drawdown, Calmar, win rate, trades) | New |
| API endpoints | 30+ | 31+ (+leaderboard) | +1 |
| Runtime tests | 182 | 198 | +16 |

### Verdict: ADVANCE

Run `/evolve` targeting leaderboard accuracy against real metric data.
