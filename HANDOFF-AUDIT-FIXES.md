# Handoff: Phase 0 audit fixes (C-1, C-2, H-1, H-6)

**From:** other Claude session (GTM/ops lane)
**To:** you (Rust/contract lane on `feat/meta-harness-trading`)
**Date:** 2026-04-19
**Status:** Contract edits staged, 79 tests green, commit blocked by pre-commit rustfmt on *your* unstaged Rust files.

---

## What I did (don't re-do this)

Landed four Phase 0 audit fixes from `~/company/audits/ai-trading-blueprint-2026-04-19/audit.md`:

- **C-1** — `contracts/src/TradingVault.sol` — `updateHeldTokens` and `removeHeldToken` now `DEFAULT_ADMIN_ROLE` (was `OPERATOR_ROLE`) and require zero-balance on removed tokens. Closes operator-driven NAV manipulation. Added error `HeldTokenNotEmpty(address,uint256)`.
- **C-2** — `contracts/src/TradingVault.sol` — `executeWithApprovals` / `_applyApprovals(approvals, target)` now requires every `approval.spender == params.target`. Closes the rogue-spender drain vector on validator-signed intents. Added error `ApprovalSpenderMismatch(address spender, address target)`.
- **H-1** — `contracts/src/TradingVault.sol` — `adminUnwind` enforces a 5% fallback drawdown cap via new public constant `DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS = 500` when `adminUnwindMaxDrawdownBps` is 0. Non-zero settings still override. Closes compromised-CREATOR_ROLE full-drain vector.
- **H-6** — `contracts/src/blueprints/TradingBlueprint.sol` — `_handleProvisionResult` enforces `pp.signers ⊆ svcCfg.signers` (when `svcCfg.signers` non-empty). Skip+emit `BotVaultSkipped(..., "provision signer not in service-approved set")` on mismatch — matches existing skip-on-error pattern, does not brick `onJobResult`.

**No Rust code touched.** Your WIP under `trading-blueprint-bin/`, `trading-blueprint-lib/`, `trading-http-api/`, `trading-runtime/` is untouched.

## Staged right now

```
M  contracts/src/TradingVault.sol
M  contracts/src/blueprints/TradingBlueprint.sol
M  contracts/test/PositionTracking.t.sol
M  contracts/test/ErrorPaths.t.sol
```

Five new tests live in `PositionTracking.t.sol`:

- `test_updateHeldTokens_onlyAdmin`
- `test_updateHeldTokens_rejectsNonzeroBalance`
- `test_removeHeldToken_onlyAdmin`
- `test_removeHeldToken_rejectsNonzeroBalance`
- `test_adminUnwindMaxDrawdownBps_hasFallbackConstant`

`ErrorPaths.t.sol`: existing `updateHeldTokens` usages prank as `owner` instead of `operator` (3 sites).

Verification: `forge test --match-contract "PositionTracking|ErrorPaths"` → **79/79 pass**. Full `forge build` → clean (only pre-existing `unsafe-typecast` lint warnings).

## What's blocking the commit

Pre-commit hook runs `cargo fmt -- --check` across the whole workspace. Your unstaged Rust files fail rustfmt:

- `trading-blueprint-bin/src/operator_api.rs:763` — chained `.wrapping_mul / .wrapping_add` needs line wrap
- `trading-http-api/src/routes/collateral.rs:67` — `format!()` arg needs line wrap
- `trading-http-api/src/routes/collateral.rs:434` — same
- `trading-runtime/src/url_validation.rs:23` — `.strip_prefix().and_then().unwrap_or` needs line wrap
- `trading-runtime/src/url_validation.rs:42` — `matches!` arm reformatted to one-line

All are trivial whitespace-only fmt diffs. Drew (the human) explicitly told me NOT to touch your unstaged files — hence this handoff.

## What you need to do

**Option A (cleanest):** run `cargo fmt` across the workspace, then amend / add a commit that includes my staged files atomically with your fmt fixes. My staged files are already `git add`-ed — just:

```bash
cargo fmt --all
git add -u trading-blueprint-bin trading-blueprint-lib trading-http-api trading-runtime
git commit   # use the commit message below for my fixes, or split into two commits
```

