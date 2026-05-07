# Static-Analysis Triage — ai-trading-blueprints

**Branch:** `drew/q1-roadmap-compressed`
**Date:** 2026-05-07
**Tools:** cargo-audit 0.22.1, cargo-deny 0.19.4, slither-analyzer 0.11.5,
mythril 0.24.8 (with solc 0.8.20 via solc-select).

This doc maps every static-analysis finding to a verdict:

- **FIX**  → code change committed; commit hash + summary
- **SUPP** → false positive or bounded by access-control; suppressed inline
            with `slither-disable-next-line <detector>` (Solidity) or via
            `audit.toml` / `deny.toml` (Rust). Rationale below.
- **DOC**  → low-severity informational; no change, no suppression — kept
            as a tracking note.

Each suppression entry must remain re-verifiable: ID + tool version + line
number where the suppression lives. Re-run quarterly.

---

## 1. cargo-audit — RustSec advisory DB

All currently-flagged advisories are **transitive** through three
dependency chains we cannot upgrade unilaterally:

1. **substrate / blueprint-sdk** — Tangle-network/blueprint upstream owns
   the rustls / ring / libp2p / paste / lru / bincode etc. version graph.
2. **solana-sdk 2.x** — Solana 2.x family pins ed25519-dalek 1.x,
   curve25519-dalek 3.x, atty, fxhash, indicatif, libsecp256k1, derivative.
3. **ethers v2 (via hyperliquid)** — fxhash, ws-stream-wasm.

Direct workspace deps are advisory-clean. Triage cadence: re-evaluate
quarterly (first Monday) or when an upstream fix lands. Owner: trading
runtime maintainers.

| Class       | RustSec ID         | Crate / Version           | Vector                                       | Verdict | Rationale |
|-------------|--------------------|---------------------------|----------------------------------------------|---------|-----------|
| vuln        | RUSTSEC-2024-0344  | curve25519-dalek 3.2.0   | timing in Scalar::sub                        | SUPP    | Transitive via solana-keypair. We don't subtract scalars over secret operands. Upstream fix in 4.1.3 awaits solana-sdk refresh. |
| vuln        | RUSTSEC-2022-0093  | ed25519-dalek 1.0.1      | double-pubkey signing oracle                 | SUPP    | Transitive via solana-keypair (ed25519-dalek-bip32). Operator signing path uses ed25519-dalek 2.x via blueprint-keystore. |
| vuln        | RUSTSEC-2024-0437  | protobuf 2.28.0          | uncontrolled recursion DoS                   | SUPP    | Transitive via prometheus 0.13. We never deserialize untrusted protobuf — only emit metrics. Prometheus 0.14 changed the with_label_values API; bump deferred to next refactor pass. |
| vuln        | RUSTSEC-2025-0009  | ring 0.16.20             | AES panic on overflow check                  | SUPP    | Transitive via rustls 0.21 (substrate / solana). Production binaries ship with overflow checks off. |
| vuln        | RUSTSEC-2026-0098  | rustls-webpki 0.101.7    | name constraints (URI)                       | SUPP    | Transitive via solana-sdk rustls. Client-only TLS, no CA-issuance role. |
| vuln        | RUSTSEC-2026-0099  | rustls-webpki 0.101.7    | wildcard names accepted                      | SUPP    | Same chain as 0098; bump pending solana-sdk rustls 0.23 refresh. |
| vuln        | RUSTSEC-2026-0104  | rustls-webpki 0.101.7    | CRL parser panic                             | SUPP    | Same chain; client TLS does not parse attacker CRLs. |
| vuln        | RUSTSEC-2025-0111  | tokio-tar 0.3.1          | PAX header file smuggling                    | SUPP    | Dev-only via testcontainers (anvil setup). Not in runtime call graph. |
| vuln        | RUSTSEC-2025-0055  | tracing-subscriber 0.2   | ANSI escape via user input                   | SUPP    | Transitive via substrate. Direct deps use tracing-subscriber 0.3.x. |
| vuln        | RUSTSEC-2026-0119  | hickory-proto 0.24.4     | O(n²) name compression CPU exhaustion        | SUPP    | Transitive (substrate libp2p). No DNS server role; client-only resolves. |
| unsound     | RUSTSEC-2021-0145  | atty 0.2.14              | unaligned read on Windows                    | SUPP    | Solana telemetry; Linux-only deployment. |
| unsound     | RUSTSEC-2026-0002  | lru 0.12.5               | IterMut UB                                    | SUPP    | We use `LruCache::get_or_insert` / `iter()`; never `iter_mut()`. |
| unsound     | RUSTSEC-2026-0097  | rand 0.7.3               | unsound when custom logger calls rand::rng()| SUPP    | Direct `rand` usage threads explicit `ChaCha20Rng` / `OsRng`; never the global. |
| unmaintained| RUSTSEC-2021-0141  | dotenv 0.15.0            | unmaintained                                 | SUPP    | Dev-deps + tests fixture loading. |
| unmaintained| RUSTSEC-2024-0375  | atty 0.2.14              | unmaintained                                 | SUPP    | See 0145 above. |
| unmaintained| RUSTSEC-2024-0384  | instant 0.1.13           | unmaintained                                 | SUPP    | wasm-bindgen tree (substrate); not exercised at runtime. |
| unmaintained| RUSTSEC-2024-0388  | derivative 2.2.0         | unmaintained                                 | SUPP    | Solana SPL transitive; awaits upstream replacement. |
| unmaintained| RUSTSEC-2024-0436  | paste 1.0.15             | unmaintained                                 | SUPP    | Pervasive in Solana proc-macros. |
| unmaintained| RUSTSEC-2025-0010  | ring 0.16.20             | unmaintained                                 | SUPP    | Same chain as 2025-0009. |
| unmaintained| RUSTSEC-2025-0057  | fxhash 0.2.1             | unmaintained                                 | SUPP    | ethers-providers v2 + Solana ProgramTest transitive. |
| unmaintained| RUSTSEC-2025-0119  | number_prefix 0.4.0      | unmaintained                                 | SUPP    | indicatif (Solana CLI progress) transitive. |
| unmaintained| RUSTSEC-2025-0134  | rustls-pemfile 1/2       | unmaintained                                 | SUPP    | Reqwest + webpki transitive. |
| unmaintained| RUSTSEC-2025-0141  | bincode 1.3.3            | unmaintained                                 | SUPP    | Solana 2.x family; bincode 2 migration is part of Solana 3.x. |
| unmaintained| RUSTSEC-2025-0161  | libsecp256k1 0.6 / 0.7   | unmaintained                                 | SUPP    | Solana crypto transitive; we sign with ed25519-dalek 2.x. |

