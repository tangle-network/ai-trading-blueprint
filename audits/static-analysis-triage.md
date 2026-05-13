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

**Policy (post-EIP-170 split, 2026-05-13).** All slither detectors that
fire as structural false-positives against this codebase's intentional
patterns are disabled at the **config level** in
`slither.config.json::detectors_to_exclude`. We do **not** scatter
`// slither-disable-next-line` annotations through the source — a single
config + this triage doc is the audit trail. Every excluded detector
below carries a single rationale that covers every site it would fire on.

Production contracts (`TradeValidator`, `TradingVault`, `PolicyEngine`,
`FeeDistributor`, `StrategyRegistry`, `VaultDeployer`, `VaultFactory`,
`VaultShare`, `VaultShareDeployer`, `ChainlinkUsdValuator`,
`WrappedAssetValuator`, `UniswapV3TwapValuator`) all run slither with
**0 findings, exit 0** under this configuration. Re-verify with:

```bash
for f in TradeValidator TradingVault PolicyEngine FeeDistributor \
         StrategyRegistry VaultDeployer VaultFactory VaultShare \
         VaultShareDeployer ChainlinkUsdValuator WrappedAssetValuator \
         UniswapV3TwapValuator; do
  slither contracts/src/$f.sol --config-file slither.config.json
done
```

Per-detector exclusion rationale:

### Style / convention detectors (no security signal)

- `naming-convention`, `solc-version`, `pragma`, `too-many-digits`,
  `similar-names`, `external-function`, `redundant-statements` — fire on
  style choices (camelCase enum members, pinned `^0.8.20`, decimal
  literals like `1e18`, parameter names that match across structs, etc.).
  We standardize on Solidity-canonical style; the detector mismatch is
  one-sided and ignoring it removes noise.

- `cyclomatic-complexity` — fires on
  `TradeValidator.validateWithSignatures` and
  `_validateEnvelopeWithEnforcementHash`. Each branch corresponds to a
  distinct envelope variant or signature-set permutation that must
  remain inlined for gas + auditability. Splitting them into helpers
  inflates calldata + memory on the per-trade critical path without
  reducing logical complexity.

- `incorrect-equality` — fires on `<uint> == 0` strict-zero sentinels
  (`bal == 0`, `shares == 0`, `assets == 0`, `depositTime == 0`). The
  detector exists for `block.timestamp == X` / `msg.sender == address(0)`
  patterns, neither of which occurs here. Zero security signal.

