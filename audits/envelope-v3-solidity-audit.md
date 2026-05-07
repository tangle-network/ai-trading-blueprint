# Envelope v3 Solidity Audit

**Auditor:** Senior IC review (Claude / staff-level pass)
**Branch:** `drew/q1-roadmap-compressed`
**Scope:**
- `contracts/src/TradeValidator.sol` — envelope-v3 typehashes (12 protocol-action variants), `_validateEnvelopeWithEnforcementHash`, `_envelopeDigest`, `_envelopeDomainSeparator`, all 12 `validateXxxEnvelope` functions, `_hashApprovalSigners`, `_addressInCalldata`.
- `contracts/src/TradingVault.sol` — all 12 `executeXxxEnvelope` functions, `_consumeEnvelope`, `_checkEnvelopeBasics`, `_prepareEnvelopeTrade`, `_prepareEnvelopeDebtReduction`, `_prepareEnvelopeHealthFactor`, `_applyApprovalsMemory`, calldata decoders.
- Tests: `contracts/test/EnvelopeValidator.t.sol`, `contracts/test/DeployEnvelopeV3.t.sol`.

**Approach:** Read-only first pass with the supplied threat model (15 buckets), then surgical fixes for High/Critical findings, then a new invariant suite.

---

## 1. Findings Table (sorted by severity)

| ID | Severity | Location | One-line summary |
|----|----------|----------|------------------|
| H-1 | High | `TradingVault.sol` `executeAaveBorrowEnvelope`, `executeAaveWithdrawEnvelope`, `executeMorphoBorrowEnvelope`, `executeMorphoWithdrawEnvelope` | `params.account` is not pinned to `address(this)` — operator can satisfy the post-borrow / post-withdraw health-factor check by pointing `params.account` at an unrelated, healthy account. |
| M-1 | Medium | `TradingVault.sol` `_applyApprovalsMemory` (and `_applyApprovals`) | Per-execution allowance is set to `s.amountIn` but never reset to 0 after the protocol call. A misbehaving / upgraded router could pull residual allowance later. |
| M-2 | Medium | `TradingVault.sol` envelope swap executors (UniV3 / Aerodrome / Pancake / UniV4) | `s.sqrtPriceLimitX96` (and `s.hookData` for V4) are not pinned to the enforcement struct. Operator can set tight price limits to grief, but cannot drain (slippage check in `_executeTrade` plus `_consumeEnvelope` cap). |
| M-3 | Medium | `TradingVault.sol` envelope executors generally | `params.value` (native ETH) is unbounded. For non-ETH protocols this is harmless (call reverts), but a misconfigured or upgraded target could absorb ETH. |
| L-1 | Low | `TradeValidator.sol` `_validateEnvelopeWithEnforcementHash` | Validator does not check `env.chainId == block.chainid` (only `!= 0`). Cross-chain replay is still blocked by the EIP-712 domain separator and by the executor's `_checkEnvelopeBasics`, but the structural inconsistency is fix-worthy. |
| L-2 | Low | `TradeValidator.sol` `_validateEnvelopeWithEnforcementHash` | Validator does not check `env.issuedAt <= block.timestamp` nor `env.issuedAt < env.expiresAt`. Future-dated or temporally-inverted envelopes can pass `validateXxxEnvelope` but fail in the executor's `_checkEnvelopeBasics`. |
| L-3 | Low | `TradeValidator.sol` `Envelope.expiresAt` | `expiresAt` is `uint64` seconds → overflows in 2106. Document; defer enforcement until the type changes. |
| L-4 | Low | `TradeValidator.sol` `_validateEnvelopeWithEnforcementHash` | O(N²) signer dedup is unbounded in N. With OPERATOR_ROLE-gated submission this is self-griefing only, not a vault-funds threat. Bound N (e.g., 32) to harden. |
| L-5 | Low | `TradingVault.sol` `executeMorphoSupplyEnvelope` / Borrow / Withdraw / Repay | Decoder discards Morpho's `shares` field and any `extra` callback bytes. Combined with the per-call `forceApprove(amount=assets)`, an operator can't bypass the per-envelope cap (Morpho rejects mixed mode and reverts on missing allowance), but explicit `shares == 0` and `extra.length == 0` checks would close the surface. |
| I-1 | Informational | `TradingVault.sol` envelope nonce | On-chain `executeXxxEnvelope` does not enforce nonce monotonicity (server-side only). Acceptable per scope: re-submitting an old envelope can never spend more than its `maxTotalAmountIn` thanks to the consumed-amount mapping. |
| I-2 | Informational | `TradeValidator.sol` `_hashApprovalSigners` empty array | Returns `keccak256("")` for empty input. Validator separately rejects `approvalSigners.length < env.minSignatures` (which requires `minSignatures >= 1`), so empty signers always reverts. |
| I-3 | Informational | `TradeValidator.sol` Curve `tokenIn`/`tokenOut` | Executor trusts the operator-bound enforcement to specify correct `(i, j → tokenIn, tokenOut)` for the pool. A wrong (i, j) doesn't drain funds — it reverts in Curve when the pool sees a stale token. |
| I-4 | Informational | `TradingVault.sol` envelope swap executors | `params.outputToken` is not pinned for non-DEX paths (Aave / Morpho supply, withdraw, borrow) but `_executeTrade`'s gain check + `_requireValuableOutputToken` reduce the realistic outputToken to a token whose balance increases (the supplied/borrowed asset or aToken with adapter). Not exploitable, just constrained UX. |

