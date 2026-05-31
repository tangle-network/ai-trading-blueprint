# Pursuit: Risk-Budgeted Evidence Router for Trading Agents
Generation: 3
Status: built-local

## Metric -> product-value claim
- Metric: promotion decisions can return `reject`, `shadow`, `tiny_live`, `active`, or `scaled` with a persisted evidence report and enforceable risk budget.
  Product value: time-sensitive agents can act before paper evidence arrives while every fund-touching action remains bounded and auditable.
- Metric: live `/execute` rejects trades that claim or require a risk-budget decision when the decision is missing, expired, wrong-bot, wrong-revision, wrong-venue, or over cap.
  Product value: the agent can trade unilaterally only inside a pre-approved envelope, not by bypassing the promotion gate.
- Metric: the same enforcement runs before DEX/vault, Polymarket CLOB, and Hyperliquid dispatch.
  Product value: adding venues does not create a new safety path or duplicate promotion logic.

## System Audit
- Existing backtest/promotion core: `trading-http-api/src/routes/evolution.rs` exposes `/evolution/run`, `/evolution/promotion-gate`, and `/evolution/self-improve`; it reuses `BacktestEngine::walk_forward_compare` and currently returns boolean `approved` plus blockers.
- Existing conductor: `trading-blueprint-lib/src/jobs/promotion_conductor.rs` activates queued `backtest_pass` candidates only for paper bots and calls the same promotion gate after tagged paper evidence accrues.
- Existing execution trust boundaries: `trading-http-api/src/routes/execute.rs` already gates supported assets, revision mode, validator signatures, live risk, envelope constraints, Hyperliquid mode, CLOB reconciliation, and intent dedup before venue dispatch.
- Existing venue branches: `/execute` dispatches vault/EVM, Polymarket CLOB, and Hyperliquid from one handler, so a single pre-dispatch risk-budget check can cover all current venues.
- Existing audit store pattern: `evolution_store`, `trade_store`, `sandbox_store`, and `trial_marker` all use `sandbox_runtime::store::PersistentStore`; the router should use the same store rather than inventing a side channel.
- Existing trade records already carry decision trace fields and candidate/revision IDs; adding a risk-budget decision ID there preserves auditability without a separate execution ledger.

## Diagnosis
The architectural bug is that promotion is boolean and paper-centric. The system needs a risk allocation decision that can be stricter than "active promotion" but less restrictive than "wait for paper trading"; then live execution must enforce that decision mechanically.

## Generation 3 Design

### Thesis
A persisted `EvidenceReport` + `RiskBudgetDecision` turns promotion from "paper-or-blocked" into "allocate bounded risk to hypotheses," while keeping all live trades behind the existing `/execute` trust boundary.

### Moonshot considered
The 10x redesign is a dedicated event-sourced strategy allocator service with venue adapters, live order-state reconciliation, and portfolio-level optimizer. That is directionally right, but it duplicates too much existing `/execute`, validator, envelope, and store logic for this generation. This generation adopts the core allocator primitive in-place so every existing venue benefits immediately.

### Codebase conventions matched
- Store: match `PersistentStore<T>` singletons from `evolution_store.rs` and `trade_store.rs`.
- HTTP shape: keep Axum request/response pattern in `routes/evolution.rs`.
- Execution errors: return `(StatusCode, String)` from route helpers, matching `execute.rs`.
- Audit fields: extend `TradeRecord` rather than add a parallel execution-log store.

### Changes
1. Add `trading-http-api/src/risk_budget.rs` with `EvidenceReport`, `RiskBudgetDecision`, `RiskBudgetRequest`, persistence, decision construction, and live enforcement helpers.
2. Extend `/evolution/promotion-gate` and `/evolution/self-improve` to accept `risk_budget`, persist reports/decisions, and return the decision beside the legacy boolean.
3. Extend `SelfImprovementRun` with report/decision IDs for continuity.
4. Extend `TradeRecord` with `risk_budget_decision_id` and stamp it from intent metadata.
5. Enforce matching risk-budget decisions in `/execute` before live venue dispatch, using the existing valuation snapshot and venue-specific CLOB valuation where needed.
6. Update sandbox TS self-improvement probes to pass risk-budget hints from env/intent without moving generation logic out of TS.
7. Add unit/integration tests for fast-path promotion output and enforcement failures.

### Alternatives
- Backtest-only live promotion: rejected because it scales too quickly from in-sample evidence and overfits perishable markets.
- Paper-first for all candidates: rejected because prediction/news alpha can decay before paper evidence accrues.
- Separate allocator service now: rejected for this generation because it would duplicate execution risk gates and delay the hot-path safety primitive.

### Risk + Success Criteria
- Risk: existing live agents could break if a decision is required globally. Mitigation: require a decision only when strategy config opts in, a trade claims a decision, or a non-baseline candidate/revision is trying to touch funds.
- Risk: unpriced trades could bypass notional caps. Mitigation: decision-required live trades fail closed when notional is unavailable.
- Success: targeted tests prove time-sensitive backtest passers produce a `tiny_live` decision; live enforcement rejects missing/expired/over-cap decisions; existing promotion tests still pass.

