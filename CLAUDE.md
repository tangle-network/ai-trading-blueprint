# Project Instructions

## Architecture
See [ARCHITECTURE.md](./ARCHITECTURE.md) for system design, session management, agent iteration protocol, feedback loop, scheduling, and crate map.

Canonical lifecycle model:
- Cloud blueprint keeps lifecycle jobs (`JOB_PROVISION` / `JOB_DEPROVISION`).
- Instance and TEE instance blueprints do not expose lifecycle jobs; singleton lifecycle is service-init + operator API (`POST /api/bot/provision`).

## Git Commits
- Never include Co-Authored-By lines in commit messages. Do not mention Anthropic or Claude.
- Always use the logged-in git config user (drewstone329@gmail.com) as the sole author.

## Development Principles

### Prefer returning over re-reading
When a function already has data in scope (e.g., a record it just loaded or created), return it to callers rather than making them re-read from storage. Re-reads are fragile — they can fail due to stale caches, different store paths, or binary version mismatches. If `activate_bot_with_secrets` already loaded the bot record, return the token in `ActivateResult` instead of making the caller do `resolve_bot()` again.

### Rebuild release binaries before E2E tests
The Blueprint Manager's `TestSourceFetcher` **skips rebuild** when a release binary already exists on disk. If you've changed Rust source since the last `cargo build --release`, the Manager will spawn a stale binary. Always run `cargo build --release -p trading-blueprint-bin` before Manager E2E tests.

### Understand the Manager's discovery pipeline
The Manager uses a multi-step pipeline to find and spawn blueprints. When tests fail at the Manager level, trace through each step:
1. **Service discovery**: Event-based (`eth_getLogs`) → contract state fallback (`service_count` + `is_service_operator`)
2. **Source resolution**: On-chain sources (Container, Testing, Github) → `BLUEPRINT_CARGO_BIN` native fallback
3. **Binary spawn**: `TestSourceFetcher` builds/locates binary → `Service::from_binary` spawns with `BlueprintEnvVars`
4. **Env var inheritance**: Manager passes `DATA_DIR`, `HTTP_RPC_URL`, etc. Custom env vars (like `VALIDATOR_ENDPOINTS`) are inherited from the Manager's own environment.

### Test infrastructure ordering matters
Integration tests with multiple infrastructure components (Anvil, validators, Manager, binary) have ordering constraints. Document why components start in a particular order. When a component needs config from another (e.g., validators need the contract address for EIP-712 signing), either pre-compute deterministic values or accept partial coverage with clear comments about what's covered elsewhere.

### Shared UI package ownership (required for UI changes)
Use these boundaries whenever editing `arena/src`:

- `@tangle/blueprint-ui`:
  - Chain and contract primitives (`publicClient`, address/chain helpers, ABI exports)
  - Blueprint infra hooks and stores (operators, quotes, provisioning, tx/session state)
  - Reusable design-system components/layout primitives
- `@tangle/agent-ui`:
  - Agent chat/session UX (message rendering, run grouping, tool previews)
  - Sidecar auth/session helpers and PTY terminal integration
  - Generic agent-facing UI utilities from `@tangle/agent-ui/primitives`
- App-local (`arena/src/**`):
  - Trading-specific workflows, copy, route composition, bot/vault domain logic

When duplication appears across Arena and Sandbox UIs:
- If logic is chain/infra-oriented and app-agnostic, move to `@tangle/blueprint-ui`.
- If logic is agent/chat/session/terminal-oriented, move to `@tangle/agent-ui`.
- If logic is product-specific, keep it app-local.

PR gate before merging UI changes:
- Search for near-duplicate code in both UIs (`jscpd` or targeted `rg`).
- If the same pattern exists in both apps and exceeds roughly 20 lines, either extract it now or document why extraction is deferred.
- Suggested command:
  - `npx jscpd --min-lines 8 --min-tokens 80 --format ts,tsx --ignore "**/node_modules/**,**/.next/**,**/dist/**,**/build/**" /home/drew/code/blueprint-ui/src /home/drew/code/ai-agent-sandbox-blueprint/packages/agent-ui/src /home/drew/code/ai-agent-sandbox-blueprint/ui/src /home/drew/code/ai-trading-blueprints/arena/src`

