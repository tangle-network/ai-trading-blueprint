# Dependency Upgrade & Supply-Chain Policy

This document defines how `ai-trading-blueprints` consumes, pins, and
upgrades third-party Rust crates. It is the operational counterpart to
`/deny.toml` (the cargo-deny gate) and `/scripts/generate-sbom.sh`
(the CycloneDX SBOM tooling).

Owner: trading-runtime maintainers. Review cadence: quarterly, on the
first Monday of each quarter, plus ad-hoc whenever a security-grade
advisory lands.

---

## When to upgrade

| Trigger | SLA | Action |
|---|---|---|
| Security advisory rated Critical/High by RUSTSEC, affects a crate on our **runtime** call graph | 7 days from advisory publication | Open a PR, get review, merge before SLA expires. Document any temporary `[advisories.ignore]` entry in `deny.toml` with a rationale and the SLA exception owner. |
| Security advisory rated Medium/Low, or rated High but affects a build-only / test-only crate | 30 days | Bundle into the next minor-bump batch. |
| Security advisory rated Informational (`unmaintained`, `unsound`, `notice`) | Quarterly review | Either (a) replace the dep, (b) ignore with rationale in `deny.toml`, or (c) raise an issue and ignore-with-tracking-link. |
| Minor or patch version bump with no security urgency | Quarterly | Single batch PR (`chore(deps): quarterly minor refresh`). |
| Major version bump (breaking) | Only when needed for a new feature, or to clear a security advisory that's not patched on the older major | Discrete PR per crate; include migration notes in the commit body. |

A "runtime call graph" means anything reachable from `trading-runtime`
or one of the published bin crates (`trading-blueprint-bin`,
`trading-instance-blueprint-bin`, `trading-tee-instance-blueprint-bin`,
`trading-validator-bin`). Build-time and dev-only deps (e.g.
`tempfile`, `wiremock`, `proptest`) get the lower SLA.

## How to upgrade

1. **Identify the bump set**:
   - For a single crate: `cargo update -p <crate>` or
     `cargo update -p <crate> --precise <version>`.
   - For a quarterly refresh: `cargo update`, then inspect the diff
     in `Cargo.lock`.
2. **Compile the workspace**: `cargo build --workspace --all-targets`.
   Any breaking-change fallout shows up here.
3. **Run the test suite**: `cargo test --workspace`. Treat
   `trading-runtime`'s 567+ unit-test count as a floor; a regression
   to fewer passing tests is a blocker.
4. **Run the gate**: `cargo deny --offline check`. Any new advisory or
   licence rejection must be resolved (preferred) or explicitly
   ignored with a written rationale (last resort).
5. **Regenerate the SBOM**: `./scripts/generate-sbom.sh`. Commit the
   updated `audits/sbom.cdx.json` alongside the lockfile.
6. **For security-driven bumps**, add a CHANGELOG entry under
   `## [Security]` with the RUSTSEC ID and affected versions.

## Pinning strategy

Workspace `Cargo.toml` declarations follow the **caret** convention
by default: `tokio = "1"` accepts any 1.x, `alloy = "1"` any 1.x.
This matches the broader Rust ecosystem and lets `cargo update` pull
patch fixes without manifest churn.

The exception is a small set of **security-critical** crates pinned
to exact versions because a silent minor bump could land a behaviour
change in our auth, signing, or network paths:

| Crate | Reason |
|---|---|
| `alloy` | EVM signer / contract call surface; keep deterministic. |
| `solana-sdk`, `solana-client`, `solana-transaction-status` | Solana RPC + tx-signing path. |
| `axum` | Public HTTP surface; behaviour changes in middleware ordering have caused outages. |
| `jsonwebtoken` | Coinbase JWT signing. We've already had to refactor for the EncodingKey lifetime; future versions may or may not expose a `Zeroize` primitive. |
| `ed25519-dalek`, `curve25519-dalek` | Solana operator key handling. |
| `rust_decimal` | Order-amount arithmetic — a precision change is an audit-grade event. |

