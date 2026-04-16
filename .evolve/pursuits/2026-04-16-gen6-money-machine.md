# Pursuit: Close the Feedback Loop — Make Money
Generation: 6
Status: building

## Thesis
The backtest engine exists but is disconnected from live trading. The agent writes trades but never knows if its strategy is improving. Gen6 closes this loop: candle ingestion → backtest evaluation → harness promotion → strategy-guided execution. The bot becomes a closed-loop optimization system where every tick produces data that feeds the next evolution.

## Moonshot considered
Full reinforcement learning agent: replace the LLM with a trained policy network that directly outputs trade intents from market state embeddings, trained via PPO on the backtest engine's reward signal. **Rejected** — the LLM agent IS the product differentiator. Users want to describe strategies in natural language and have the agent execute them. The harness system augments the LLM's judgment with structured rules, not replaces it. The right moonshot is making the harness evolution so fast that the agent runs 100 backtests per evolution cycle. That's a future optimization, not architecture.

## System Audit

### The gap in one sentence
The bot trades, but never learns from its own history in a structured way. Evolution tools exist as dead JS files — nothing triggers them, nothing feeds them data, nothing acts on their output.

### What must ship together
1. **Backtest API integration test** — prove the engine works end-to-end over HTTP
2. **Candle ingestion from market-data** — automatic, not manual agent action
3. **Walk-forward validation** — train on first 70%, test on last 30% to prevent overfitting
4. **Harness config persistence** — survives across ticks, queryable via API
5. **Evolution metrics endpoint** — GET /evolution/status returns current harness + last comparison

## Changes

### A1: Backtest HTTP API integration test
- Add test to trading-http-api/tests/api_tests.rs
- POST /backtest/run with synthetic candles + config → verify response shape, stats, trades
- POST /backtest/compare with two configs → verify should_promote logic
- No Docker needed — uses existing wiremock + in-memory pattern

### A2: Walk-forward backtest validation
- Split candle series: 70% in-sample, 30% out-of-sample
- Run backtest on both halves independently
- Only promote if BOTH halves show improvement
- Prevents overfitting to historical patterns
- New: BacktestEngine::walk_forward_compare()

### A3: Candle ingestion endpoint
- POST /market-data/candles — accepts OHLCV candles, stores in persistent sled DB
- GET /market-data/candles?token=ETH&from=TS&to=TS&limit=N — query stored candles
- Loop prompt step 2 changed: after price fetch, POST candles to API
- Candle store keyed by (token, timestamp), deduped, ordered

### A4: Evolution status endpoint
- GET /evolution/status — returns current harness version, last backtest comparison, evolution history count
- POST /evolution/run — triggers evolution cycle: load candles → backtest compare → return result
- Uses persistent harness config from sled (not just sidecar filesystem)

### A5: Harness config persistence in bot record
- TradingBotRecord gains harness_json field
- PATCH /api/bots/{id}/harness — update harness config with validation
- Harness survives container restarts, queryable from operator API