### Remote/Tailscale browser contract

- Do not rely on browser `localhost`/`127.0.0.1` fallbacks for production-style
  UI flows.
- Keep RPC and API endpoints explicit in env for browser consumers.
- When proxying RPC in dev (`arena/vite.config.ts`), verify remote browser access
  from non-localhost hosts (Tailscale/LAN) before marking done.
- Treat loopback URLs in tests as local-test scaffolding only, not deploy
  guidance.

### UI quality gates (required for UX-affecting PRs)

- Async status/notice paths must be visible to the user (not only logged in
  state).
- Destructive actions require explicit confirmation or undo behavior.
- Form labels must be programmatically bound (`htmlFor` + `id`).
- Use semantic theme tokens for status text; avoid hardcoded low-contrast accent
  classes in light mode.
- Respect `prefers-reduced-motion` for non-essential UI transforms/transitions.

## Running E2E Tests

### Prerequisites
- Docker running with `blueprint-sidecar:all-harness` image built
- Forge contracts compiled: `cd contracts && forge build`
- For AI tests: `ZAI_API_KEY` set (from `.env` or environment)

### Commands
```bash
# Full E2E suite (policy-only validators, ~6s)
SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_e2e_full -- --nocapture

# Full E2E suite with real AI scoring (~45s)
SIDECAR_E2E=1 ZAI_API_KEY=<key> cargo test -p trading-blueprint-lib --test tangle_e2e_full -- --nocapture

# Binary process E2E (~9s)
SIDECAR_E2E=1 cargo test -p trading-blueprint-lib --test tangle_binary_e2e -- --nocapture

# Operator API tests (no infra needed, ~0.03s)
cargo test -p trading-blueprint-bin -- operator_api
```

### Known behaviors
- **AI scores are non-deterministic**: GLM-4.7 scores test trades 43-52/100 (often below 50 threshold). AI pipeline tests verify scoring + signing works without requiring approval.
- **Score threshold is off-chain only**: `TradeValidator.sol` checks signature count (m-of-n), not score values. Low-scored trades with valid signatures would execute on-chain.
- **alloy transport quirk**: After `.send()` returns a revert error, the HTTP transport may hang on subsequent sends. Adversarial tests use `.call()` for revert verification.

## Hard-won facts & gotchas (READ FIRST — stop re-deriving these)

Maintained so sessions don't re-spelunk. Append when you discover something costly; correct when wrong.

### Eval measurement architecture
- The multishot eval (`evals/src/sim/multishot-user-sim.ts`) drives a **6-turn CHAT conversation**, then collects `bot-artifacts.ts` via `OperatorClient`. It does **NOT** trigger the cron fast-tick.
- The **deterministic fast tick** (`workflow_tick.rs` → `node /home/agent/tools/<family>-tick.js`) fires on a **cron workflow**, separately. So the eval's short window never runs the tick → `decisions.jsonl`/`metrics` are absent unless explicitly captured. **This is the binding measurement gap (#122).**
- Per-family tick tools (Gen-4): `tick_tool_for_strategy()` in `prompts/mod.rs` maps `hyperliquid_perp/dex/mm/yield/multi` → `*-tick.js`. Single source of truth, shared by the Rust runner and the fast-tick prompt.

