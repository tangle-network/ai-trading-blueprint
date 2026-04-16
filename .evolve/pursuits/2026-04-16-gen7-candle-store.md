# Pursuit: Persistent Candle Store + Server-Side Evolution
Generation: 7
Status: building

## Thesis
Gen6 built the backtest engine and walk-forward validation. Gen7 closes the data pipeline: persistent candle storage so the bot accumulates market history, and server-side evolution endpoints so the operator (or an automated cron) can trigger strategy evolution without relying on the sidecar agent to do it. The bot's feedback loop becomes: trade → record candle → accumulate history → evolve server-side → promote harness → trade with new strategy.

## Moonshot considered
Real-time streaming candle aggregation from on-chain events: subscribe to DEX swap events via WebSocket, aggregate into OHLCV candles in real-time, feed directly into the backtest engine for continuous evaluation. **Adopted partially** — the candle store is the foundation. Real-time aggregation from on-chain events is Gen8 (requires WebSocket infra). For now, candles come from the agent's price observations via POST /market-data/candles, which is sufficient for the 5-minute tick cadence.

## Changes

### A1: Candle store (trading-http-api/src/candle_store.rs)
- PersistentStore<StoredCandle> following metrics_store pattern exactly
- Key: candle:{bot_id}:{token}:{timestamp}
- record_candles(bot_id, candles) — batch insert with dedup
- candles_for_bot(bot_id, token, from, to, limit) — time-range query

### A2: Candle HTTP endpoints (trading-http-api/src/routes/candles.rs)
- POST /market-data/candles — record candles (batch, from agent)
- GET /market-data/candles?token=X&from=TS&to=TS&limit=N — query stored candles
- Both single-bot and multi-bot routers

### A3: Server-side evolution endpoint
- POST /evolution/run — loads candles from store, runs walk-forward compare, returns result
- GET /evolution/status — returns current evolution state (harness version, history count)
- Accepts current + candidate HarnessConfig, uses stored candles automatically

### A4: Harness persistence in TradingBotRecord
- Add harness_json: serde_json::Value to TradingBotRecord (with #[serde(default)])
- PATCH endpoint to update harness with validation
- Harness survives container restarts

### A5: Integration tests for all new endpoints