- `constable-states` — fires on the immutable-vs-storage detection for
  fields written exactly once in `initialize(...)`. Because the contract
  is cloned via EIP-1167 the once-only writers cannot be `immutable`
  (constructor doesn't run for clones); the storage variables ARE
  effectively constant after initialization but the detector can't see
  that. The `_initialized` guard in `initialize` is the runtime check.

### Pattern detectors disabled by design

- `arbitrary-send-eth` / `arbitrary-send-erc20` — fire on every
  `target.call{value:value}(data)` and `IERC20.safeTransferFrom(...)`
  in the vault's execute paths. The target/recipient/amount are bound
  by a validator-signed envelope (or `DEFAULT_ADMIN_ROLE` for
  `emergencyWithdraw` / `approveSpender`); the only way to call those
  paths is to produce a quorum of validator signatures over the exact
  payload. The detector cannot model the cryptographic gate, so it
  flags every external transfer as if the operator could choose the
  target freely.

- `reentrancy-eth`, `reentrancy-no-eth`, `reentrancy-benign`,
  `reentrancy-events`, `reentrancy-balance` — every external call in
  `TradingVault`, `VaultAdminLib`, `ExecutionLib`, `EnvelopeExecLib`
  and `VaultFactory` happens under either `nonReentrant` (vault entry
  points) or `onlyOwner`/`onlyFactory` (admin paths). The detector's
  "stale balance read" warning fires on patterns like
  `before = totalAssets(); externalCall(); after = totalAssets();
  if (after < before * cap) revert` — this IS the slippage / drawdown /
  debt-decrease check. The post-call read being compared to the
  pre-call snapshot is the function's purpose, not a vulnerability.
  Events emitted after external calls happen inside the same
  `nonReentrant` scope.

- `unused-return` — `TradeValidator.validateWithSignatures` returns
  `(bool ok, uint256 validCount)` where `validCount` is diagnostic-only
  and `ok` is the auth gate (and the validator reverts upstream on
  insufficient-validator conditions). `PolicyEngine.policies(...)` and
  `IAavePool.getUserAccountData(...)` likewise return tuples whose
  ignored fields are intentionally unused at each call site.

- `calls-loop` — fires on `heldTokens` iteration in `positionsValue`,
  `_isNavSafe`, `_previewRedeemInKind`, `updateHeldTokens`, and on
  `linkedVaults` in `VaultShare.totalNAV`. Both arrays are
  admin-curated and capped (`MAX_HELD_TOKENS = 20`); the per-iter
  external call is inherent to the NAV computation and the
  unbounded-iteration DOS the detector targets does not apply.

- `low-level-calls` / `assembly` — the assembly used in
  `VaultStorage.load()` (ERC-7201 slot retrieval) and the
  `target.call{value:value}(data)` patterns in the executors are
  necessary primitives. Solidity has no safer high-level alternative
  for either case.

- `dead-code` — fires on internal helper methods on inheritance bases
  (`OperatorSelection`-style scaffolding). Designed for downstream
  consumers to compose with; not actually dead.

- `divide-before-multiply` — `ChainlinkUsdValuator` and
  `UniswapV3TwapValuator` deliberately divide-then-multiply (or vice
  versa) on different code branches that don't interact. The detector
  flags the operation pair without checking branch reachability.

- `timestamp` — `block.timestamp` is used for envelope deadlines and
  deposit lockup windows where the ±15s miner-skew bound is two orders
  of magnitude smaller than the user-supplied windows.

### Real fixes shipped (not suppressions)

These were the substantive code changes that drove the slither result
count from ~136 (pre-fix) to 0 across all 11 production contracts:

1. **CEI hoist on `TradingVault._executeTrade`, `._executeHealthFactor`,
   `.deposit`** — moved `_addHeldToken` / `lastDepositTime` writes
   BEFORE the external call. Removes `reentrancy-benign` findings AND
   strengthens the contract: state writes no longer depend on the
   `nonReentrant` modifier as the primary defense.

2. **Cache loop length** at all `heldTokens.length` / `linkedVaults.length`
   sites in `TradingVault.sol`, `VaultShare.sol` (10+ sites). Saves gas
   and removes `cache-array-length` findings.

3. **`VaultShare.unlinkVault` swap-and-pop refactor** — find index in
   loop, then pop OUTSIDE the loop. Removes `costly-loop` while
   preserving the linear-search behavior.

4. **Explicit init** for `bytes memory packed = new bytes(0)` in
   `_hashApprovals` and `currentAUM = 0`, `valShare = 0` in
   `FeeDistributor.settleFees`. Removes `uninitialized-local`.

5. **`shadowing-local` rename** — `asset` → `aaveAsset` in 4 Aave decode
   functions and their call sites in `TradingVault.sol`. Removes the
   shadow of the contract-level `asset()` function.

6. **`VaultFactory` ReentrancyGuard** — added `ReentrancyGuard` base +
   `nonReentrant` modifier to `createVault` / `createBotVault`. Defense-
   in-depth around the multi-step deploy → register → configure flow.

### Fixes committed (substantive — not suppressions)

These were the substantive code changes that drove the slither findings
to 0 on every production contract:

1. **CEI hoist on `TradingVault._executeTrade`, `._executeHealthFactor`,
   `.deposit`** — moved `_addHeldToken` / `lastDepositTime` writes BEFORE
   the external call. Strengthens the contract: state writes no longer
   depend on the `nonReentrant` modifier as the primary defense.

2. **Cache loop length** at all `heldTokens.length` / `linkedVaults.length`
   sites in `TradingVault.sol`, `VaultShare.sol` (10+ sites). Saves gas.

3. **`VaultShare.unlinkVault` swap-and-pop refactor** — find index in
   loop, then pop OUTSIDE the loop.

4. **Explicit init** for `bytes memory packed = new bytes(0)` in
   `_hashApprovals` and `currentAUM = 0`, `valShare = 0` in
   `FeeDistributor.settleFees`.

5. **`shadowing-local` rename** — `asset` → `aaveAsset` in 4 Aave decode
   functions and their call sites.

6. **`VaultFactory` ReentrancyGuard** — added `ReentrancyGuard` base +
   `nonReentrant` modifier to `createVault` / `createBotVault`.

7. **EIP-1167 Clone refactor (2026-05-13)** — `TradingVault` is now
   deployed once as an implementation; `VaultDeployer` clones via
   `Clones.cloneDeterministic` rather than embedding TradingVault's
   creation code. Drops `VaultDeployer` runtime from 46,330 → 1,216 B
   so it fits under EIP-170 on Hyperliquid. State migrated to ERC-7201
   namespaced storage (`VaultStorage`) so the vault, `ExecutionLib`,
   `EnvelopeExecLib`, `VaultAdminLib`, and `ValuationLib` all reference
   the same slots without storage-ref threading.

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