### RLM trace analyst (agent-eval SDK) — do NOT hand-roll a regex analyst
- Analyst lives in `evals/src/analysis/{otlp-capture,rlm-analyst}.ts`. 100% SDK primitives.
- **OTLP-JSONL format `OtlpFileTraceStore` actually parses** (`readOtlpSpan`): **ONE FLAT SPAN PER LINE** — `{trace_id|traceId, span_id, parent_span_id, name, start_time, end_time (ISO date strings, NOT unixNano), status:{code:"OK"|"ERROR"}, attributes:{plain key→value object}}`. **NOT** `resourceSpans`/`scopeSpans`-wrapped, **NOT** the `{key,value:{stringValue}}` array form. Wrong shape → `total_traces: 0` silently.
- Store method is `store.getOverview({})` (the actor tool wraps it as `getDatasetOverview`). Other methods: `queryTraces/countTraces/viewTrace/viewSpans/searchTrace/searchSpan`.
- `analyzeTraces({question}, {source: store|otlpPath, ai: AxAIService, model, maxTurns, maxDepth, progressLogPath, onTurn})`. Domain framing goes in `question`, not `actorDescription`.
- **AxAI** (`@ax-llm/ax`): `new AxAI({name:'openai', apiKey, apiURL: <baseUrl>, config:{model}})` — URL override is **`apiURL`** (top-level), NOT `options.baseURL`. `config.model` typed as enum → cast for custom Kimi/GLM ids.
- `AnalystRegistry` path uses `createChatClient({transport:'direct-provider', baseUrl, apiKey, defaultModel})` instead.
- Always validate the analyst by actually running it (`store.getOverview` must show `total_traces>0`) — static typecheck won't catch format/shape mismatches.

### Model routing (single table — reuse, don't duplicate)
- `evals/src/sim/llm-call.ts`: `MODEL_CONFIG` + exported `resolveModel(model)` / `ModelRouting`. `kimi-k2`→`MOONSHOT_API_KEY` (api.moonshot.ai/v1, kimi-k2.6); `glm-4.7`/`glm-5.1`→`ZAI_API_KEY` (api.z.ai/api/coding/paas/v4).

### Operator ↔ sandbox plumbing
- Operator execs into a bot sandbox via `ai_agent_sandbox_blueprint_lib::run_exec_request(&SandboxExecRequest{sidecar_url,command,cwd,env_json,timeout_ms}, &token)` → `SandboxExecResponse{exit_code,stdout,stderr}`. Get the sandbox with `sandbox_runtime::runtime::get_sandbox_by_id(&bot.sandbox_id)`.
- Tick side effects live in-sandbox: `/home/agent/logs/decisions.jsonl`, `/home/agent/metrics/latest.json`, strategies under `/home/agent/tools/strategies/`.
- Activation bundles tools via `include_str!` + `write_file_to_sidecar` in `jobs/activate.rs`.

### Agent system prompt — how the trading-operator identity actually reaches opencode (2026-05-30, costly to derive)
- The sidecar runs `opencode serve` and injects its **own** opencode config via the `OPENCODE_CONFIG_CONTENT` env var (provider + tools + model from `OPENCODE_MODEL_*`, **no system prompt and no `instructions`**). This OVERRIDES `opencode.jsonc` on disk — so the `agent.build.prompt` activate.rs writes there is **silently ignored**. Symptom: the agent answers as the default opencode coding assistant ("I help with software engineering tasks"), not the trading operator.
- opencode only loads custom instructions when its **config has an `instructions` array**. The sidecar's opencode provider adds `instructions: [".opencode/profile-instructions.md"]` to that config **only when the `/agents/run` body carries a profile with instructions** (adapter.ts ~2987). No profile in the body → no instructions → default identity.
- The fix (both needed): (1) `activate.rs sync_profile_instructions` writes `/home/agent/AGENTS.md` (`SIDECAR_AGENTS_MD_PATH`, `OPERATOR_AGENTS_MD`) — opencode auto-loads AGENTS.md from the serve cwd `/home/agent`; (2) `operator_chat.rs run_agent_turn` run_body includes `backend.inlineProfile.instructions = ["AGENTS.md", ".opencode/profile-instructions.md"]`. Model/provider still come from `OPENCODE_MODEL_*` env. **Proven**: fresh provision → nudge → "I am the autonomous trading operator running your on-chain vault…".
- `opencode serve` reads AGENTS.md at **server start** — a serve already running before AGENTS.md is written keeps the default. activate.rs writes it before first serve, so OK; hot-patching a live sidecar needs `pkill -f "opencode serve"` (provider respawns).
- `/agents/run` response shape is `{success, data:{finalText, toolInvocations, metadata}}`. The operator reads `data.finalText` (NOT `response` — that was the "Agent run completed without text output" bug, fixed in operator_chat.rs).
- opencode `serve` startup timeout is **hardcoded 30s** in the pinned sidecar provider (`sdk-provider-opencode` server.ts/adapter.ts) — NOT env-tunable. Cold start is ~11s on a quiet box but exceeds 30s under load (a concurrent cargo build wedges it). Raising it needs owning/rebuilding the sidecar server layer.

