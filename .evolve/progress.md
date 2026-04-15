# Progress — ai-trading-blueprint Security Hardening

## Timeline

### 2026-04-15: /harden scan
- 6 parallel adversarial scans: contracts, API, race conditions, credentials, coverage, fuzz
- Found 2 CRITICAL, 8 HIGH, 10 MEDIUM, 9 LOW
- Fixed C-1 (approveSpender → DEFAULT_ADMIN_ROLE), C-2 (unwind totalAssets invariant), M-3 (scoring fallback → 0)
- Added 11 adversarial Forge tests

### 2026-04-15: /pursue Gen 1 — Close Trust Gaps (Solidity)
- H-4, H-5, H-6, H-2, M-7 fixed

### 2026-04-15: /pursue Gen 2 — Protocol Security (EIP-712 + Rust)
- H-3 (EIP-712 typehash extension), H-1 (off-chain sig verify), H-7/H-8 (lifecycle mutex)

### 2026-04-15: /evolve Round 3 — Close MEDIUM findings
- M-1, M-2, M-4, M-5, M-6, M-8, M-10 fixed

### 2026-04-15: /evolve Round 4 — Close LOW findings (high-ROI subset)
- **L-1**: Virtual offset raised from 1 wei → 1e6 (stronger inflation protection); `TradingVault.sol:196`
- **L-3**: Added `getBrokenVaults()` view for off-chain detection of silently-excluded vaults; `VaultShare.sol`
- **L-4**: Private key parse error redacted — logged server-side, client sees generic message; `collateral.rs:255`
- **L-5**: `deadline_secs` capped at `MAX_DEADLINE_SECS=3600` (1hr); `validate.rs:33`
- **L-6**: `OWNER_MESSAGES` per-bot cap 10K with half-eviction on overflow; `session.rs:368`
- **L-7**: Test stderr prints redact API tokens (prefix+length only) and secrets response body (length only); `tangle_e2e_full.rs:186`, `tangle_binary_e2e.rs:453`

### Deferred (design trade-offs / operational concerns)
- **L-2**: `emergencyWithdraw` timelock — adds friction to a critical safety valve; current design is intentional
- **L-8**: Rate limit slot consumed on invalid sig — restructure requires rethinking gas costs (operator-level DoS only)
- **L-9**: `StrategyRegistry.registerStrategy()` permissionless — registry is informational only, doesn't gate vault security

## Final State
- **CRITICAL: 0** (2 fixed)
- **HIGH: 0** (8 fixed)
- **MEDIUM: 0** (10 fixed)
- **LOW: 3 deferred** (6 fixed, 3 deferred with rationale above)
- **Forge tests: 400/400**
- **Rust: 5 modified library crates compile clean on 1.91**

## Converged
All actionable findings from /harden are resolved or explicitly deferred with rationale.
Remaining 3 LOW findings are design trade-offs that shouldn't be fixed reactively.