**Direct-dep advisory bar:** any future advisory whose dep tree terminates
at a workspace member crate (no `└──` chain through substrate / solana / ethers)
must be **fixed**, not suppressed.

---

## 2. cargo-deny — license + bans + sources

Run state on this branch: **PASS**
(`cargo deny check` → `advisories ok, bans ok, licenses ok, sources ok`).

The pre-existing `deny.toml` at the repo root carries:

- `[advisories]` ignore list (mirrors `.cargo/audit.toml`).
- `[licenses]` permissive allow-list (MIT, Apache-2.0, ISC, BSD-2/3,
  Unicode-3.0, Zlib, MPL-2.0, CC0-1.0, 0BSD, Unlicense, CDLA-Permissive-2.0,
  Apache-2.0 WITH LLVM-exception, MIT-0, OpenSSL).
- `[licenses.clarify]` per-crate clarifications for crates whose
  Cargo.toml omits `license` but ship a permissive LICENSE file
  (eigen-* SDK, ring, workspace-hack, solana-config-program-client).
- `[bans]` `multiple-versions = "warn"` (Solana / Alloy stacks
  legitimately double up); `wildcards = "warn"` with
  `allow-wildcard-paths = true` for in-workspace path deps.
- `[sources]` `allow-git` restricted to tangle-network repos.

Multi-version warnings are tolerated (transitive duplicates from the
Solana / Alloy stacks). Quarterly review.

---

## 3. slither — Solidity static analysis

Detector versions: slither-analyzer 0.11.5, solc 0.8.20.
Filter: `dependencies/|contracts/test/|contracts/script/`.
Excluded informational detectors:
`naming-convention,solc-version,assembly,low-level-calls,pragma,too-many-digits,constable-states,similar-names,external-function,timestamp,cyclomatic-complexity`.