### Self-sufficient blueprint-sidecar image (2026-05-30) — owned here, no external runtime dep
- The agent was dead for a day: the box ran `tangle-sidecar:local` (5 weeks old) with an **empty `/nix/profile/bin`** → every agentic tick threw `spawn opencode EACCES`. What looked like "trading" was only the deterministic fast-tick fallback.
- `blueprint-sidecar:all-harness` is now built from **this repo's own** `nix/agent-clis.nix` + `flake.nix` `packages.sidecar-harness` + `docker/blueprint-sidecar.Dockerfile`. 11 coding agents (opencode/claude-code/codex/qwen/gemini/amp/pi/forge/factory-droids/codex-acp/github-copilot), **system-aware x86_64 + aarch64** (box is arm64 — pin BOTH arches when bumping). nix builds inside the Dockerfile builder stage, bakes the ~840 MB closure into `/nix/profile/bin` over a pinned `blueprint-sidecar-base:pinned` (the server.js layer). Cachix `tangle-sandbox`.
- Dockerfile sets **only `NIX_BIN_PATH=/nix/profile/bin`**, NOT global PATH — prepending `/nix/profile/bin` to PATH shadows the base node (v24, carries node-pty) with the Nix node and breaks `node server.js` + PTY. `sidecar-harness` profile deliberately excludes nodejs for the same reason.
- Deploy: build on the box (it has docker, no nix), set `SIDECAR_IMAGE=blueprint-sidecar:all-harness` in `settings.env`, restart operator. Existing sidecars stay on the old image until recreated.

### Box build + branch reality (2026-05-30)
- cax11 has **3.7 GB RAM** — a parallel `cargo build` OOM-kills/wedges; **always `cargo build -j2`** (or it silently dies mid-compile with no error and the binary stays stale). A heavy build also wedges the live sidecars' opencode (30s-timeout failures). cargo is at `/root/.cargo/bin` (not on the default non-login PATH).
- The box repo runs branch **`eval/token-refresh-and-timeout`**, which has **diverged from main** (its `list_bots` is `SessionAuth(_caller)` and lists all with no `bot_visible_to`/viewer scoping; no `is_operator_admin`; ~78-line delta in operator_api.rs). Apply operator changes to the box as **surgical patches**, not file copies — and reconcile branches before assuming main-derived code applies.
- Public fleet read: box `list_bots` now drops `SessionAuth` entirely (it already returned all bots) → `GET /api/bots` is public. Local feat branch has the richer auth-optional `optional_session_caller` version (needs branch reconciliation to land).

### Arena UI (trading-arena.blueprint.tangle.tools)
- Live Cloudflare Pages SPA (React Router), embedded by cloud.tangle.tools as the blueprint's `externalApp` iframe (`metadata/blueprint-metadata.json`, blueprintId 13). Deploys via `.github/workflows/deploy-arena.yml` on push to `main` touching `arena/**`, or `gh workflow run deploy-arena.yml`. CF Pages project `trading-arena`; secrets `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` in GH.
- Bot roster source of truth = operators' `/api/bots` (NOT on-chain discovery — chain is only TVL/vault enrichment in `TradingSyncProvider`). Operators currently come from 3 hardcoded env URLs (`VITE_{CLOUD,INSTANCE,TEE}_OPERATOR_API_URL`); the directive is to discover them dynamically via `useOperators(blueprintId)` + `resolveOperatorRpc(rpcAddress)` (a pending refactor).
- Known UI bugs fixed in-repo (pending arena redeploy): mainnet RPC `eth.merkle.io` is CORS-hostile → `Web3Provider` maps chain 1 to a CORS-safe endpoint; the fleet list now fetches publicly without the viewer's token (`TradingSyncProvider`). The deployed arena's operator backend is set by CF Pages env (`VITE_CLOUD_OPERATOR_API_URL`), not the repo.

