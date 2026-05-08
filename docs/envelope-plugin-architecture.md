# Envelope Plugin Architecture

Design + scaffold for a pluggable envelope registry that lets new DEXes /
lending protocols ship without touching `TradingVault.sol`,
`TradeValidator.sol`, or the runtime executor's hot path.

Status: **DESIGN + SCAFFOLD ONLY**. Existing 13 inline `executeXxxEnvelope`
functions are unchanged in this commit. Migration plan below.

---

## 1. Goal & Non-goals

### Goal

Make envelope variants pluggable. New protocols register via a stateless
"adapter" contract pattern. Adding a new variant requires:

- Writing one `IEnvelopeAdapter` implementation (one Solidity file).
- Writing one `EnvelopeAdapter` Rust impl.
- Admin call: `EnvelopeRegistry.register(adapter)`.

It MUST NOT require:

- Editing `TradingVault.sol`.
- Editing `TradeValidator.sol`.
- Editing the runtime's `executor.rs` hot path.

### Non-goals

- Not changing the EIP-712 envelope domain or the `Envelope` struct shape.
- Not retiring the legacy 13 inline `executeXxxEnvelope` functions in this
  commit (backward compat: existing operator code keeps working).
- Not introducing upgradability for the vault. The registry is the only
  mutable surface; the vault itself stays immutable.
- Not changing how validator signatures are verified — the validator
  contract remains the source of truth for signature semantics.

---

## 2. Pattern Choice — Registry over Embedded-Adapter

Two options were considered (see task spec). We pick **(b) EnvelopeRegistry**.

### Why registry

| Concern | EnvelopeAdapter (operator-supplied) | **EnvelopeRegistry (admin-curated)** |
|---|---|---|
| Routing trust | Operator passes adapter address — vault must verify it's whitelisted | Vault resolves adapter from `kind` via registry — operator never names an address |
| Rebind footgun | Whitelist is a separate map → easy to forget to remove old | Single registry, single admin role, single source of truth |
| Per-call gas | One STATICCALL to whitelist + one to adapter | One SLOAD (registry lookup) + one STATICCALL — strictly cheaper |
| Off-chain dispatch parity | Runtime must know "which adapter is whitelisted" on each chain | Runtime mirrors registry by `kind` only — chain-agnostic |
| Migration risk | Must migrate the whitelist + the per-variant code | Migrate one mapping; per-variant code stays in adapters |

The registry pattern keeps the trust boundary narrow: only the multisig that
holds `REGISTRY_ADMIN_ROLE` can introduce a new code path, just like today
only an upgrade can add a new `executeXxxEnvelope`.

### Why not pure delegatecall pattern

A `delegatecall` adapter would let the adapter mutate vault storage —
unacceptable. We deliberately use **STATICCALL** (`view`/`pure` adapters) plus
`onlyVault` external calls back into the vault. Adapters cannot read or write
vault storage; they only return a `PreCallReport` describing what the vault
should do.

---

## 3. Plugin Interface

### Solidity — `IEnvelopeAdapter`

See [`contracts/src/IEnvelopeAdapter.sol`](../contracts/src/IEnvelopeAdapter.sol).

Key calls:

- `envelopeKind() → bytes32`: stable variant ID, e.g. `keccak256("UniswapV3Swap")`.
- `enforcementHash(bytes blob) → bytes32`: MUST match the legacy
  `TradeValidator._hashXxx(struct)`. This is the **hash-stability anchor**.
- `preCallCheck(params, blob, env) → PreCallReport`: decode + cross-check.
  Returns the consume amount, caps, exec shape, and approvals.
- `validateSignatures(...) → bool`: thin pass-through to
  `TradeValidator.validateXxxEnvelope` so the validator stays the single
  source of truth for signature semantics.

### Solidity — `EnvelopeRegistry`

See [`contracts/src/EnvelopeRegistry.sol`](../contracts/src/EnvelopeRegistry.sol).