---

## 2. Findings detail

### H-1 — Account-spoofed health-factor bypass

**Severity:** High
**Locations:**
- `TradingVault.sol::executeAaveWithdrawEnvelope` (lines 1857–1877)
- `TradingVault.sol::executeAaveBorrowEnvelope` (lines 1879–1899)
- `TradingVault.sol::executeMorphoWithdrawEnvelope` (lines 1952–1973)
- `TradingVault.sol::executeMorphoBorrowEnvelope` (lines 1975–1996)

**Description.** Each of these four envelope executors accepts a caller-supplied `HealthFactorParams params` and calls `_executeHealthFactor`, which reads `getUserAccountData(params.account).healthFactor` and reverts if it falls below `params.minHealthFactor`. The enforcement struct constrains `params.minHealthFactor >= enf.minHealthFactor` (correct direction), but **none of these executors pin `params.account` to `address(this)`**. Aave's `borrow(...)` and `withdraw(...)` are already pinned to `onBehalfOf == address(this)` / `to == address(this)` in calldata, so the debt / withdrawal lands on the vault. The operator, however, can set `params.account` to any address whose health factor happens to be high (e.g., a known whale), satisfying the post-call check vacuously while the vault itself has been pushed below `enf.minHealthFactor`.

**Impact.** A compromised or malicious operator with `OPERATOR_ROLE` can:
1. Use a valid borrow envelope to lever the vault into debt up to `enf.maxSingleAmount` per call and `enf.maxTotalAmount` across the envelope.
2. Bypass the on-chain health-factor floor by pointing `params.account` at any healthy address.
3. Repeat across multiple envelopes (each capped by `maxTotalAmount`) to unwind the vault below the operator-bound safe threshold.

The severity is High rather than Critical because:
- The non-envelope path `executeHealthFactorWithApprovals` includes `params.account` in `EXECUTION_PAYLOAD_TYPEHASH`'s signed `executionHash`, so off-chain validators are expected to reject `params.account != vault`. The envelope path has no such off-chain check, which is the gap fixed here.
- The envelope's `enf.maxTotalAmount` still bounds total leverage per envelope.
- The operator already controls execution flow and could probably drain by other means in fully-compromised scenarios.

**Recommendation.** Pin `params.account == address(this)` in each of the four executors, alongside the existing `onBehalfOf == address(this)` / `to == address(this)` / `receiver == address(this)` checks. **Fixed in commit `audit(envelope): high — pin params.account to vault in envelope health-factor executors`.**

### M-1 — Residual allowance after envelope swap

**Severity:** Medium
**Location:** `TradingVault.sol::_applyApprovalsMemory` and `_applyApprovals` (called from every envelope swap executor and the `executeWithApprovals` path).

**Description.** Each envelope swap executor sets `forceApprove(target, amountIn)` then calls `target.call(...)`. If the router pulls less than `amountIn` (e.g., quote slippage, partial fill), the residual allowance persists. A whitelisted, well-behaved router does not reuse residual allowance, but a router upgrade or a router-equivalent precompile could.