When introducing a pin, prefer `= 1.2.3` over `~1.2`. Document the
pin in this file with a one-line rationale.

## Source policy

- **crates.io** is the only registry we trust for third-party deps.
- **Git deps** are allowed only for in-house Tangle repositories,
  enumerated in `deny.toml::sources.allow-git`. Every git dep MUST
  be pinned by `tag = "..."` or `rev = "..."`. A `branch = "main"`
  reference is a CI-failure-grade smell — flag in code review and
  replace with a tag before merge.
- **Local path deps** (workspace-internal `path = "..."`) are fine.
  cargo-deny flags them as wildcards on non-published crates; we
  bypass with `allow-wildcard-paths = true` until every workspace
  member sets `publish = false`.

## Yanked crates

`deny.toml::advisories.yanked = "deny"` blocks any yanked version in
the lockfile. If `cargo-deny` fails on this, the fix is `cargo update
-p <crate>` to pull the next non-yanked release.

## Multiple-versions warnings

`deny.toml::bans.multiple-versions = "warn"` surfaces every duplicate
crate version in the dependency graph. Most duplicates trace to a
transitive pin in the Solana or Alloy stacks (e.g. `borsh 0.10` next
to `borsh 1.x`). Triage during quarterly refresh:

1. Run `cargo tree -d` to enumerate.
2. For each duplicate, decide:
   - **Tolerate** — the older version is in a build-only path, or
     unifying it would require an upstream PR. Add a comment in the
     PR description.
   - **Resolve** — bump the parent crate to a version that uses the
     newer transitive. Add to the bump set.

Do not blanket-ignore multiple-versions warnings; the noise floor
matters because a *new* duplication often indicates an unintended
upgrade.

## Unmaintained crate triage

The `[advisories.ignore]` block in `deny.toml` currently lists 22
RUSTSEC IDs, of which 11 are `unmaintained` and 3 are `unsound`. The
playbook for each:

1. **Trace** the offender to its parent crate via `cargo tree -i`.
2. **Check upstream** for a fork or replacement (e.g. `instant` →
   `web-time`, `atty` → `is-terminal`).
3. If the parent has a tracked migration PR, link it in the ignore
   reason and re-evaluate quarterly.
4. If no upstream migration exists, file an issue on the parent
   crate and link it in the ignore reason.
5. When a fix lands, drop the ignore line and re-run cargo-deny.

## MSRV (Minimum Supported Rust Version)

Pinned to **Rust 1.91** in `rust-toolchain.toml`. CI runs on this
version; local development should match (use `rustup install 1.91`).
MSRV bumps require:

- A team review with a clear motivation (new language feature,
  upstream MSRV bump that we can't side-step).
- A `[chore(rust)] bump MSRV to 1.92` PR that updates
  `rust-toolchain.toml`, `.github/workflows/ci.yml`, and this doc in
  one go.

## SBOM

CycloneDX SBOMs are generated via `scripts/generate-sbom.sh`:

```bash
./scripts/generate-sbom.sh
```

The script installs `cargo-cyclonedx --locked` on first run, then
emits `audits/sbom.cdx.json`. Commit the SBOM as part of every
release PR — it's the single source of truth for the dep graph at
release time.

## CI gate

`.github/workflows/static-analysis.yml` runs `cargo deny check` on
every PR (and on `main` push). A failure blocks merge until either:

- the offending crate is bumped, or
- a deliberate `[advisories.ignore]` / `[licenses.exceptions]` entry
  is added with a rationale, reviewed in code review.

## Out-of-scope

- Vendoring (we do not vendor crate sources; the lockfile + crates.io
  + cargo-deny gate is the supply-chain control).
- Reproducible builds beyond `Cargo.lock` determinism (tracked
  separately under release engineering).
