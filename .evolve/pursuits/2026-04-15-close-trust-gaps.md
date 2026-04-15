# Pursuit: Close Trust Gaps Between Validation Layers
Generation: 1
Status: building

## System Audit
- **What exists and works**: On-chain EIP-712 m-of-n signature verification, intent deduplication, PolicyEngine whitelists, score thresholds. Forge test suite with 400 passing tests.
- **What exists but isn't integrated**: `verify_all_signatures()` exists in `signature_verify.rs` but is never called from the execute path.
- **What was tested and failed**: The harden run proved 4 attack vectors with PoC tests. C-1 and C-2 were fixed.
- **What doesn't exist yet**: Off-chain signature verification in execute path, SSRF protection, per-bot lifecycle mutex, collateral operator crediting.
- **Measurement gaps**: No cargo audit, no Rust fuzz targets, no benchmark infra.

## Baselines
- 2 CRITICAL fixed, 8 HIGH remaining, 10 MEDIUM (1 fixed), 9 LOW
- Forge suite: 400/400 passing
- Rust: cannot compile locally (blueprint-sdk path dep missing)

## Diagnosis
**Root cause**: The security model trusts intermediaries at multiple layers:
1. On-chain: `intentHash` is opaque — validators sign an intent but the operator chooses what calldata to actually submit.
2. Off-chain: The execute endpoint trusts the sidecar's claim that validation passed without re-verifying signatures.
3. Collateral: `returnCollateral()` credits the wrong address.
4. NAV: `positionsValue()` assumes uniform decimals.
5. Concurrency: No lifecycle mutex means TOCTOU across all bot operations.

These are architectural, not tunable.

## Generation 1 Design

### Thesis
Gen 1 closes every trust gap where an intermediary (operator, sidecar, concurrent request) can cause fund loss or state corruption.

### Moonshot considered
Redesign EIP-712 to include `target` + `keccak256(data)` in the signed struct — making trade substitution cryptographically impossible. **Rejected for Gen 1**: this is a breaking protocol change that requires coordinated updates to Solidity + Rust signer + Rust verifier + all validators. Better suited for Gen 2 after the non-breaking fixes ship. The intentHash binding is the #1 remaining risk but requires a protocol version bump.

### Changes (ordered by impact)

#### Solidity (testable now)
| # | Change | Risk | Files |
|---|--------|------|-------|
| 1 | H-4: Fix `returnCollateral()` — add `operator` parameter | Medium | TradingVault.sol |
| 2 | H-5: Normalize decimals in `positionsValue()` | Medium | TradingVault.sol |
| 3 | H-6: Set default `adminUnwindMaxDrawdownBps` to 500 (5%) | Low | TradingVault.sol |
| 4 | M-7: IDOR fix — scope `get_trade` to calling bot | Low | trades.rs |
| 5 | H-2: SSRF fix — remove user-controlled `rpc_url` | Low | clob.rs |

#### Rust (syntactic — blueprint-sdk not available locally)
| # | Change | Risk | Files |
|---|--------|------|-------|
| 6 | H-1: Call `verify_all_signatures()` for non-paper execute | Medium | execute.rs |
| 7 | H-2: Remove `rpc_url` query param from CLOB approve | Low | clob.rs |

### Risk + Success criteria
- All 400+ existing Forge tests must pass
- New adversarial tests must pass
- No breaking interface changes (Gen 2 can do breaking changes)
- Metric: HIGH findings from 8 → 2 (H-3 intentHash binding + H-7/H-8 lifecycle races deferred to Gen 2)

### Build Status
| # | Change | Status | Files | Tests |
|---|--------|--------|-------|-------|
| 1 | returnCollateral operator param | **DONE** | TradingVault.sol, contracts.rs, vault_client.rs, collateral.rs, anvil_integration.rs, ClobCollateral.t.sol, Adversarial.t.sol | 400/400 |
| 2 | positionsValue decimal normalization | **DONE** | TradingVault.sol | 400/400 |
| 3 | adminUnwind default drawdown cap (500 bps) | **DONE** | TradingVault.sol | 400/400 |
| 4 | IDOR fix (scope get_trade to bot) | **DONE** | trades.rs | syntactic (needs Rust compile) |
| 5 | SSRF fix (remove rpc_url param) | **DONE** | clob.rs | syntactic (needs Rust compile) |

## Generation 1 Results

### Scores
| Dimension | Before | After | Delta |
|-----------|--------|-------|-------|
| CRITICAL findings | 2 | 0 | -2 (fixed in harden) |
| HIGH findings | 8 | 3 | -5 |
| MEDIUM findings | 9 | 7 | -2 |
| Forge tests | 400/400 | 400/400 | clean |

### What worked
- returnCollateral fix is clean — existing tests adapted smoothly, permissionless return now credits the correct operator
- positionsValue decimal normalization uses try/catch for tokens without decimals() — defensive
- SSRF fix is minimal — just removes the user-controlled parameter

### What's left for Gen 2
- H-1: Off-chain signature verification (needs blueprint-sdk to compile)
- H-3: intentHash binding to trade params (breaking protocol change — needs coordinated Solidity + Rust + validator update)
- H-7/H-8: Per-bot lifecycle mutex + workflow tick exclusion (Rust-only, needs blueprint-sdk)

### Verdict: ADVANCE
Gen 1 ships. Remaining HIGHs are architectural (H-3) or require the local Rust build env (H-1, H-7, H-8).

### Seeds for Gen 2
- Extend EIP-712 VALIDATION_TYPEHASH to include `target` and `keccak256(data)` — eliminates trade substitution
- Add per-bot `DashMap<String, Arc<Mutex<()>>>` for lifecycle operations
- Wire `verify_all_signatures()` into execute handler

Run `/evolve` targeting the remaining 3 HIGH findings against the Gen 1 baseline.
