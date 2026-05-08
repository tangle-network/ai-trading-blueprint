# Red-Team Suite Results — v3 Envelope Contracts

Branch: `drew/q1-roadmap-compressed`
Suite: `contracts/test/red-team/` (forge: `--match-contract "RedTeamSuite|Attack_"`)
Total attacks attempted: **20** (29 individual test cases)
PASS: **20 / 20** (every attack reverted as expected)
FAIL: **0**
Bugs found: **0**

A "PASS" here means the attack was demonstrably blocked by the contracts —
either via an explicit `revert` with the expected selector, or (for the score-
saturation case) a Solidity 0.8 arithmetic panic that revoked the entire tx.

## Attack matrix

| ID  | Vector                                  | Result | Revert / outcome                                              |
| --- | --------------------------------------- | ------ | ------------------------------------------------------------- |
| A1  | Reentrant Uniswap V3 router             | PASS   | `nonReentrant` → inner revert → outer `ExecutionFailed`        |
| A2  | Reentrant Curve pool                    | PASS   | `nonReentrant` → inner revert → outer `ExecutionFailed`        |
| A3  | Cross-protocol envelope confusion       | PASS   | `EnvelopeEnforcementMismatch` (V3 sig replayed onto Pancake)   |
| A4a | >MAX_APPROVAL_SIGNERS approval signers   | PASS   | `TooManyApprovalSigners(17, 16)`                              |
| A4b | Unsorted (descending) approval signers   | PASS   | `InvalidEnvelope`                                              |
| A5  | Wrong recipient in calldata              | PASS   | `EnvelopeCheckFailed`                                          |
| A6  | Wrong fee tier in calldata               | PASS   | `EnvelopeCheckFailed`                                          |
| A7  | `amountOutMinimum = 0` bypass            | PASS   | `EnvelopeRateTooLow(0, reqMinOut)`                             |
| A8  | sqrtPriceLimit corruption (post-M-2)     | PASS   | `EnvelopeCheckFailed`                                          |
| A9  | `params.value` drain (post-M-3)          | PASS   | `EnvelopeCheckFailed`                                          |
| A10 | Approval residue (post-M-1)              | PASS   | post-call `allowance == 0`; rogue `transferFrom` fails         |
| A11 | Envelope replay across vaults            | PASS   | `EnvelopeWrongVault`                                           |
| A12 | Envelope replay across chains (L-1)      | PASS   | `EnvelopeWrongChain` (executor) / `InvalidEnvelope` (validator)|
| A13 | Future-dated `issuedAt` (L-2)            | PASS   | `EnvelopeNotYetActive` (executor) / `InvalidEnvelope` (validator)|
| A14 | `score = type(uint256).max` saturation   | PASS   | Arithmetic panic on second add (Panic 0x11) — tx reverts      |
| A15 | Drained envelope replay                  | PASS   | `EnvelopeTotalExceeded(1, 0)`                                  |
| A16 | Decoy approval signers (off-set)         | PASS   | validator returns `(approved=false, validCount=0)`            |
| A17 | Forged digest (mutated sig)              | PASS   | recovers non-trusted signer (or ECDSA malleability revert)    |
| A18 | V4 unlock-callback reentrancy            | PASS   | `nonReentrant` → inner revert → outer `ExecutionFailed`        |
| A19 | UR command-buffer manipulation           | PASS   | `EnvelopeCheckFailed` (non-V4_SWAP & multi-command)            |
| A20 | Out-of-order V4 actions                  | PASS   | `EnvelopeCheckFailed` (multi-action & wrong-action)            |

## Per-attack notes

### A1 / A2 / A18 — reentrancy
`TradingVault` extends `ReentrancyGuard` and every `executeXxxEnvelope` is
`nonReentrant`. The malicious target re-enters via the SAME envelope; the
inner call hits the guard and reverts. The outer executor's
`(bool success,) = params.target.call{...}` sees `success=false` and reverts
`ExecutionFailed` (the inner revert payload is intentionally swallowed by
`call` and the outer collapses to the generic error). Critical post-call
checks confirmed:

  - `envelopeConsumedAmount[envHash]` is unchanged.
  - `executedIntents[intentHash]` is unset.

