# Static-Analysis Summary — drew/q1-roadmap-compressed

**Date:** 2026-05-07
**Scope:** Rust workspace + Solidity contracts in `contracts/src`.
**Sister docs:** `audits/static-analysis-triage.md` (per-finding verdicts).

## Tool versions

| Tool             | Version  | Source                                  |
|------------------|----------|-----------------------------------------|
| cargo-audit      | 0.22.1   | `cargo install cargo-audit --locked`    |
| cargo-deny       | 0.19.4   | `cargo install cargo-deny --locked`     |
| slither-analyzer | 0.11.5   | `pipx install slither-analyzer`         |
| mythril          | 0.24.8   | `pipx install mythril`                  |
| solc             | 0.8.20   | `pipx install solc-select && solc-select install 0.8.20` |
| forge            | 1.5.1    | foundry-rs/foundry-toolchain            |

Mythril note: pipx-installed mythril 0.24.8 imports `eth.__init__` which
calls `pkg_resources`, deprecated and removed in setuptools 81+.
Workaround: `pipx inject mythril 'setuptools<81'`.
Mythril also pings `solc-bin.ethereum.org` on every run; set
`SOLC_BINARY=$HOME/.solc-select/artifacts/solc-0.8.20/solc-0.8.20` to
short-circuit and run fully offline.

## Findings by severity

### cargo-audit (RustSec advisory DB)

| Class        | Count | Action                                         |
|--------------|------:|------------------------------------------------|
| Vulnerability| 10    | All transitive (substrate / solana / ethers); ignored via `.cargo/audit.toml` with rationale; tracked in triage doc. |
| Unsound      | 3     | All transitive; ignored with rationale.        |
| Unmaintained | 13    | All transitive; ignored with rationale.        |
| **Direct dep advisories** | **0** | — clean. |

Run state with `.cargo/audit.toml` loaded: **PASS** (`cargo audit -D warnings` → exit 0).

### cargo-deny (licenses + bans + sources + advisories)

| Section    | Result | Notes                                                       |
|------------|--------|-------------------------------------------------------------|
| advisories | PASS   | mirrors audit.toml ignore list.                             |
| licenses   | PASS   | permissive-only allow-list; per-crate clarifications for eigen-* SDK + ring + workspace-hack + solana-config-program-client. |
| bans       | PASS   | multi-version + wildcards downgraded to `warn`; in-workspace path-deps allowed. |
| sources    | PASS   | git-source allow-list pinned to `tangle-network/*`.         |

### slither (Solidity static analysis)

Production contracts (`contracts/src/*.sol`). Test/script/dependencies filtered.

| Severity      | Count |
|---------------|------:|
| High          | 38 (12 each across TradingVault/VaultDeployer/VaultFactory + 1 each in FeeDistributor/TradeValidator + factory delta) |
| Medium        | 106  |
| Low           | 196  |
| Informational | 47   |
| Optimization  | 30   |

**Code fixes (1):**

- `80b5264 — harden(static): low — explicit init of _hashApprovalSigners packed buffer`

**Inline suppressions with rationale (2):**

- `d453b34 — harden(static): suppress slither false-positives with audit-traceable rationale`
  - TradeValidator `unused-return` on `EnumerableSet.remove(old)` — element membership guaranteed by preceding `at()` call.
  - FeeDistributor `arbitrary-send-erc20` on `safeTransferFrom(vault,...)` — bounded by `onlyOwner` registration + per-vault approval.

**By-design findings retained without suppression (DOC):**
- ~36 `arbitrary-send-eth` / `reentrancy-balance` instances across TradingVault routing functions: bounded by `onlyRole(OPERATOR_ROLE)` + `nonReentrant` + `whenNotPaused` + envelope L-4 enforcement-hash binding. Slither's reentrancy-balance "stale variable" is a model limitation (nonReentrant blocks the only re-entry vector).
- `incorrect-equality` on `lastSettled[vault] == 0` first-settlement sentinel.
- `incorrect-exp` HIGH in OpenZeppelin `Math.mulDiv` — confirmed slither false positive on OZ Newton's-method modular inverse.

See `audits/static-analysis-triage.md` for the full table and per-finding rationale.

### mythril (symbolic execution)

| Contract        | Severity | Finding                                | Action |
|-----------------|----------|----------------------------------------|--------|
| TradeValidator  | LOW      | SWC-116 `block.timestamp` in deadline  | Accepted; deadline tolerance documented in TradeValidator.sol commit `a6cc227 — harden(validator): require chainId == block.chainid and issuedAt <= block.timestamp`. |
| TradingVault    | —        | Completed to depth-12 baseline         | No issues. Full-depth symbolic exec exceeds practical CI bounds for the 2119-line vault; slither + forge fuzz are the primary gates. |

## CI gates added / extended

- `.github/workflows/static-analysis.yml`
  - **Existing job kept:** `cargo-deny` via `EmbarkStudios/cargo-deny-action@v2`.
  - **Added job:** `cargo-audit` running `cargo audit -D warnings`.
  - **Added job:** `slither` running per-contract with `slither.config.json` and `--fail-pedantic`.

- `.cargo/audit.toml` — cargo-audit auto-loaded ignore list (33 IDs, all transitive).
- `slither.config.json` — detector tuning, soldeer remappings, dependency filters.

The pre-existing `audit.toml` at the repo root (separate from `.cargo/audit.toml`) is kept as a documentation copy for diffing convenience; only `.cargo/audit.toml` is consumed by the tooling.

## Recommendations for the team

1. **Bump `prometheus` to 0.14 in a follow-up PR** — drops `protobuf 2.x` (RUSTSEC-2024-0437). The 0.13→0.14 API change requires updating `with_label_values(&[&str; N])` call sites to `with_label_values::<&[&str]>(&[...])` or migrating to `&[&String]`. Out of scope here because it touches `routes/prometheus.rs` instrumentation across ~10 metric handles.

2. **Track Solana 3.x cadence** — most ed25519/curve25519/atty/bincode/derivative/libsecp256k1 advisories all stem from Solana 2.x's pinned 1.x crypto stack. Solana 3.x is expected to migrate; lock-step bump removes the bulk of `[advisories].ignore`.

3. **Drop `ethers v2` once `hyperliquid` migrates to alloy** — fxhash + ws-stream-wasm advisories disappear. Worth opening an issue upstream.

4. **Re-run mythril on TradingVault at higher depth in nightly CI**, not PR CI — depth-12 baseline is fast enough for a smoke check, but a 4-hour overnight run at depth-22 occasionally surfaces issues slither misses.

5. **Triage cadence:** quarterly (first Monday). Owner: trading-runtime maintainers. Re-evaluate every entry in `[advisories].ignore` and prune anything that's been fixed upstream.

6. **Direct-dep advisory bar:** any future advisory whose dep tree terminates at a workspace member crate (no `└──` chain through substrate / solana / ethers) must be **fixed**, not suppressed.
