# Progress — ai-trading-blueprint

## Session 2026-04-19: Harden + Hyperliquid + Fund Safety + Deployment

### Harden Round 3 (merged via PR #25)
- 3 CRITICAL + 7 HIGH + 4 MEDIUM security findings fixed
- approveSpender regression, SSRF, race conditions, position decimal normalization
- Trading envelope, ValidationTrust three-tier auth
- 884 tests (429 Forge + 455 Rust)

### Audit signer floor (merged via PR #26)
- H-2+H-4: VaultFactory requires signers >= 2, requiredSigs >= 2
- M-3: setRequiredSignatures monotonic-up only

### Gen 9-11: Hyperliquid + Fund Safety + Unified Pipeline (PR #27, 15 commits)

**Gen 9 — Native Hyperliquid perps:**
- HyperliquidClient wrapping hyperliquid SDK (market/limit/stop/TP/bracket)
- 6 HTTP endpoints at /hyperliquid/*
- /execute dispatch for target_protocol="hyperliquid"
- 7 real E2E testnet tests
- Agent prompt updated with full HL API docs

**Gen 10 — Fund safety:**
- Position ledger (hl-positions.json) survives restarts
- Startup reconciliation (orphan detection from HL clearinghouse)
- Graceful shutdown (SIGTERM emergency-closes all HL positions)
- Retry with exponential backoff
- Trading envelope (pre-approved policy surface, instant execution)
- ValidationTrust: PerTrade / Envelope / SelfOperated

**Gen 11 — Unified backtest→paper→live pipeline:**
- StrategyRunner: streaming wrapper over BacktestEngine
- Same HarnessConfig drives all three modes
- Equivalence test: verified on 200 real Binance ETH/USD 1h candles
- Batch entries match streaming entries (strict subset)

**Deployment infra:**
- Hetzner server provisioned: 178.104.232.124 (CAX11 ARM, 4GB, Nuremberg)
- 100GB Hetzner Cloud Volume at /mnt/trading-data
- Blueprint binary built (47MB ARM64)
- go-live.sh: full E2E automation (build → deploy → register → request → BPM start)
- systemd unit for Blueprint Manager (NOT raw binary)
- Sandbox deps converted from path → git (enables remote builds)

### Remaining for launch
- [ ] cargo-tangle installing on Hetzner (in progress)
- [ ] Tangle testnet contracts deployed (other agent)
- [ ] TANGLE_CONTRACT + RESTAKING_CONTRACT addresses
- [ ] Fund HL testnet wallet (bridge testnet USDC)
- [ ] Run go-live.sh end-to-end
- [ ] Request 2 service instances with different strategy prompts
- [ ] Verify BPM spawns both blueprint instances
- [ ] First real HL testnet trade via the agent

### Test counts
- Forge: 429 (contracts)
- Rust runtime: 310 (including 13 HL + 11 envelope + 6 runner + 4 ledger)
- Rust http-api: 16
- Rust blueprint-lib: 99
- Rust validator: 56
- Backtest equivalence: 3 (synthetic + SL pattern + real Binance)
- HL E2E: 7 (behind HYPERLIQUID_E2E=1 gate)

## 2026-05-31 — Evolve round 4: self-improvement cadence + conductor verification

Status: KEEP. The backtest-to-paper conductor is no longer just compile-clean; it has an activation regression test and the sandbox-local cadence now keeps both delegated MCP work and TS-side candidate generation alive across workflow ticks.

Changes:
- Added `self_improvement_cadence` in `trading-blueprint-lib`: active paper bots get periodic MCP task-store maintenance, and one eligible bot per tick can launch `/home/agent/tools/self-improvement-loop.ts run ...` in the sandbox when no trial or non-terminal evolution run is open.
- Kept the crate boundary intact: TS mutates/probes candidates through `/evolution/promotion-gate`; Rust only schedules, activates paper trials, tags evidence, and promotes/tables.
- Hardened trial evidence lookup by preferring revision-scoped paper trades before candidate-hash fallback.
- Added an integration test proving a queued `backtest_pass` run swaps the paper bot harness, sets the trial marker, and advances to `paper_trial`.
- Fixed the stale `TradeRecord` fixture missing `hyperliquid_metadata` so workspace lib tests compile.

Verification:
- `cargo check --workspace` passed.
- `cargo test -p trading-blueprint-lib self_improvement_cadence --lib -- --nocapture` passed.
- `cargo test -p trading-blueprint-lib --test integration test_promotion_conductor_activates_queued_backtest_pass_candidate -- --nocapture` passed.
- `cargo test -p trading-blueprint-lib self_improvement_loop_uses_tangle_agent_packages_and_existing_api --lib -- --nocapture` passed.
- `cargo test --workspace --lib` passed: 659 + 228 + 76 library tests.
- `cargo clippy -p trading-blueprint-bin --tests -- -D warnings -A clippy::collapsible-if -A clippy::manual-inspect -A clippy::needless-question-mark -A clippy::too-many-arguments` passed after making startup sandbox recovery public to the bin crate surface.
- `cargo test -p trading-http-api --test api_tests evolution_promotion_gate -- --nocapture` passed: 4 promotion-gate integration tests.
- `cargo test -p trading-http-api --test api_tests self_improvement -- --nocapture` passed: 4 self-improvement API integration tests.
- `npm run typecheck:evals` passed.
- `npx tsc --target ES2022 --module ESNext --moduleResolution Bundler --noEmit --skipLibCheck trading-blueprint-lib/src/prompts/tools/self_improvement_loop.ts` passed.
- `forge build` passed with existing Foundry/forge-lint warnings.

Remaining:
- Deploy this branch to the live box and observe a real sandbox cadence run.
- Let an active paper trial accrue at least 20 tagged trades, then prove the gate advances a run to `promoted`.
- Base Sepolia real-vault path is still blocked on funding deployer `0x2420...`; the deploy-only script compiles but should not be broadcast until funded.

## 2026-05-31 — Evolve round 5: risk-budgeted fast promotion

Status: KEEP. The promotion path is no longer paper-only. `/evolution/promotion-gate` now returns a persisted `EvidenceReport` and `RiskBudgetDecision` beside the legacy boolean approval, and time-sensitive candidates that pass the hard backtest/overfit gates can receive a capped `tiny_live` / `live_probe` decision before paper evidence exists. Certified hot-path candidates without forward evidence still receive bounded probes, not uncapped active allocation.

Changes:
- Added `trading-http-api/src/risk_budget.rs` with promotion levels, decision actions, persisted reports/decisions, deterministic IDs, TTLs, and live enforcement helpers.
- Extended `/evolution/promotion-gate` and `/evolution/self-improve` to accept `risk_budget`, persist audit artifacts, and return decision/report IDs.
- Extended `TradeRecord` and `SelfImprovementRun` with risk-budget audit IDs.
- Enforced `risk_budget_decision_id` before all current live venue branches in `/execute`: EVM/vault, Polymarket CLOB, and Hyperliquid.
- Made the live budget check fail closed on malformed caps, wrong candidate/revision metadata, and counted-probe reuse; `max_trades` reservations happen before external dispatch to avoid concurrent over-consumption.
- Updated TS self-improvement probes and the Polymarket submit tool so agents can request fast-path evaluation and carry the returned decision ID into live candidate trades.
- Updated the agent prompt to require copying `risk_decision.decision_id` into `intent.metadata.risk_budget_decision_id` for live candidate execution.

Verification:
- `git diff --check` passed.
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

Remaining:
- Deploy this branch to the live box and prove a real time-sensitive candidate returns `risk_decision.action=live_probe`.
- Submit a capped CLOB live probe carrying `risk_budget_decision_id` plus matching `candidate_hash` or `revision_id`, and verify `/execute` rejects missing, expired, wrong-candidate, wrong-protocol, malformed-cap, over-cap, and over-trade-count variants on box.
- Add live drift/demotion automation against `max_loss_usd`; the decision object stores the cap, but this round only enforces notional, candidate/revision, venue/protocol, TTL, and trade-count pre-dispatch.

## 2026-05-31 — Evolve round 6: Hyperliquid outcome-market parity

Status: KEEP. Hyperliquid prediction markets now reuse the Hyperliquid order transport while being tagged, valued, and capped like binary prediction markets. This closes the gap where Hyperliquid outcome probes could be gated as generic Hyperliquid trades instead of Polymarket-like bounded-loss outcome trades.

Changes:
- Added a shared `hyperliquid_intent` helper so `/validate` and `/execute` resolve Hyperliquid asset IDs, outcome encodings (`#17` -> `100000017`), `outcome_id/outcome_side`, and asset sizes identically.
- Added metadata-based Hyperliquid valuation: `asset_size`, `limit_price`/`price`, and `notional_usdc` now produce priced notional before risk-budget enforcement; outcome prices must be `<= 1`, and `notional_usdc` must match `asset_size * price`.
- Extended prediction trade metadata and synthetic portfolio reconstruction so Hyperliquid outcome trades are recorded as prediction/conditional-token exposure, not perps.
- Clamped binary prediction live-probe notional to `max_loss_usd` and enforced `max_loss_usd` pre-dispatch for Polymarket and Hyperliquid outcome trades, because worst-case binary outcome loss equals notional.
- Added cumulative per-decision notional reservation so multi-trigger live probes cannot exceed the decision's total `max_notional_usd` or binary `max_loss_usd` budget across several dispatches.
- Updated the Hyperliquid provider and system prompt so agents treat Hyperps/outcome markets as `target_protocol="hyperliquid"` with prediction-specific metadata and a required risk-budget decision.
- Updated TS self-improvement risk-budget inference so "Hyperliquid prediction/outcome/Hyperp" requests target venue/protocol `hyperliquid`, not `polymarket_clob`.
- Fixed two pre-existing clippy test nits that blocked package-level clippy for the touched crates.

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

Remaining:
- Deploy this branch to the live box.
- Run a live-box Hyperliquid outcome dry probe with a returned `risk_budget_decision_id`, `candidate_hash`, `asset_id`, `asset_size`, and `notional_usdc`.
- Add mark-to-market live drift/demotion once outcome midprice ingestion is available from the live Hyperliquid info endpoint.

## 2026-05-31 - Evolve round 7: live drift demotion

Status: KEEP. Risk-budgeted live probes now have a post-dispatch feedback path. A candidate can still be promoted to a bounded tiny-live probe without waiting for paper evidence, but the same decision can now be evaluated against live fills and venue marks and automatically demoted when the decision's loss/slippage/TTL/trade-count budgets breach.

Changes:
- Added `/evolution/risk-budget/decisions/{decision_id}/live-drift` for single-bot and multi-bot API modes.
- Added `LiveDriftReport` with trade count, total/reserved notional, average/max slippage, marked PnL, marked return, breaches, recommendation, and the updated decision snapshot.
- Added decision fields for explicit `max_live_loss_pct`, `max_live_slippage_bps`, `demoted_at`, and `demotion_reason`.
- The drift evaluator reads persisted live trades for the risk decision, accepts venue marks keyed by token/outcome asset ID/asset label, computes mark-to-market PnL, and atomically disables `can_trade_live`/`can_touch_funds` on breach.
- Extended the sandbox self-improvement risk-budget request with `SELF_IMPROVEMENT_MAX_LIVE_LOSS_PCT` and `SELF_IMPROVEMENT_MAX_LIVE_SLIPPAGE_BPS`.
- Updated the system prompt and Hyperliquid provider prompt so agents call the live-drift endpoint after live outcome probes.

Verification:
- `git diff --check` passed.
- `cargo check --workspace` passed.
- `cargo clippy -p trading-http-api -p trading-runtime -p trading-blueprint-lib --tests -- -D warnings -A clippy::collapsible-if -A clippy::manual-inspect -A clippy::needless-question-mark -A clippy::too-many-arguments` passed.
- `cargo test --workspace --lib` passed.
- `cargo test -p trading-http-api risk_budget --lib -- --nocapture` passed.
- `cargo test -p trading-http-api test_evolution_live_drift_endpoint_reports_and_demotes_decision --test api_tests -- --nocapture` passed.
- `cargo test -p trading-http-api routes::execute --lib -- --nocapture` passed.
- `cargo test -p trading-http-api --test api_tests evolution_promotion_gate -- --nocapture` passed.
- `cargo test -p trading-blueprint-lib providers::hyperliquid --lib -- --nocapture` passed.
- `cargo test -p trading-blueprint-lib prompts --lib -- --nocapture` passed.
- `npx tsc --target ES2022 --module ESNext --moduleResolution Bundler --noEmit --skipLibCheck trading-blueprint-lib/src/prompts/tools/self_improvement_loop.ts` passed.

Remaining:
- Deploy this branch to the live box.
- Run real/dry venue probes and call live-drift with actual Polymarket/Hyperliquid marks.
- Base Sepolia real-vault path remains blocked on funding deployer `0x2420...`.
