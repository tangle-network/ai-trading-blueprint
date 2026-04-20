# Pursuit: Fund Safety + Trading Envelope Architecture
Generation: 10
Status: building

## Metric → product-value claim

If positions survive process restart and orphaned HL positions are auto-detected,
customer funds are protected against the #1 operational failure mode (crash with
open position). This is the gate between "demo" and "real money."

## System Audit

### What works
- `BLUEPRINT_STATE_DIR` defaults to `./blueprint-state` (persistent if volume-mounted)
- `PersistentStore<T>` JSON files in state dir survive restarts
- Bot records, trade history, intent dedup all use PersistentStore
- Bracket orders are atomic at the HL API level (entry+SL+TP in one call)
- Circuit breaker logic exists in `portfolio.rs` and `execute.rs`

### What's broken
- Shutdown handler is a no-op (logs "Shutting down" and exits)
- Zero HL position awareness on startup — process restarts blind
- No retry/backoff on HL API failures — transient errors drop orders
- Circuit breaker state is in-memory — resets on restart
- No healthcheck that verifies HL connectivity or position state

### Root cause
The system was built for on-chain DEX trading where positions live in the vault
contract (always queryable). HL positions live on a separate L1 with no on-chain
state the bot can read from Arbitrum. The bot must maintain its own position
ledger AND reconcile against HL on every startup.

## Generation 10 Design

### Thesis
Gen 10 makes the HL trading path crash-safe by adding position persistence,
startup reconciliation, graceful shutdown, and HL API retry — the minimum set
of changes that prevent fund loss on operational failures.

### Moonshot considered
Full HL WebSocket-based position streaming with real-time SL/TP monitoring,
auto-deleverage detection, and margin call handling. Rejected — too much scope
for the safety gate. Gen 11 material.

### Changes (ordered by impact)

#### 1. HL position ledger (CRITICAL)
- New `PersistentStore<HlPositionRecord>` in state dir
- Written on every order fill, updated on every close
- Fields: asset, size, entry_price, side, sl_oid, tp_oid, opened_at
- File: `trading-runtime/src/hyperliquid.rs` + new `hl_positions` store

#### 2. Startup reconciliation (CRITICAL)
- On client init, pull `user_state()` from HL clearinghouse
- Compare against local position ledger
- Orphaned HL positions (in HL but not local): log CRITICAL, add to ledger
- Stale local records (in ledger but not HL): mark as closed
- Missing SL/TP: re-place them

#### 3. Graceful shutdown (CRITICAL)
- SIGTERM handler: for each open position in ledger, place market-close
- Wait up to 10s for closes to confirm
- Only then allow process exit
- If close fails, log EMERGENCY with position details

#### 4. HL API retry with backoff (HIGH)
- Wrap all HL SDK calls in retry loop: 3 attempts, exponential backoff
- 429 → back off per Retry-After header
- 500/timeout → retry after 1s, 2s, 4s
- Connection error → retry after 2s, 4s, 8s

#### 5. Circuit breaker persistence (HIGH)
- Save portfolio high_water_mark and max_drawdown to state dir
- Load on startup, never reset to zero
- If drawdown exceeds threshold on startup, refuse to trade

#### 6. Liveness healthcheck (MEDIUM)
- `/health` checks: HL API reachable, positions reconciled, last trade time
- Returns 503 if any check fails

### Phase 1.5 gate
- Touches lifecycle (shutdown): YES
- Touches external API (HL): YES
- >300 lines: YES
- Concurrency (shutdown handler): YES
→ Phase 1.5 blocking. Review: shutdown races are mitigated by
  sequential position closing (no parallel close attempts).
  Reconciliation runs once on startup under a lock, not during trading.
