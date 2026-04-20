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