**Option B:** commit my four staged files separately first (with `--no-verify` if Drew approves — he'll tell you), then you continue your work without my staged changes crowding your diff.

**Option C:** drop my staging (`git reset contracts/`), finish your work + commit, then I re-apply my fixes in a follow-up session. *Not recommended — wastes my completed work and loses the 5 new tests.*

Drew's preference when he last spoke: keep work on top of this branch, don't stash. So Option A.

## Commit message to use for my fixes

```
fix(contracts): resolve C-1/C-2/H-1/H-6 from Phase 0 audit

CRITICAL fixes:

- C-1 (TradingVault.sol): updateHeldTokens and removeHeldToken are now
  DEFAULT_ADMIN_ROLE (were OPERATOR_ROLE). Both also require every removed
  token to have zero balance. Closes the operator-driven NAV manipulation
  vector where an operator could drop a held token right before a deposit
  to inflate share price, or hide value to dilute withdrawers. In
  provisioned vaults the admin is the BSM blueprint contract, so these
  functions are now migration/recovery tools rather than an
  operator-reachable NAV knob. Normal operation populates heldTokens
  automatically via _addHeldToken on every successful trade.

- C-2 (TradingVault.sol): executeWithApprovals now requires every
  approval.spender == params.target. The ApprovalCall[] array was not
  hashed into the signed intentHash, so an operator could pair a
  validator-signed trade intent with arbitrary ERC-20 allowances to drain
  the vault. Binding spender to target (the same address validators see
  in the policy + target-whitelist path) eliminates the rogue-spender
  vector. Protocols needing allowance to a different address should use
  the admin-only approveSpender flow.

HIGH fixes:

- H-1 (TradingVault.sol): adminUnwind now enforces a 5% fallback
  drawdown cap (new DEFAULT_ADMIN_UNWIND_MAX_DRAWDOWN_BPS constant) when
  the configured adminUnwindMaxDrawdownBps is 0. Previously 0 was
  interpreted as "no limit", letting a compromised CREATOR_ROLE key burn
  arbitrary vault value in a single wind-down call. Non-zero
  configurations continue to take precedence.

- H-6 (TradingBlueprint.sol): the per-provision signers[] override is
  now enforced as a subset of service-level svcCfg.signers (when
  non-empty). A malicious consumer could previously submit a provision
  job with signers = [theirAddr] and single-sig requirement, bypassing
  the stricter signer set the service was approved under. Mismatch emits
  BotVaultSkipped (matches existing skip-on-error pattern so onJobResult
  is not bricked for the entire service).

New tests in PositionTracking.t.sol:
- test_updateHeldTokens_onlyAdmin (C-1 role change)
- test_updateHeldTokens_rejectsNonzeroBalance (C-1 balance guard)
- test_removeHeldToken_onlyAdmin (C-1 role change)
- test_removeHeldToken_rejectsNonzeroBalance (C-1 balance guard)
- test_adminUnwindMaxDrawdownBps_hasFallbackConstant (H-1 constant check)

Existing PositionTracking and ErrorPaths tests updated to prank as owner
(admin) instead of operator for heldTokens mutations.

Verification: 79/79 tests pass across PositionTracking + ErrorPaths.

Audit ref: company/audits/ai-trading-blueprint-2026-04-19/audit.md
```

Conventional Commits only. **Do not add `Co-Authored-By` trailers** per repo convention (see commit `383bb61` style).

## Still pending from the audit (not in this handoff)

These four are *also* Phase 0 findings but I did not touch them — they can ship in a later commit. See the audit report for full spec.

- **H-2 + H-4** — `contracts/src/VaultFactory.sol` — add on-chain signer-count floor: `require(signers.length >= 3 && requiredSigs >= ceil(signers.length * 2/3))` on the blueprint-provisioned path (split from dev/test path if needed). Defense-in-depth for the H-2 1-of-n default issue.
- **H-3** — `contracts/src/PolicyEngine.sol` — decide: either enforce `leverageCap` + `maxSlippageBps` on-chain, or mark them UI-advisory-only in NatSpec. Current state is misleading-security.
- **H-5** — `contracts/src/PolicyEngine.sol` + `TradingVault.sol` — move `executedIntents[]=true` and rate-limit write to post-success path; today a failed intent permanently burns its UUID + rate-limit slot.
- **M-3** — `contracts/src/TradeValidator.sol` — timelock on `setRequiredSignatures` OR make monotonic-up OR renounce VaultFactory ownership post-config.

Ops-board tasks exist for each: #94 (H-2+H-4), and the audit report lists the others.

## Questions if you're stuck

Audit report has file:line citations + mitigation text for every finding: `/Users/drew/company/audits/ai-trading-blueprint-2026-04-19/audit.md`.
Launch playbook tracks state: `/Users/drew/company/gtm/playbooks/launch-ai-trading-blueprint.md`.
Skill for the full launch motion: `/Users/drew/company/skills/blueprint-launch/SKILL.md`.

Ping Drew if the subset enforcement in H-6 breaks any of your in-progress provision test fixtures — it's possible the provisions you're setting up in Rust tests use signers outside `svcCfg.signers`, which would now skip+emit instead of creating the vault.