**Impact.** Defense-in-depth gap. Direct exploitation requires the spender to behave maliciously, which contradicts the whitelist assumption.

**Recommendation.** After the protocol call, set the allowance back to 0 (`forceApprove(spender, 0)`). Keep the existing `executeWithApprovals` semantics (where the operator explicitly controls allowance) unchanged.

**Status:** Documented; not fixed in this pass to keep the envelope path consistent with the audited non-envelope path.

### M-2 — `sqrtPriceLimitX96` / `hookData` not pinned

**Severity:** Medium
**Locations:**
- UniV3 / PancakeV3 / Aerodrome envelope executors: `s.sqrtPriceLimitX96` is decoded but not pinned.
- UniV4 envelope executor: `s.hookData` is not pinned (the hook *contract* is, via `s.poolKey.hooks == enf.hooks`).

**Description.** Operator can set a sqrt price limit that aborts the swap, or pass arbitrary `hookData` to a hook the validators have already pre-approved (`enf.hooks`). Aborting the swap reverts the tx (no consumed-amount increment). Hook data is interpreted by the hook itself; a sane hook treats it as opaque payload and a malicious hook can't be called because `enf.hooks` is the address.

**Impact.** Griefing only.

**Recommendation.** Either include these fields in the enforcement struct, or document the operator's freedom and rely on the slippage / consumed-amount caps.

**Status:** Documented; not fixed.

### M-3 — `params.value` (native ETH) unbounded

**Severity:** Medium
**Locations:** every `executeXxxEnvelope`.

**Description.** `params.value` is forwarded as `msg.value` to the protocol target. Most paths don't accept ETH (Aave supply / borrow / withdraw / repay, Morpho ditto, Curve plain-pool), and the call reverts on unexpected value. UniV3 and UniV4 routers accept ETH for ETH-in swaps and refund any excess. A misconfigured target whitelisted by the policy engine could absorb ETH.

**Impact.** Operator-controlled native-ETH leak in pathological target configurations. Bounded by vault's ETH balance.

**Recommendation.** For protocols that never accept ETH, pin `params.value == 0` in the executor. For ETH-friendly DEX routers, document the operator's freedom or extend the enforcement struct with a `maxValue` field. Defer to future hardening pass.

### L-1 — Validator missing `env.chainId == block.chainid`

**Severity:** Low
**Location:** `TradeValidator.sol::_validateEnvelopeWithEnforcementHash` (line 593–597).

