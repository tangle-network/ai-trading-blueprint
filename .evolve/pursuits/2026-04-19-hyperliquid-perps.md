# Pursuit: Full Hyperliquid Perps Integration
Generation: 9
Status: building

## Metric → product-value claim

If the agent can place market/limit/stop/TP orders, manage leverage, and track positions on Hyperliquid natively, the product goes from "proof-of-concept that encodes bridge calldata" to "production perps trading agent that users would deposit real money into."

## System Audit

### What exists and works
- Bridge adapter (`adapters/hyperliquid.rs`, 334 lines): encodes `placeOrder` ABI for the Arbitrum bridge contract. Open/close long/short with limit orders. 7 unit tests.
- Agent prompt (`providers/hyperliquid.rs`, 124 lines): teaches the LLM the read-only `/info` REST API. Event handlers for funding_rate, liquidation, price_move.
- Executor dispatch: `get_adapter("hyperliquid")` is wired. TradeIntent→EncodedAction→vault execution works.
- Portfolio tracking: `PortfolioState` supports `LongPerp`/`ShortPerp` position types with P&L calculation.

### What exists but isn't integrated
- `orderType: 1` (market) is in the bridge ABI definition but hardcoded to `0` (limit only).
- `reduce_only` flag is correctly set for close actions but no partial close support.

### What was tested and failed
- Nothing — no one has attempted native HL API trading. The bridge path was always the only path.

### What doesn't exist yet
- Native HL REST client (signed `POST /exchange` with L1 EIP-712 actions)
- Market orders, stop-loss, take-profit, trigger orders
- Leverage management (`updateLeverage`)
- Position sync from HL clearinghouse state
- WebSocket for real-time fills/funding/liquidations
- Order cancellation/modification
- Margin management (cross/isolated)
- HL-specific HTTP routes for the agent to call

### Measurement gaps
- No way to measure HL trading quality — no backtest data from HL, no live trade metrics.
- No HL-specific position reconciliation (local state can desync from HL L1).

## Baselines
- HL order types supported: 1 (limit via bridge)
- HL API coverage: 0% (exchange actions), ~20% (info read-only)
- HL-specific tests: 7 (all bridge adapter encoding)
- Agent can autonomously trade HL perps: NO

## Diagnosis

Root cause is architectural: the system was designed for on-chain DEX swaps where trades execute through the vault contract. Hyperliquid trades happen on a separate L1 — routing through an Arbitrum bridge adds 30s+ latency, $0.50+ gas per trade, and limits functionality to basic limit orders. The right architecture is a native REST client that signs HL L1 actions directly and talks to `api.hyperliquid.xyz`, with the on-chain vault used only for USDC custody.

## Generation 9 Design

### Thesis
Gen 9 ships a native Hyperliquid client that talks directly to the HL API, giving the agent full perps trading capability (market/limit/stop/TP orders, leverage, positions) without the bridge bottleneck.

### Moonshot considered
Full HL trading engine with persistent WebSocket, bracket order management, DCA/grid/TWAP strategies, auto-margin, liquidation handling, and position reconciliation. **Rejected** — 3000+ lines, multi-week scope. Gen 9 ships the client + routes. Gen 10 can add WS and advanced order management via /evolve.

### Codebase conventions matched
- Adapters: follow `ProtocolAdapter` trait pattern (existing 10 adapters)
- HTTP routes: axum `Router<Arc<...State>>` pattern (see execute.rs, collateral.rs)
- Errors: `TradingError` enum with `AdapterError` variant
- Provider prompts: `TradingProvider` trait with `expert_prompt()` + `handle_event()`

### Changes (ordered by impact)

#### Architectural (must ship together)
1. **HyperliquidClient** — `trading-runtime/src/hyperliquid.rs`
   - Wraps `hyperliquid` crate's `Exchange` + `Info` structs
   - Methods: `place_order`, `cancel_order`, `set_leverage`, `get_positions`, `get_account_state`
   - Order types: Market (IOC limit at aggressive price), Limit (GTC), StopMarket, TakeProfit
   - Signs with executor private key via ethers `LocalWallet`

2. **HTTP routes** — `trading-http-api/src/routes/hyperliquid.rs`
   - `POST /hyperliquid/order` — place any order type
   - `POST /hyperliquid/cancel` — cancel by order ID
   - `POST /hyperliquid/leverage` — set leverage for asset
   - `GET /hyperliquid/positions` — current positions from HL
   - `GET /hyperliquid/account` — margin, equity, open orders

3. **Provider prompt** — update `providers/hyperliquid.rs` to teach agent the new endpoints

#### Infrastructure
4. Add `hyperliquid` crate to `trading-runtime/Cargo.toml`
5. Wire routes into multi-bot and single-bot routers

### Alternatives
- Build from scratch without SDK — rejected, HL signing is complex (msgpack + two EIP-712 domains)
- Use bridge adapter only — rejected, fundamentally wrong architecture for perps

### Risk + Success criteria
- Risk: ethers dep conflicts with alloy — mitigated by feature isolation
- Risk: HL API changes — SDK pins to known-working version
- Success: agent can place a market long ETH-PERP with stop-loss on HL testnet
- Metric: order types 1→5, API coverage 0%→80%, agent can autonomously trade HL perps: YES

## Phase 1.5 gate
- Does any diff file touch auth, crypto, TLS, signing, or trust boundaries? **YES** (HL L1 signing with private key)
- Is the total diff >5 files or >300 lines? **YES**
- Does the change add or modify an external API endpoint? **YES** (5 new HTTP routes)

→ Phase 1.5 Review required. Covered by: private key loaded from existing EXECUTOR_PRIVATE_KEY env var (same trust boundary as on-chain signing), HL API is external but read/write to user's own account only, no new trust boundaries beyond what the executor already has.