`bytes32 kind => IEnvelopeAdapter`, admin-gated `register` / `replace` /
`deregister`.

### Rust — `EnvelopeAdapter` + `EnvelopeAdapterRegistry`

See
[`trading-runtime/src/envelope_registry/mod.rs`](../trading-runtime/src/envelope_registry/mod.rs).

The Rust trait mirrors the Solidity interface. `EnvelopeKind::from_label("X")
== keccak256("X")` so the runtime kind and the on-chain kind line up exactly.

The reference adapter is
[`contracts/src/adapters/UniswapV3SwapAdapter.sol`](../contracts/src/adapters/UniswapV3SwapAdapter.sol).
It demonstrates the full plugin contract for the existing UniswapV3Swap
variant — including byte-for-byte hash compatibility with
`TradeValidator._hashUniswapV3Swap`.

---

## 4. Migration Plan

### Phased — 13 variants, one PR per phase

The existing 13 inline functions stay in `TradingVault.sol` until each is
mirrored by an adapter AND the parity test passes. The order is selected to
front-load the highest-leverage / lowest-risk variants first.

Phase order:

| # | Variant | Reason for order |
|---|---|---|
| 0 | **UniswapV3Swap** (this commit) | Reference. Most-used path; widest test coverage. |
| 1 | PancakeswapV3Swap | Identical calldata layout to V3. Trivial port. |
| 2 | AerodromeSwap | Same V3-style decode, different selector. Low risk. |
| 3 | UniswapV4Swap | Universal Router decode is the gnarliest; do third when test scaffold is mature. |
| 4 | CurveStableSwap | Index-based decode; small but unique. |
| 5–8 | AaveSupply / AaveWithdraw / AaveBorrow / AaveRepay | Lending family — share the `MorphoMarketParams`-free shape. Withdraw + borrow flow into HealthFactor; Supply into Trade; Repay into DebtReduction. |
| 9–12 | MorphoSupply / MorphoWithdraw / MorphoBorrow / MorphoRepay | Same shape distribution as Aave; harder calldata (MarketParams tuple). Last to migrate. |

### Per-phase gates

For each variant N, the migration PR MUST:

1. Add `<Variant>Adapter.sol` under `contracts/src/adapters/`.
2. Extend the registry parity test to cover the new variant —
   `enforcementHash(adapter) == hashXxx(legacy)` for a fixed enforcement
   struct.
3. Add a Rust adapter under
   `trading-runtime/src/envelope_registry/adapters/` and extend the
   cross-domain proptest in `envelope::abi_bridge::tests`.
4. Add a `executeEnvelopeWithKind` end-to-end test (live on-chain trade
   against `MockTarget`) demonstrating the new path produces the same
   side-effects as the legacy inline path.
5. **Do not delete the inline function yet**. Both paths coexist until
   Phase 13.

### Final retirement (Phase 13+)

Once all 13 variants have adapters + parity tests + end-to-end tests
green for at least one full release cycle:

1. Mark the inline `executeXxxEnvelope` functions deprecated (NatSpec only,
   no behavior change).
2. Update the runtime to dispatch via `executeEnvelopeWithKind` exclusively.
3. After one more release with zero traffic on the inline path, delete the
   13 inline functions and associated decoders. The vault shrinks by ~600
   lines.

The vault gains exactly one new entry-point during this whole migration:

```solidity
function executeEnvelopeWithKind(
    bytes32 envelopeKind,
    bytes calldata params,         // ABI-encoded ExecuteParams / Debt / HealthFactor
    bytes calldata enforcementBlob, // ABI-encoded enforcement struct
    TradeValidator.Envelope calldata env,
    address[] calldata approvalSigners,
    bytes[] calldata signatures,
    uint256[] calldata scores
) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused;
```

Per-call sequence:

1. `IEnvelopeAdapter adapter = registry.getAdapter(envelopeKind);`
2. `_checkEnvelopeBasics(env);` (vault-side, unchanged)
3. `report = adapter.preCallCheck(params, enforcementBlob, env);` — STATICCALL
4. `require(env.enforcementHash == report.enforcementHash);` — hash-stability gate
5. `adapter.validateSignatures(tradeValidator, env, enforcementBlob, ...)` — STATICCALL
6. `_consumeEnvelope(hashEnvelope(env), report.consumeAmount, ...)`
7. `_prepareEnvelope*` per `report.shape`
8. apply / reset approvals from `report.approvals`
9. `_executeTrade` / `_executeHealthFactor` / `_executeDebtReduction`

---

## 5. Security Review

### Trust boundary

- **Adapter trusted to be honest about enforcementHash and the protocol's
  decode shape**, but bounded:
  - A wrong `enforcementHash` causes
    `TradeValidator.validateXxxEnvelope` to revert with
    `EnvelopeEnforcementMismatch`. Validators' off-chain signatures are NOT
    bypassed; the worst case is denial-of-service for that variant.
  - A wrong `consumeAmount` could let an operator push more volume than the
    envelope licensed. Mitigation: the caps `(maxSingleAmount, maxTotalAmount)`
    are derived FROM the enforcement blob inside the adapter — the same
    blob whose hash matches `env.enforcementHash`. So an adversarial adapter
    would have to forge a different enforcement hash, which the gate above
    rejects. **Net: caps stay enforced.**
- **Adapter address selection cannot be operator-influenced.** The vault
  resolves `adapter = registry.getAdapter(kind)` where `kind` is bound to
  `env.protocolHash` via the runtime's adapter registration scheme. Adding a
  new kind requires a multisig tx.
- **Adapters are STATICCALL / `view` / `pure`-only.** They cannot mutate vault
  storage or send value. A bug in `preCallCheck` cannot drain the vault — it
  can only revert the call or return a wrong `consumeAmount` (bounded above).

### New attack surface

| Surface | Mitigation |
|---|---|
| Malicious admin registers a backdoor adapter | Same trust as upgrading the vault today (multisig/timelock). The registry admin role MUST be the same multisig that already holds vault `DEFAULT_ADMIN_ROLE`. |
| Adapter hash drift breaks already-signed envelopes | Hash-stability test in `EnvelopeRegistry.t.sol` is required CI. Per-variant enforcement of `assertEq(adapter.enforcementHash(blob), tradeValidator.hashXxx(struct))`. |
| Wrong `kind ↔ enforcement struct` binding (off-chain runtime sends `kind=Aave` with a UniV3 enforcement blob) | The `env.enforcementHash` gate (step 4 above) catches this on every call: a UniV3 blob hashed under an Aave adapter produces a different hash than the validator-signed one → revert. |
| Reentrant adapter (calls back into the vault) | Adapter calls are `STATICCALL`. Even if the adapter is malicious it cannot mutate state. The vault's `nonReentrant` guard remains around the whole entry-point. |
| `kind` collision across adapters | Registry `register()` reverts on duplicate `envelopeKind()`. Adapters are stateless contracts; deploying one with a colliding kind requires the admin role anyway. |

### What did NOT change

- EIP-712 domain & types for the envelope wrapper.
- The validator's signature recovery / score / dedup logic.
- The vault's `nonReentrant` + `OPERATOR_ROLE` + `whenNotPaused` gates.
- `_executeTrade` / `_executeDebtReduction` / `_executeHealthFactor` bodies
  including the post-call invariants (output gain, health-factor floor, debt
  decrease).

---

## 6. Gas Analysis

Per-call delta (registry path vs. inline):

| Item | Inline | Registry | Delta |
|---|---|---|---|
| Adapter resolution | n/a | 1 SLOAD | +~2,100 (cold) / +~100 (warm) |
| Adapter `preCallCheck` | inline | 1 STATICCALL + decode | +~700 base + decode |
| `validateSignatures` | direct EXTCALL to validator | STATICCALL → adapter → EXTCALL to validator | +~700 |
| Approval/exec helpers | unchanged | unchanged | 0 |
| Net | — | — | **+~1,500 to ~3,500** |