### Devnet (local)
- `./scripts/run-devnet.sh --no-ui` rebuilds release binaries (picks up `include_str!` tool changes) + brings up anvil (chain **31338**) + operator `:9200` + trading `:9100`. Needs ≥3 operators (operator3 added in `deploy-local.sh`).
- `RegisterBlueprint.s.sol` local path uses the **current `Types` ABI**; set `TANGLE_BLUEPRINT_ABI=v010` only for old V010 anvil snapshots (the canonical snapshot is tnt-core 0.13.0).

### Hetzner live box (testnet operator)
- `178.104.232.124` (root SSH), Hetzner **cax11 = ARM64, 2 vCPU / 4GB** — tight; release source-build swap-thrashes ~70min.
- Hardened: `ufw` (public allows only 22, 443, docker→9100/9200, loopback) + **Caddy TLS** at `https://178.104.232.124.sslip.io` → operator `:9200` (HSTS, 5MB body cap). `:9100`/`:9200` are NOT publicly reachable.
- Box `blueprint-manager.service` **source-builds** because **v0 was never published on-chain** (the blueprint native source has no fetcher → falls back to the `testing` cargo build). Fix = publish v0 (#92) so it FETCHES the release binary, or run with `USE_RELEASE_BINARY=v0.1.x`.
- Box repo (`/mnt/trading-data/opt-trading-blueprint/repo`) is on stale `codex/base-sepolia-live-runtime` (~111 behind main); its uncommitted work is preserved on branch `box-base-sepolia-patches`. `settings.env` is tracked-with-secrets there — handle carefully.
- v0.1.4 release tag (Gen-4) built x86_64 + **aarch64** binaries; release CI = `.github/workflows/release.yml` on `v*` tags.

### Paper-trading unblock (v0.1.10/v0.1.11, 2026-05-29) — why bots skipped, now fixed
Paper MM bots skipped every tick (`inventory-below-minimum`, then `submission-rejected`). THREE stacked plumbing bugs (not the strategy):
1. **Inventory invisible** — `tick_common.js isVaultSpot` required `protocol==='vault'`, but the paper portfolio synth labels seeded cash `'paper'` and swapped tokens by DEX venue. Fixed → gate on `position_type==='spot'`.
2. **Asset universe excluded mm/multi** — `trading_runtime::supported_assets::supported_assets_for` matched only `("dex", aerodrome|uniswap_v3)`; `mm`/`multi` fell to `_ => Vec::new()` → `/validate` rejected swaps. Fixed → `("dex"|"mm"|"multi", …)`.
3. Validate→execute chain confirmed: paper bypass approves, `execute_paper_trade` records a `TradeRecord`.
- Paper portfolio seed IS real: `build_multi_bot_portfolio_response`→`synthesize_trade_positions`→`seed_initial_paper_cash` credits `initial_capital_usd` as a `cash_token` spot position. Verify via `POST localhost:9100/portfolio/state` from the HOST with the bot's `TRADING_API_TOKEN` (bot resolved by bearer token; sandbox is bridge-net so `localhost:9100` is unreachable *inside* the container — query from host).
- **Honest fills (v0.1.11):** `execute_paper_trade` applies real per-protocol fee (`trading_runtime::protocol_fees::schedule_for().taker_bps`) + size-based impact (`notional/paper_reference_liquidity_usd`, $10M default, configurable). Records net `amount_out` + `slippage_bps` + `filled_price_usd`. Before this, fills were frictionless (fantasy P&L). MM rebalances on `±rebalance_band_pct` weight drift (default 0.1) then holds — infrequent by design.
- Strategy params are explicit + runtime-updatable: each tick reads `harness.{mm,portfolio,…}`; set via `PATCH /api/bots/{id}/config` (→`update_harness`) or the agent's `evolve-strategy.js promote()`. Agentic closed-loop param tuning (learn per-harness-version perf → propose → paper-gate → promote) is the next build; substrate in `routes/evolution.rs` + `learning_store.rs`.

### Mainnet paper-trading run (LIVE 2026-05-29, v0.1.12)
- The fleet paper-trades against **Base MAINNET (chain 8453)** — real coingecko prices (operator MARKET_DATA_BASE_URL=coingecko resolves 8453; verified WETH ~$2038), real-TVL-scaled impact ($20M ref), $0.05/swap gas — all paper (no on-chain tx). The operator/blueprint stays on Base Sepolia; only the bots' protocol_chain_id=8453 moves the trading venue. Base mainnet tokens: WETH 0x4200…0006, USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
- **create_bot derives chain/token from operator ENV, not the request** — the only way to set per-bot chain 8453 + mainnet USDC + paper knobs (paper_reference_liquidity_usd, paper_gas_cost_usd) is `PATCH /api/bots/{id}/config` with `strategy_config_json`; setting protocol_chain_id=8453 makes tick_common.js pairTokens() auto-resolve mainnet WETH/USDC. harness_json on PATCH is a JSON-encoded STRING containing a full HarnessConfig (version/entry_rules/exit_rules/filters/position_sizing) PLUS extra per-strategy keys (mm/portfolio/execution/risk) the tick scripts read; multi portfolio.assets use key `address` not `token`.
- 6-bot diverse fleet (2 mm band 3%/10%, 2 dex aero/uni momentum, 2 multi 50/50+60/40), $10k each, paper. Honest PnL nets fee+impact+gas (v0.1.11 fee/impact + v0.1.12 gas in execute_paper_trade::paper_fill_costs). Sepolia fleet stopped. Review ~2026-06-03 (task #128). MM seed can lag 1-2 ticks on first activation — re-run configureSecrets+PATCH if inventory=0.
- run-now (/api/debug/run-now) uses a broken opencode spawn on the box — IGNORE it; the real deterministic trading is the 5-min cron fast-tick (verify via tick-artifacts).

### Risk/learning-loop integrity audit (2026-06-11) — root causes, fixed on fix/self-improving-risk-loop
- **Drawdown was always 0 fleet-wide**: `write_metrics.js` stamped `high_water_mark = current NAV` on every tick snapshot, and `POST /metrics/snapshot` trusted client hwm/drawdown verbatim → the multi-bot circuit breaker (reads `latest_snapshot_for_bot().drawdown_pct`) could never trip. Fixed: hwm/drawdown are now server-computed in `record_snapshot_for_bot` from previous snapshot + `initial_capital_usd` baseline (self-heals polluted stores via the baseline max). Regression test: `test_metrics_snapshot_drawdown_is_server_authoritative`.
- **dex tick had no real exits**: only RSI≥70 take-profit; a tripped breaker returned `skip` while fully exposed. The harness `exit_rules` (StopLoss/TakeProfit/TrailingStop/TimeLimit) were honored by the BACKTESTER but ignored by the live tick — promotion evidence came from a simulator production couldn't reproduce. Fixed: `evaluateExitRules` + `latestEntryFill` in tick_common; dex_tick now honors exit_rules (default 5% stop), flattens on breaker trip (`drawdown-derisk-exit`), and routes thesis-invalidation exits by the entry's `runner_signal` (now persisted via intent metadata).
- **Self-improvement keyed on noise**: 1,843/2,392 evolution runs on the box were triggered by `no-clear-*` (healthy no-signal idle) classified as high-severity `blocked-action-path`; outcome findings never fired because ticks report no pnl/drawdown keys. Result: 2,376 blocked, 1 promoted. Fixed in reflection_loop.js: no-clear/holding are healthy states; pnl derived from NAV vs `initial_capital_usd`; new critical `mandate-drawdown-breach` finding; launch-ticket free-text risk ("4% max drawdown") parsed into the mandate (`mandateMaxDrawdownPct` in tick_common).
- Box evidence shorthand: 67,576 run records / only 800 with tokens (all `source: cadence` read-only reflections, no real user chats); run `result` JSON truncated at ~20k chars (breaks downstream parsing); no `providers/models/cost_usd` recorded at all on the box build; `perp-tick.js`/`volatility-tick.js` unsupported by the deployed binary (those bots never traded); fleet roster polluted with QA/canary bots.
- Box is now **x86_64** (verified `uname -m` 2026-06-11) — the earlier "cax11 ARM64" notes are stale. Runtime unit is `trading-blueprint-runtime.service` exec'ing `/root/.cache/blueprint-manager/svc-13-0/trading-blueprint` directly (`blueprint-manager.service` is inactive); deploy = replace that binary from the GitHub release (x86_64 tarball) + restart unit.

### Process gotchas (these cost real tool calls)
- **`pkill -f <pattern>` kills your own shell** when the shell's command string contains `<pattern>` → exit 144. Kill by explicit PID instead; `pgrep -f` also self-matches.
- `evals/` and `trading-blueprint-lib/` are **ESM (`"type":"module"`)**; sandbox `/home/agent` is **CommonJS**. Test tool JS via a `.cjs` copy or in-sandbox, not local `require` of the ESM dir.
- `ai-agent-hooks` pre-commit/`pre-push` do `mkdir` under `.git/` → **fail in git worktrees** (`.git` is a file). Use `git -c core.hooksPath=/dev/null` for worktree commits/pushes (after manually confirming no conflict markers / secrets).
- gh CLI is pinned to `tangletools` via `GH_TOKEN` (can't `gh auth switch`). Convention is open PRs as drewstone329, but the token forces tangletools — note it, proceed.
- **Sidecar exec (`run_exec_request`) runs `command` RAW** — no `sh -c`, no shell-escape (`build_exec_payload` in ai-agent-sandbox-blueprint sends it verbatim to the sidecar's `/terminals/commands` PTY). A bare `node -e '…single-quoted with inner "double quotes"…'` gets mangled to an empty program → **exit 0, empty stdout** (looks like success, parses to nothing). Use a **quoted heredoc on stdin**: `node - <<'NODE' … NODE` (see `jobs/workflow_tick.rs`, `jobs/tick_artifacts.rs`). Same trap for any multi-quote one-liner. Stored sidecar tokens in `blueprint-state/sandboxes.json` are encrypted-at-rest (`enc:v1:…`) → can't curl the sidecar directly; verify via the operator endpoint.

### #122 status — LIVE-BOX fix (v0.1.7, 2026-05-29)
- On the live box the endpoint 502'd ("JSON parse failed: EOF") even with `decisions.jsonl`/`metrics/latest.json` present — root cause was the bare-`node -e` sidecar-exec mangling above (the files exist; the read returned empty). Fixed in `tick_artifacts.rs` by switching to the `node - <<'NODE'` heredoc (commit on v0.1.7). Releases stack: v0.1.5 (#122 endpoint + /api/bots scoping) → v0.1.6 (OTLP telemetry) → v0.1.7 (this read fix). Deploy v0.1.7 to the box, then re-curl `GET /api/bots/{id}/tick-artifacts` (expect real JSON, not 502).
- OTLP→Intelligence telemetry (`trading_blueprint_lib::telemetry`): enabled by `TANGLE_API_KEY`(sk-tan) or `OTEL_EXPORTER_OTLP_ENDPOINT`; box has neither yet (only `ZAI_API_KEY`) so export is OFF (fail-open). Set `TANGLE_API_KEY` in `settings.env` to light it up. Upstreamed to blueprint-qos as PR tangle-network/blueprint#1443.
- RLM analyst (`analyzeTraces`) can crash mid-loop on an empty assistant completion from glm-5.1 ("Assistant message must include non-empty content") — caught by full-bot-eval (non-fatal), but yields no verdict. Upstream agent-eval robustness gap; follow-up.

### #122 status (PROVEN on devnet 2026-05-28)
- `GET /api/bots/{bot_id}/tick-artifacts` (operator) → `{decisions_jsonl, metrics_latest, strategies}` from the sandbox; `read_bot_tick_artifacts` in `trading-blueprint-lib/jobs/tick_artifacts.rs`. Eval fetches it into `UserSimSessionResult.tick_side_effects` (best-effort; null→analyst UNVERIFIABLE).
- e2e proof: a real `aerodrome-eth-usdc-mm` cell captured a genuine tick decision — `action:"quotes_pulled", reason:"Pool depth $632 insufficient for $30k MM - thin pool rule triggered"` + a written strategy file. So the eval's chat session DID trigger a tick (1 decision captured) — `#122b` (forcing a tick in-session) was NOT needed in this case; the bot ticks on its own during the session.
- Remaining for the analyst to read it as a venue family, the eval-side classification is now possible: `side_effects_captured=true` + `tick.fired=true`.

### Base Sepolia Tangle topology (CRITICAL — two deployments)
- **Canonical/live Tangle = `0x8299d60f373f3a4a8c4878e335cb9d840e6e3730`** (tnt-core `deployments/base-sepolia/latest.json`). blueprintCount=17 → trading=**13**, instance=**14**, tee=**15**, validator=**16** registered 2026-05-23. staking `0x91b1186f`, statusRegistry `0x2a7ceb96`, tntToken `0x62b3407a`, chain 84532.
- **STALE pre-redeploy Tangle = `0x0fb3874f…`** (count=2). A redeploy happened 2026-05-22; do NOT use it.
- The ai-trading-blueprint vendored manifest (`deploy/manifests/base-sepolia/tnt-core.latest.json`) was stale (pointed at 0x0fb3) → the Hetzner box bound to the wrong Tangle as BLUEPRINT_ID=1. Fixed by re-vendoring tnt-core's latest.json (commit 0e32345). Box `settings.env` still needs regen (TANGLE_CONTRACT=0x8299, BLUEPRINT_ID=13/14) via go-live.
- Box operator `0x61B433776e789960426f86ED3300ADf1597D60f8` is NOT yet registered on blueprint 13 (`isOperatorRegistered(13,0x61B433)=false`) — go-live must onboard it.
- Read-only Tangle probes: `cast call <tangle> "blueprintCount()(uint64)" --rpc-url https://sepolia.base.org`; `isOperatorRegistered(uint64,address)(bool)`. `blueprintOwner`/`getBlueprint` signatures from RegisterBlueprint differ — `blueprintOwner(uint64)` reverts UnknownSelector on this ABI.

### Hetzner go-live progress + remaining blockers (2026-05-28)
Goal: box runs canonical blueprint 13 (cloud fleet) on Tangle 0x8299, Gen-4+#122 binary, register operator → instance service → provision bots.
DONE:
- Manifest re-vendored → 0x8299 (commit 0e32345). go-live deploy bugs fixed (commit a7f9a3d): SCRIPT_DIR clobber, TANGLE_*_RPC mapping, `--staking-contract`→`--restaking-contract`.
- Box: bootstrap+build skipped (already set up); fetched v0.1.4 **aarch64** operator binary (42M, sha256 OK) — no source build. Keystore 0x5Af6 installed. Targets BLUEPRINT_ID=13.
- Operator 0x5Af6 funded 100 TNT from deployer 0x2420 (tnt 0x62b3407a), then **STAKED + ACTIVE** (`isOperator(0x5Af6)=true` on staking 0x91b1186f). Re-stake reverts `OperatorAlreadyRegistered 0x866b0dcf` (expected).
- Run go-live: `cd ai-trading-blueprint; export ZAI_API_KEY; SKIP_PREFLIGHT=1 SKIP_BOOTSTRAP=1 SKIP_BUILD=1 USE_RELEASE_BINARY=v0.1.4 BLUEPRINT_ID=13 RUN_VALIDATOR=0 ./deploy/go-live-base-sepolia.sh 178.104.232.124 "$(cd ~/company/devops/secrets && dotenvx get TRADING_OPERATOR_PRIVATE_KEY -f trading-operator.env)"` (deployer key for TNT/publish: `dotenvx get BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY -f shared-testnet-deployer.env`).
REMAINING BLOCKERS:
1. **blueprint register**: `isOperatorRegistered(13,0x5Af6)=false`. Fails intra-run with `replacement transaction underpriced` (cargo-tangle fires blueprint-register too fast after staking-register; mempool clears between runs — nonce latest==pending). Retry as a standalone cargo-tangle `blueprint register` once mempool is idle, or bump gas.
2. **service request ABI mismatch fixed in branch**: `deploy/go-live.sh` now bypasses cargo-tangle for service creation and calls deployed tnt-core 0.13 `requestService(...)` + `approveService(ApprovalParams)` directly with `cast`. Still needs a live box rerun after this branch lands.