### Build Status
| # | Change | Status | Files | Tests |
|---|---|---|---|---|
| 1 | Risk-budget module | complete | `trading-http-api/src/risk_budget.rs` | `cargo test -p trading-http-api risk_budget --lib` |
| 2 | Promotion response | complete | `routes/evolution.rs` | `cargo test -p trading-http-api --test api_tests evolution_promotion_gate` |
| 3 | Execute enforcement | complete | `routes/execute.rs`, `trade_store.rs` | `cargo test -p trading-http-api routes::execute --lib` |
| 4 | TS probes | complete | `self_improvement_loop.ts`, `submit_trade.js` | `npx tsc ... self_improvement_loop.ts` |

## Result
KEEP. Promotion is now an auditable risk-allocation decision instead of a paper-only boolean. Time-sensitive candidates that pass hard backtest/overfit gates can receive a `tiny_live` / `live_probe` decision with explicit protocol, notional, loss, trade-count, and TTL caps, while the legacy `approved` field still requires paper evidence for full promotion. Certified hot-path candidates without forward evidence still receive bounded probes, not uncapped active allocation.

The live `/execute` route enforces `risk_budget_decision_id` before every current venue dispatch path: EVM/vault, Polymarket CLOB, and Hyperliquid. Missing, expired, wrong-bot, wrong-candidate, wrong-revision, wrong-protocol, malformed-cap, over-cap, over-trade-count, or unpriced decision-required trades fail closed before touching funds. Counted live probes are reserved before dispatch, so concurrent requests cannot both consume a one-trade budget.

Verification:
- `cargo check --workspace` passed.
- `cargo clippy -p trading-http-api --tests -- -D warnings -A clippy::collapsible-if -A clippy::manual-inspect -A clippy::needless-question-mark -A clippy::too-many-arguments` passed.
- `cargo test --workspace --lib` passed.
- `cargo test -p trading-http-api risk_budget --lib -- --nocapture` passed.
- `cargo test -p trading-http-api routes::execute --lib -- --nocapture` passed.
- `cargo test -p trading-http-api --test api_tests evolution_promotion_gate -- --nocapture` passed.
- `cargo test -p trading-http-api --test api_tests self_improvement -- --nocapture` passed.
- `cargo test -p trading-blueprint-lib --test integration test_promotion_conductor_activates_queued_backtest_pass_candidate -- --nocapture` passed.
- `npm run typecheck:evals` passed.
- `npx tsc --target ES2022 --module ESNext --moduleResolution Bundler --noEmit --skipLibCheck trading-blueprint-lib/src/prompts/tools/self_improvement_loop.ts` passed.

## Review Gate
Touches trade execution, persistence, and API shape; mandatory diff audit before final. Local diff hygiene and targeted clippy are clean.

## Generation 4 Addendum: Hyperliquid Outcome-Market Parity

### Thesis
Hyperliquid prediction markets should reuse Hyperliquid execution transport but inherit prediction-market evidence, valuation, and max-loss semantics.

### Design
- Shared helper: move Hyperliquid asset/size parsing into `trading-http-api/src/hyperliquid_intent.rs` so `/validate` and `/execute` hash/dispatch the same order representation.
- Outcome asset IDs: support explicit numeric asset IDs plus Hyperliquid outcome encodings like `#17 -> 100000017` and `outcome_id/outcome_side -> 100000000 + outcome_id * 10 + side`.
- Valuation: if Hyperliquid metadata supplies `asset_size`, `limit_price`/`price`, and/or `notional_usdc`, derive priced notional before live risk-budget enforcement; reject outcome prices above `1` and reject inconsistent `notional_usdc != asset_size * price`.
- Risk: for binary prediction/outcome decisions, clamp tiny-live notional to `max_loss_usd`, reject any live outcome trade whose notional exceeds that loss cap, and reserve cumulative notional per decision so repeated triggers cannot over-consume the budget.
- Audit: record Hyperliquid outcome trades as `PredictionTradeMetadata` and carry outcome fields into Hyperliquid trade metadata.
- Agent behavior: update Hyperliquid provider/system prompts and TS self-improvement risk-budget inference so Hyperps target `target_protocol="hyperliquid"` with prediction metadata, not Polymarket CLOB.

### Result
KEEP. Hyperliquid outcomes are now "similar to Polymarket" at the strategy/risk/audit layer while staying "Hyperliquid" at the transport and asset-ID layer.

Verification:
- `git diff --check` passed.
- `cargo check --workspace` passed.
- `cargo clippy -p trading-http-api -p trading-runtime -p trading-blueprint-lib --tests -- -D warnings -A clippy::collapsible-if -A clippy::manual-inspect -A clippy::needless-question-mark -A clippy::too-many-arguments` passed.
- `cargo test --workspace --lib` passed.
- `cargo test -p trading-http-api risk_budget --lib -- --nocapture` passed.
- `cargo test -p trading-http-api routes::execute --lib -- --nocapture` passed.
- `cargo test -p trading-http-api --test api_tests evolution_promotion_gate -- --nocapture` passed.
- `cargo test -p trading-runtime hyperliquid::tests::parses_encoded_outcome_asset_symbols --lib -- --nocapture` passed.
- `cargo test -p trading-blueprint-lib providers::hyperliquid --lib -- --nocapture` passed.
- `npx tsc --target ES2022 --module ESNext --moduleResolution Bundler --noEmit --skipLibCheck trading-blueprint-lib/src/prompts/tools/self_improvement_loop.ts` passed.