Per-call overhead is bounded at ~3.5k gas (cold) and ~1.5k gas (warm
registry slot, which is the steady-state once every adapter slot has been
read once in the lifetime of the vault). At Base / Arbitrum gas prices that
is ~$0.0001 per call — well within the slippage / MEV envelope of even
small swaps. Acceptable.

For variants that are extremely gas-sensitive (we don't have any today; the
cheapest swap is ~120k+ gas), the inline path remains as a fallback during
migration so we have an out.

---

## 7. Hash-Stability Invariant

> The on-chain enforcement hash for a given (variant, fields) MUST be
> byte-identical between the legacy inline path and the adapter path.
> Otherwise pre-migration validator signatures cease to verify.

Test enforcing this for UniswapV3Swap:
[`contracts/test/EnvelopeRegistry.t.sol::test_uniswapV3SwapAdapterHashMatchesLegacy`](../contracts/test/EnvelopeRegistry.t.sol).

The test:

1. Builds a `UniswapV3SwapEnforcement` with realistic mainnet-like values.
2. Computes `legacyHash = tradeValidator.hashUniswapV3Swap(enf)` (the path
   already used by validators to sign envelopes).
3. ABI-encodes the same struct and computes
   `adapterHash = adapter.enforcementHash(blob)`.
4. Asserts `legacyHash == adapterHash`.

Each new adapter MUST add the same parity assertion before merging. CI will
not pass otherwise.

---

## 8. Backward Compatibility

- The 13 inline `executeXxxEnvelope` functions stay unchanged in this commit.
- The runtime executor's `encode_swap_or_supply` / `encode_health_factor` /
  `encode_debt_reduction` paths stay unchanged.
- No existing operator signature, no existing on-chain envelope, no existing
  off-chain tooling needs to change to deploy this commit.
- The new entry-point (`executeEnvelopeWithKind`) lands in a future commit,
  alongside the first runtime adapter that calls it.

---

## 9. Files Added

| Path | Purpose |
|---|---|
| `contracts/src/IEnvelopeAdapter.sol` | Plugin interface (kind, enforcementHash, preCallCheck, validateSignatures). |
| `contracts/src/EnvelopeRegistry.sol` | `bytes32 kind => adapter` admin-curated registry. |
| `contracts/src/adapters/UniswapV3SwapAdapter.sol` | Reference adapter; proves the migration path is hash-stable. |
| `contracts/test/EnvelopeRegistry.t.sol` | Foundry parity test (legacy hash == adapter hash) + registry CRUD. |
| `trading-runtime/src/envelope_registry/mod.rs` | Rust off-chain mirror: `EnvelopeKind`, `EnvelopeAdapter` trait, `EnvelopeAdapterRegistry`. Stub today. |
| `docs/envelope-plugin-architecture.md` | This document. |

No existing files were modified other than `trading-runtime/src/lib.rs` (one
`pub mod envelope_registry;` line).

---

## 10. Open Questions / Risks

1. **Where does the runtime get the `EnvelopeKind` for an envelope today?**
   Currently the kind is implicit in the Rust enum tag
   (`EnvelopeEnforcement::UniswapV3Swap`). For the migration we'll add a
   `EnvelopeEnforcement::kind(&self) -> EnvelopeKind` method that maps the
   variant tag to the on-chain `keccak256("UniswapV3Swap")`. Trivial; called
   out for completeness.
2. **Is the adapter call gas overhead acceptable for the smallest swap
   sizes we expect on Base?** Section 6 says yes (~$0.0001), but we should
   measure against a real Base swap in CI before merging the first
   end-to-end migration PR.
3. **Should `executeEnvelopeWithKind` accept a single packed `bytes` for
   `(params, enforcementBlob)` instead of two separate calldata args?** The
   two-args version is slightly cheaper and easier to debug; the packed
   version is one fewer encode step off-chain. Bias toward two args; revisit
   once the first migration PR has a measurement.