(Note: these tests intentionally do NOT assert `attemptedReentry` flags on the
malicious contracts — those storage writes happen inside the reverted top-
level tx and roll back, which is itself the property we want.)

### A3 — cross-protocol confusion
The Solidity type system already prevents passing a `UniswapV3SwapEnforcement`
to `executePancakeswapV3SwapEnvelope` at compile time. The runtime probe shows
the per-protocol typehash is part of every enforcement hash, so even with
byte-identical fields the V3-signed envelope's `enforcementHash` won't match
the Pancake-recomputed hash → `EnvelopeEnforcementMismatch` from
`_validateEnvelopeWithEnforcementHash`.

### A4 — signer-set spoofing
- L-4 cap: 17 sigs or 17 approval-signers → `TooManyApprovalSigners(17, 16)`.
  Cap fires before any signature recovery so it's strictly cheaper to reject.
- Strict-ascending invariant in `_hashApprovalSigners` causes descending order
  to revert `InvalidEnvelope`. Same outcome for any non-strict ordering.

### A5–A6 — calldata-vs-enforcement mismatch
The executor decodes the V3 calldata, then checks every field against the
signed enforcement. Wrong recipient or wrong fee tier → `EnvelopeCheckFailed`
in the per-protocol pin block.

### A7 — min-output bypass
`requiredMinOutput = ceil(amountIn * minOutputPerInput / 1e18)` is computed
inside the executor regardless of what `amountOutMinimum` the operator wrote
into the calldata. Setting `amountOutMinimum = 0` triggers
`EnvelopeRateTooLow(0, reqMinOut)`.

### A8 — sqrtPriceLimit pin (M-2)
Post-M-2, `s.sqrtPriceLimitX96 != enf.sqrtPriceLimitX96` reverts
`EnvelopeCheckFailed`. Probed with `type(uint160).max - 1` against pin = 0;
also asserted defense-in-depth at the enforcement-hash level (the field is
inside the signed enforcement struct).

### A9 — params.value pin (M-3)
`params.value > enf.maxValue` → `EnvelopeCheckFailed`. Native ETH balance
unchanged after revert.

