# Pursuit: Backtest Engine Production Hardening
Generation: 5
Status: building

## System Audit

### What exists and works
- Backtest engine: single-asset, single-position simulation with RSI/EMA/ATR/momentum/volume/funding signals
- HarnessConfig: typed strategy representation that round-trips through serde
- Cost model: fixed slippage bps, fixed gas, fixed fee bps
- HTTP API: POST /backtest/run, POST /backtest/compare (stateless)
- Evolution tools: evolve-strategy.js (diagnose/compare/promote/history), record-candle.js
- Evolution prompt block in loop prompt
- 28 tests, all passing

### What exists but isn't integrated
- HarnessConfig written to sidecar on activation, but the trading loop doesn't read it for decisions
- record-candle.js exists but nothing calls it automatically
- evolve-strategy.js diagnose reads /trades and /metrics but doesn't break down by token/protocol
- Candle type has no `token` field — no way to distinguish asset pairs

### What was tested and failed
- Nothing — this is the first iteration. The 6.5/10 self-assessment identified 10 concrete gaps.

### What doesn't exist yet
- Multi-asset candle series (per-token candle streams)
- Multi-position portfolio tracking in backtest
- Volume-weighted slippage model
- HarnessConfig validation before promote
- Harness → live trading feedback loop
- Candle auto-ingestion from price feeds
- Real Kelly sizing from trade history
- Discard logging with full variant + result data

## Baselines
- Test count: 28 backtest + 234 runtime = 262
- Backtest features: 5 signal types, 4 exit rules, 3 filters, 3 sizing methods
- Position model: single-asset, single-position, long or short
- Slippage model: constant bps
- Kelly sizing: fake (just fraction * equity)

## Diagnosis

### Architectural (must change)
1. **Single-token Candle type** — no `token` field, engine processes one series. Multi-asset strategies can't be evaluated.
2. **Single-position model** — engine holds 0 or 1 position. Can't evaluate "long ETH + short BTC" or portfolio rebalancing.
3. **HarnessConfig is eval-only** — written to sidecar but never read by the trading loop. Evolution can't change behavior.
4. **No candle ingestion** — record-candle.js is dead code without automatic calls from the trading loop.
5. **Slippage cost accounting bug** — `slippage_cost` field computed from already-slipped prices (cosmetic, PnL is correct but reporting is wrong).

### Tunable (can fix incrementally)
6. **Fixed slippage** — add volume-weighted model
7. **Fake Kelly** — compute from running trade history
8. **No promote validation** — add schema check + backup
9. **No discard log** — log failed variants with full data

## Generation 5 Design

### Thesis
Multi-asset portfolio backtest with harness-driven live trading feedback — the engine can evaluate what the bot actually does across its full trading universe, and evolution changes actually change bot behavior.

### Moonshot considered
Full on-chain fork replay: fork mainnet at a historical block, replay the bot's actual transactions, measure the actual output including MEV, gas auctions, and reorgs. **Rejected** — requires maintaining full archive node state for each backtest, 100x the complexity for marginal accuracy gain over candle-level simulation. The right move for v2 after the candle-based engine proves the evolution loop works.

### Changes (ordered by impact)

#### Architectural (must ship together)
1. **Multi-asset candle series** — `Candle` gets `token: String`, engine accepts `Vec<Candle>` with mixed tokens, internally partitions into per-token series
2. **Multi-position portfolio** — engine tracks `HashMap<String, OpenPosition>` keyed by token, entry rules evaluated per-token, portfolio-level equity curve
3. **HarnessConfig per-token rules** — entry rules can specify `tokens: Vec<String>` filter (empty = all tokens)
4. **Fix slippage reporting** — `slippage_cost` computed correctly as the cost delta from slippage, not re-derived from fills
5. **Volume-weighted slippage** — `SlippageModel` enum: `FixedBps(u32)` or `SqrtImpact { base_bps: u32, depth_usd: Decimal }` where effective_bps = base_bps * sqrt(size / depth)

#### Measurement
6. **HarnessConfig validation** — `HarnessConfig::validate()` method checking: non-empty rules, valid periods, weights sum > 0, no duplicate signals
7. **Discard logging** — `BacktestComparison` gains `discard_reason: Option<String>`, evolve-strategy.js logs full variant + result on discard
8. **Real Kelly sizing** — engine tracks running win rate + avg win/loss from completed trades, Kelly = (win_rate * avg_win / avg_loss - (1 - win_rate)) / (avg_win / avg_loss), capped at max_position_pct

#### Infrastructure
9. **Candle auto-ingestion** — market-data price responses → OHLCV aggregation in record-candle.js, called automatically from loop prompt step 2
10. **Harness → trading loop feedback** — evolution prompt updated: after promote, agent re-reads harness.json and uses its entry/exit rules to guide decisions
11. **Promote safety** — backup previous harness before overwrite, validate new harness schema, rollback on parse failure

### Risk + Success criteria
- Multi-asset engine is backward compatible (single-token candles still work — token defaults to "default")
- No existing test breaks
- New tests: multi-asset portfolio, volume-weighted slippage, Kelly convergence, HarnessConfig validation, promote/rollback
- Target: 45+ backtest tests (from 28)
