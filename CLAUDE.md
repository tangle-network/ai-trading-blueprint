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

## Running E2E Tests

### Prerequisites
- Docker running with `tangle-sidecar:local` image built
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