### A10 — approval residue (M-1)
After a successful envelope swap the vault's `allowance(vault, router)` is
asserted to be `0` (proving `_resetApprovalsMemory` ran). A follow-up
`transferFrom(vault, router, X)` with no fresh approval fails — confirms the
residue can't be drained even by a rogue contract redeployed at the same
address (CREATE2 redeploy is functionally equivalent because the allowance
storage slot belongs to the TOKEN, not the router, and is keyed by the
router's address — which is now `0`).

### A11 — vault replay
Envelope minted for vault A, dispatched to vault B → vault B's
`_checkEnvelopeBasics` rejects on `env.vault != address(this)` →
`EnvelopeWrongVault`.

### A12 — chain replay (L-1)
- Executor: `_checkEnvelopeBasics` → `EnvelopeWrongChain`.
- Validator (view-only path): L-1 fix added explicit
  `if (env.chainId != block.chainid) revert InvalidEnvelope` so off-chain
  simulators don't silently approve.

### A13 — future issuedAt (L-2)
- Executor: `_checkEnvelopeBasics` → `EnvelopeNotYetActive`.
- Validator (view-only path): L-2 fix added
  `if (env.issuedAt > block.timestamp) revert InvalidEnvelope`.

### A14 — score saturation
Solidity 0.8.20 checked arithmetic: a second sig with `score = type(uint256).max`
overflows `scoreSum += scores[i]` and panics (selector `0x4e487b71`, code
`0x11`). The whole tx reverts — there's no silent approval. A SINGLE max-score
sig leaves `scoreSum = max`, but `validCount = 1 < required = 2` so the call
returns `(false, 1)` without ever computing `avgScore`. Both branches are safe.

### A15 — drained envelope replay
After a successful trade that consumes the full `maxTotalAmountIn`, a
follow-up trade with even 1 wei of input on the same envelope reverts
`EnvelopeTotalExceeded(1, 0)`.

### A16 — decoy approval signers
Decoys pass the signersHash gate (their addresses ARE the set), but
`config.signers.contains(signer)` filters them out at validation time. Result:
`(approved=false, validCount=0)`. No silent approval.

### A17 — forged digest
- Mutated `r`: depending on the random outcome, ECDSA recovers either a
  random non-trusted address (validCount drops by 1) or triggers
  `ECDSAInvalidSignature`. The test accepts both outcomes — the property is
  "no silent approval", not "specific revert selector".
- Mutated `s`: same property; high-S triggers OZ's malleability check.

### A18 — V4 unlock reentrancy
Same property as A1/A2 but through a malicious "Universal Router" wired to
re-enter `executeUniswapV4SwapEnvelope` during its own `execute(...)` call.
Outer reverts `ExecutionFailed`; envelope and intent state unchanged.

### A19 — UR command-buffer manipulation
`_decodeUniversalRouterV4SingleSwap` enforces:
  - `commands.length == 1`
  - `commands[0] == UR_COMMAND_V4_SWAP (0x10)`

Probed with `commands = [0x00]` (V3_SWAP_EXACT_IN) and
`commands = [0x10, 0x00]` (V4_SWAP + something). Both → `EnvelopeCheckFailed`.

### A20 — out-of-order V4 actions
Same decoder enforces:
  - `actions.length == 1`
  - `actions[0] == V4_ACTION_SWAP_EXACT_IN_SINGLE (0x06)`

Probed with `actions = [0x06, 0x0c]` (SWAP + SETTLE_ALL) and
`actions = [0x0c]` (SETTLE_ALL alone). Both → `EnvelopeCheckFailed`.

## Coverage gaps

Things this Solidity-only harness can't fully exercise:

1. **End-to-end protocol forks.** A1/A2/A18 exercise the reentrancy-guard
   property using mock targets. The "real router behaves correctly under
   reentrancy" assumption isn't needed because `nonReentrant` is universal,
   but a true integration test against an Uniswap V4 PoolManager + hook
   contract would catch issues the calldata-shape decoder can't see.
2. **Cross-tx replay across blocks/forks.** L-1 / L-2 are exercised in-tx;
   the harness doesn't simulate a chain hard-fork that retroactively re-runs
   txs. (Not really a contract-side concern — domain-separator binding is
   already in EIP-712.)
3. **Off-chain signer compromise.** The signer set is trusted; if an attacker
   compromises k of n keys (k ≥ threshold) every signature check passes by
   construction. Out of scope for envelope-contract red-teaming.
4. **Universal Router gas-griefing.** The decoder rejects multi-command and
   multi-action buffers, but a single SWAP_EXACT_IN_SINGLE action with
   pathologically large `bytes hookData` could grief gas. The hookDataHash
   pin (M-2) bounds this against signed enforcement, so the operator can't
   inflate it past what validators already approved — but a hostile validator
   set could.
5. **Solidity-only red-teaming of EIP-712 boundary bugs.** The off-chain Rust
   `SignedEnvelope` has its own integration tests; a real auditor would
   diff-test the digest function across both implementations against random
   inputs. We only cover the on-chain side here.

## Patterns a real auditor would express better

1. **Differential fuzzing across (Rust digest, Solidity digest, off-chain
   simulator) tuple.** Catches subtle ABI-encoding mismatches (e.g. int128
   sign-extension, Pack vs encode boundary) better than any property test.
2. **Echidna / Medusa stateful invariant fuzzing** — would explore the state
   space of consumed-amount monotonicity, intent dedup, and approval reset
   across long sequences of operations rather than the narrow scenarios here.
3. **Symbolic execution of `_decodeUniversalRouterV4SingleSwap`** to prove
   that no calldata shape can emerge from `abi.decode` with `actions.length
   == 1 && actions[0] == 0x06` while encoding multi-action behavior. We test
   the obvious cases; halmos / hevm would prove the exhaustive case.
4. **Storage-collision tests** — multiple inheritance + immutables; we don't
   currently fuzz contract upgrade paths because the contracts aren't
   upgradeable.
5. **Gas-limit attack vectors** — the L-4 cap kills the obvious O(N²) signer
   loop, but a real auditor would fuzz the integer-clamp boundaries (`N=16`,
   `N=15`) and the `requiredMinOutput` ceil arithmetic for both directions of
   1-wei rounding.