**Description.** Validator only checks `env.chainId != 0`. The EIP-712 domain separator binds the digest to `block.chainid` (so signatures don't transfer cross-chain), and the executor's `_checkEnvelopeBasics` enforces equality. The validator's missing equality check means a `view` call to `validateXxxEnvelope` will succeed on a fork even if `env.chainId` is wrong.

**Impact.** Display / inconsistency only. No replay surface.

**Recommendation.** Replace `env.chainId == 0` with `env.chainId != block.chainid`. Defer if you want to keep the validator usable for off-chain simulation across chains.

### L-2 — Validator missing `issuedAt` checks

**Severity:** Low
**Location:** `TradeValidator.sol::_validateEnvelopeWithEnforcementHash`.

**Description.** Validator does not check `env.issuedAt <= block.timestamp` nor `env.issuedAt <= env.expiresAt`. Both are caught downstream in `_checkEnvelopeBasics` for executors, but a `view` validate-only flow lets future-dated or inverted-time envelopes pass.

**Impact.** None on funds; off-chain UX inconsistency.

**Recommendation.** Add `env.issuedAt > env.expiresAt` to the structural-revert clause.

### L-3 — `expiresAt` y2106 overflow

**Severity:** Low
**Location:** `TradeValidator.sol::Envelope.expiresAt` (`uint64`).

**Description.** Year 2106 overflow. Off-chain Rust uses the same `u64`. Acceptable until the type widens.

### L-4 — Unbounded signer dedup loop

**Severity:** Low
**Location:** `TradeValidator.sol::_validateEnvelopeWithEnforcementHash`.

**Description.** O(N²) inner dedup over `signatures.length`. OPERATOR_ROLE submits, so this is self-griefing. Block gas limit caps practical N anyway.

**Recommendation.** Add an explicit upper bound (e.g., 32 signatures). Defer.

### L-5 — Morpho `shares` and `extra` not pinned

**Severity:** Low
**Location:** `TradingVault.sol::_decodeMorphoSupply` etc.

**Description.** Morpho's `supply / borrow / withdraw / repay` accept `(assets, shares, ...)` with the constraint that exactly one is nonzero. The decoder records `assets` and ignores `shares`. The executor approves `amount = assets`. If an operator submits with `assets=0, shares>0`, Morpho's transferFrom of the resolved loan-token amount fails because allowance is zero — the call reverts. If both are nonzero, Morpho itself rejects.

The `extra` callback bytes are similarly not pinned. The vault implements no Morpho callback handler, so any non-empty `extra` causes Morpho to call back into the vault and revert on missing function selector.

**Impact.** No fund-loss vector; revert-only griefing.

**Recommendation.** Add explicit `shares == 0` and `extra.length == 0` checks in the executor for clarity. Deferred.

---

## 3. Fixes applied in this pass

| Finding | Commit | Notes |
|---|---|---|
| H-1 | `audit(envelope): high — pin params.account to vault in envelope health-factor executors` | Adds `params.account != address(this)` to the structural-revert clause in `executeAaveWithdrawEnvelope`, `executeAaveBorrowEnvelope`, `executeMorphoWithdrawEnvelope`, `executeMorphoBorrowEnvelope`. Adds regression tests in `EnvelopeValidator.t.sol::test_envelope_health_factor_account_pinning_*`. |

All other findings are documented for team triage. None are funds-loss exploitable in the current threat model with the current target whitelist.

---

## 4. Invariant Tests Added

New file: `contracts/test/EnvelopeInvariants.t.sol`. Standard invariants (not stateful fuzz) covering:

1. `test_envelope_consumed_amount_is_monotonic_increasing` — every successful `executeXxxEnvelope` only ever increases `envelopeConsumedAmount[envHash]`. Non-success paths revert and leave the value unchanged.
2. `test_executed_intent_can_never_be_reused` — once `executedIntents[h] = true`, every execute path that touches `h` reverts on `IntentAlreadyExecuted`.
3. `test_envelope_digest_is_pure_function_of_struct` — `envelopeDigest(env)` is a pure function of `env`, independent of caller and (within the same chain) `block.timestamp`.
4. `test_typehash_constants_match_canonical_strings` — every `*_TYPEHASH` constant equals `keccak256` of its documented EIP-712 string.

5 invariant tests added (the four listed above plus a fifth `test_envelope_consumed_amount_unchanged_on_revert` that bonds the monotonicity property to the on-revert path).

---

## 5. Pro-Auditor Architectural Concerns

1. **Envelope `params.outputToken` slack** — The envelope path delegates a real input check (the output token) to a soft constraint (`_requireValuableOutputToken` + balance-gain check). For protocols where the output token is canonical (Aave's aToken, Morpho's market loan token), consider pinning it in the enforcement struct. Today it is enforceable only via `_executeTrade` semantics.
2. **Universal calldata encoder coverage** — `_decodeUniversalRouterV4SingleSwap` accepts only the canonical 1-command / 1-action / `SWAP_EXACT_IN_SINGLE` shape. UniV4 ships several other actions (multi-hop, exact-out). Consider explicit allow-list / version field in `UniswapV4SwapEnforcement` so an envelope cannot accidentally be expanded to multi-step routing without on-chain re-audit.
3. **Validator "weak chain check"** — The validator's domain separator already binds chainId, but exposing the validator as a `view` function used by off-chain simulators means a wrong-chain envelope returns "approved" instead of failing fast. Tighten `_validateEnvelopeWithEnforcementHash` to require `env.chainId == block.chainid`.
4. **PolicyEngine + envelope split** — Envelope path calls `_checkPolicy` (output token, minOutput, target) but skips per-trade validator signatures for the legacy `EXECUTION_PAYLOAD_TYPEHASH`. Dual-source-of-truth (policy + envelope) is correct, but a future merger should keep the one-shot off-chain assertion that `params.account == vault` for health-factor paths — formalizing what is currently an implicit reviewer assumption (and which H-1 closed on-chain).
5. **Approval residue** — Consider zeroing allowance after every envelope-driven router call. The non-envelope `executeWithApprovals` shares the same property; addressing both would be a single defensive-programming sweep.