`cyclomatic-complexity` is excluded because it fires on
`TradeValidator.validateWithSignatures` (12) and
`TradeValidator._validateEnvelopeWithEnforcementHash` (18). Both functions
are the envelope-validation hot path: each branch corresponds to a
distinct envelope variant or signature-set permutation that must remain
inlined for gas + auditability. Splitting them into helper methods
inflates calldata + memory usage on the per-trade critical path without
reducing logical complexity. The detector is informational-only; we keep
detector-coverage tight via `fail_pedantic: true` for every other
detector class.

### 3.1 Findings counts (production contracts only)

| Contract                  | High | Medium | Low | Info | Opt | Verdict                                           |
|---------------------------|-----:|-------:|----:|-----:|----:|---------------------------------------------------|
| ChainlinkUsdValuator      | 0    | 2      | 0   | 0    | 0   | DOC — divide-before-multiply in OZ Math (FP)     |
| FeeDistributor            | 1    | 4      | 4   | 2    | 2   | 1 SUPP, rest DOC                                  |
| PolicyEngine              | 0    | 0      | 0   | 0    | 0   | clean                                             |
| StrategyRegistry          | 0    | 0      | 0   | 0    | 0   | clean                                             |
| TradeValidator            | 1    | 12     | 3   | 31   | 2   | 1 FIX, 1 SUPP, rest DOC (OZ Math)                |
| TradingVault              | 12   | 29     | 92  | 4    | 6   | all DOC — by-design vault routing pattern        |
| VaultDeployer             | 12   | 29     | 92  | 4    | 6   | re-export of TradingVault findings (same code)   |
| VaultFactory              | 12   | 30     | 99  | 4    | 6   | re-export — factory inherits vault routing       |
| VaultShare                | 0    | 0      | 4   | 1    | 2   | DOC — calls-loop / costly-loop in deposit batch  |
| VaultShareDeployer        | 0    | 0      | 4   | 1    | 2   | re-export of VaultShare                          |
| WrappedAssetValuator      | 0    | 0      | 0   | 0    | 0   | clean                                             |

### 3.2 FIXes committed

- **TradeValidator `_hashApprovalSigners` packed buffer**
  - Detector: `uninitialized-local`
  - Commit: `80b5264 — harden(static): low — explicit init of _hashApprovalSigners packed buffer`
  - Solidity default-initializes `bytes memory packed;` to empty so behavior
    was always correct, but the explicit `= new bytes(0)` silences the
    detector and documents intent. No gas regression (forge tests pass).

### 3.3 SUPPs (in-source `slither-disable-next-line`)

- **TradeValidator `configureVault` — `unused-return`**
  - Source: `contracts/src/TradeValidator.sol:115`
  - Suppression: `// slither-disable-next-line unused-return`
  - Rationale: `EnumerableSet.remove(old)` returns `bool`, but `old` was
    just retrieved via `at(i-1)`, so membership is guaranteed. Ignoring the
    return is the documented OZ pattern.
  - Commit: `d453b34`

- **FeeDistributor `settleFees` — `arbitrary-send-erc20`**
  - Source: `contracts/src/FeeDistributor.sol:231`
  - Suppression: `// slither-disable-next-line arbitrary-send-erc20`
  - Rationale: `vault` is bounded by (1) `onlyOwner`-gated registration in
    `initializeVaultFees`, (2) `vaultFeeInitialized[vault]` check at
    function entry, (3) explicit ERC-20 approval the vault must grant this
    contract on `feeToken`. Opt-in pull pattern, not arbitrary draining.
  - Commit: `d453b34`

### 3.4 DOC — by-design findings retained without suppression

These slither findings are real patterns we intentionally use; suppressing
them in source would drown the noise but also hide the audit trail. We
keep them surfaced so future changes that genuinely break the invariants
are easier to spot in CI diffs.

