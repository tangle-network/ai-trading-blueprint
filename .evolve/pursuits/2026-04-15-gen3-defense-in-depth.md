# Pursuit: Defense-in-Depth — Close Remaining CRITICALs and HIGH Findings
Generation: 3
Status: building

## System Audit (post-Gen 2 + this session's C-1/C-3/C-4/C-5/C-6/C-7 fixes)

### What exists and works
- On-chain EIP-712 m-of-n signature verification with per-score binding
- Off-chain signature verification now wired into both execute handlers (C-1 fix)
- AI scoring hardened: brace-depth JSON extraction, sanitized prompts, clamped scores (C-6/C-7)
- Vertex/GMX adapters reject oversized amounts and require explicit price bounds (C-3/C-4/C-5)
- PolicyEngine whitelists, intent deduplication, circuit breaker
- 399 Forge tests + 180 runtime + 56 validator + 70 HTTP API = 705 total passing

### What's still open — verified against HEAD

**CRITICAL (2 remaining):**
| # | Finding | File | Status | Evidence |
|---|---------|------|--------|----------|
| C-8 | execute vs releaseCollateral share VALIDATION_TYPEHASH — cross-function replay | TradeValidator.sol | OPEN | Both code paths hash (intentHash, vault, score, deadline) with no discriminator |
| C-9 | registerStrategy permissionless — anyone can register/spoof strategies | StrategyRegistry.sol:88 | OPEN | No auth modifier on registerStrategy |

**HIGH (8 remaining, 5 were false positives on re-review):**
| # | Finding | File | Status | Evidence |
|---|---------|------|--------|----------|
| RUST-H2 | Portfolio `current_price * p.amount` panics on Decimal overflow | portfolio.rs:74 | OPEN | Uses `*` not `checked_mul` |
| RUST-H4 | Fee math `gains * Decimal::new(fee_bps, 4)` panics on overflow | fees.rs:14 | OPEN | Uses `*` not `checked_mul` |
| RUST-H5 | Slashing self-reference via case-sensitive string compare | slashing.rs:189 | OPEN | `addr == &my_address` string compare, not Address-typed |
| RUST-H7 | Polymarket condition_id silent zero fallback | polymarket.rs:130 | OPEN | `unwrap_or(FixedBytes::ZERO)` — silent, not error |
| LIFE-5 | Provision missing dedup → duplicate bot records | provision.rs:102 | OPEN | Fresh UUID per call, no existing-bot check |
| C-2 | Validator returns zero-sig on bad input (mitigated by C-1 verifier) | server.rs:241 | MITIGATED | Returns `"00"×65` sig; off-chain verifier now rejects |
| SOL-H-01 | HWM flash-mint sandwich | FeeDistributor.sol | NEEDS-REVIEW | Agent said fixed; needs manual audit |
| LIFE-9 | Real-trade dedup disk write best-effort | execute.rs:180 | ACCEPTED | Memory is authority; disk is recovery aid |

### Baselines (current HEAD)
- Forge: 399/399 pass
- Rust: 705 pass (56 validator + 180 runtime + 70 HTTP + unknown blueprint-lib)
- CRITICAL: 2 open (C-8, C-9)
- HIGH: 5 open + 1 mitigated + 1 needs-review + 1 accepted
- Total findings: ~8 actionable

## Diagnosis

The remaining findings split into 3 categories:

1. **Protocol-level** (C-8): Requires a coordinated typehash change across Solidity + Rust signer + Rust verifier + all tests. This is the most impactful single fix — without it, a signature produced for `execute()` can be replayed against `releaseCollateral()`.

2. **Rust safety** (RUST-H2/H4/H5/H7): Unchecked arithmetic and type-level bugs. All surgical 1-5 line fixes.

3. **Auth/lifecycle** (C-9, LIFE-5): Missing access controls and dedup. Moderate scope.

## Generation 3 Design

### Thesis
Gen 3 eliminates the last two CRITICALs and all actionable HIGHs through a coordinated protocol upgrade (C-8 actionKind discriminator) and surgical Rust safety fixes.

### Moonshot considered
Full on-chain target+calldata binding in the VALIDATION_TYPEHASH. **Rejected for Gen 3**: C-8's `actionKind` discriminator is the minimum viable fix — it prevents cross-function replay without changing the off-chain validator API. Full target binding is Gen 4.

### Changes (ordered by impact)

#### Wave 1: Rust surgical fixes (no cross-file coordination, commit each)
| # | Finding | Fix | File | Risk |
|---|---------|-----|------|------|
| 1 | RUST-H5 | Parse `addr` to `Address` type before comparing to `my_address` | slashing.rs:189 | Low |
| 2 | RUST-H7 | Return error instead of `FixedBytes::ZERO` on missing/invalid condition_id | polymarket.rs:130 | Low |
| 3 | RUST-H2 | Use `checked_mul` in portfolio recalculate, return `Decimal::ZERO` on overflow | portfolio.rs:74 | Low |
| 4 | RUST-H4 | Use `checked_mul` in fee calculations, return `Decimal::ZERO` on overflow | fees.rs:14,26,41 | Low |

#### Wave 2: C-9 StrategyRegistry auth (Solidity + tests)
| # | Finding | Fix | Files | Risk |
|---|---------|-----|-------|------|
| 5 | C-9 | Add `linkedVault` param; require vault DEFAULT_ADMIN_ROLE for linked strategies | StrategyRegistry.sol, StrategyRegistry.t.sol, contracts.rs, on_chain.rs | Medium |

#### Wave 3: C-8 actionKind discriminator (coordinated protocol change)
| # | Finding | Fix | Files | Risk |
|---|---------|-----|-------|------|
| 6 | C-8 | Add `uint256 actionKind` to VALIDATION_TYPEHASH; pass through all callers | TradeValidator.sol, TradingVault.sol, signer.rs, signature_verify.rs, validator_client.rs, server.rs, all test files | High |

### Risk + Success criteria
- All 705+ tests must pass after each wave
- C-8 is breaking: Rust signer and verifier must produce/verify the same typehash as Solidity
- Cross-test: existing fuzz tests in ValidatorFuzz.t.sol must be updated for new arg count
- Metric: CRITICAL from 2 → 0, HIGH from 5 → 0

## Build Status
| # | Change | Status | Files | Tests |
|---|--------|--------|-------|-------|
| 1 | RUST-H5 slashing Address compare | pending | slashing.rs | |
| 2 | RUST-H7 polymarket condition_id error | pending | polymarket.rs | |
| 3 | RUST-H2 portfolio checked_mul | pending | portfolio.rs | |
| 4 | RUST-H4 fee checked_mul | pending | fees.rs | |
| 5 | C-9 StrategyRegistry auth | pending | 4 files | |
| 6 | C-8 actionKind discriminator | pending | 8+ files | |