- **TradingVault `_executeTrade` / `_executeDebtReduction` /
  `_executeHealthFactor` — `arbitrary-send-eth` + `reentrancy-balance`**
  All four detectors fire on the `target.call{value: params.value}(params.data)`
  pattern that routes vault funds to external DEX routers. The `target` and
  `data` are validator-approved through the envelope L-4 hash, every
  outer entry is gated by `onlyRole(OPERATOR_ROLE)` + `nonReentrant` +
  `whenNotPaused`, and the balance-before/after pattern is the *intended*
  slippage check (`outputGained < params.minOutput → revert`). The
  reentrancy-balance "stale variable" is a slither model limitation:
  `nonReentrant` blocks the only re-entry vector, so the comparison is
  guaranteed fresh-after-call.

- **TradingVault `unwind` / `adminUnwind` / `emergencyWithdraw` —
  `arbitrary-send-eth` + `reentrancy-balance`**
  Each is `nonReentrant` + role-gated (vault owner / `CREATOR_ROLE` /
  `DEFAULT_ADMIN_ROLE`). The drawdown-cap check
  (`totalAfter * 10000 < totalBefore * (10000 - drawdownCap)`) is the
  *purpose* of measuring before-and-after balances.

- **TradingVault / VaultFactory / VaultDeployer — `calls-loop` /
  `costly-loop` / `cache-array-length`**
  Bounded loops over admin-curated `heldTokens` (max 32 tokens enforced in
  `updateHeldTokens`). Costly-loop on `++i` is a pre-0.8.20 nudge; we keep
  the explicit form for readability.

- **TradingVault / VaultFactory — `incorrect-equality`**
  `lastSettled[vault] == 0` is the correct first-settlement sentinel.
  Replacing with `< 1` would not improve safety.

- **OpenZeppelin Math.mulDiv — `incorrect-exp` (HIGH on TradeValidator)**
  This is OZ 5.1.0's audited Newton's-method modular inverse; the `^` is
  bitwise XOR by design (3·denominator XOR 2 lookup table). Acknowledged
  upstream as a slither false positive.

- **TradeValidator `validateWithSignatures` overload — `unused-return`**
  The shorter overload's body is `return this.validateWithSignatures(...)`;
  slither's `this.foo` heuristic spuriously flags the return propagation.

- **VaultShare / VaultShareDeployer — `calls-loop` on batch deposits**
  Bounded by ERC-7575 standard's per-call array cap.

### 3.5 mythril (symbolic execution)

- `myth analyze contracts/src/TradeValidator.sol --solv 0.8.20 -t 3
  --execution-timeout 240` → 1 finding (LOW): SWC-116 `block.timestamp`
  in deadline check — accepted, deadline tolerance is documented.
- `myth analyze contracts/src/TradingVault.sol --max-depth 12` → completed
  to baseline depth, no issues. Full-depth analysis exceeds practical CI
  time bounds for the 2119-line vault contract; we treat slither + forge
  fuzz as the primary gates for vault routing logic.

---

## 4. CI gates

- `.github/workflows/static-analysis.yml`
  - `cargo-deny` job (existing, kept) — fails on any rejected license,
    banned source, multi-version error, or un-ignored RustSec advisory.
  - `cargo-audit` job (added) — runs `cargo audit -D warnings`; reads
    `.cargo/audit.toml` for the ignore list.
  - `slither` job (added) — installs slither + solc 0.8.20 via solc-select,
    runs slither per-contract using `slither.config.json` at workspace root.
    `--fail-pedantic` makes any new HIGH/MEDIUM a CI failure.

- `.cargo/audit.toml` — cargo-audit's auto-loaded ignore list
  (matches `deny.toml`'s `[advisories].ignore`).
- `slither.config.json` — detector tuning + remappings for soldeer layout.

---

## 5. Re-evaluation cadence

- **First Monday of every quarter:** the trading-runtime maintainer
  re-runs all four tools, prunes any ignore entries whose upstream fix has
  landed, and bumps deps where possible.
- **On any new advisory affecting a direct dep:** treat as a release-blocker
  even if mitigation is straightforward — surface in the next PR.
- **On contract changes:** if a slither HIGH/MEDIUM appears that is *not*
  in this triage doc, the contract author must either (a) fix in code,
  (b) add a `slither-disable-next-line` with a rationale + new triage
  entry, or (c) widen the detector exclude in `slither.config.json` only
  with explicit reviewer sign-off.
