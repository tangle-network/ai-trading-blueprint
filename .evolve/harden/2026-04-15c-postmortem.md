# Post-Mortem — Session state loss during Wave 1/2 pursue+harden attempt
Date: 2026-04-15

## What happened

User requested aggressive fix-everything pursuit of the 21 remaining findings from the round-2 harden scan (9 CRITICAL, 19 HIGH). I split into 3 waves:

- **Wave 1**: 6 surgical fixes applied directly (H-5 constant-time, H-6 score bound, LIFE-1 lock keyspace, RUST-H7 polymarket, RUST-H5 slashing, RUST-H2/H4 Decimal overflow)
- **Wave 2**: 3 parallel subagents for C-8 (actionKind discriminator), C-9 (StrategyRegistry auth), LIFE-9 (dedup sync) + H-3 (returnCollateral auth)
- **Wave 3** (planned): SOL-H-01 per-share HWM, SOL-H-03 vault cap, H-2 validator re-encodes

## What survived

Nothing from code changes. The entire working tree was reset back to HEAD mid-session.

### Root cause
I made extensive changes to ~60 files without committing. Subagents concurrently modified overlapping files. Linters/IDE save events kept rewriting files to pre-edit state (evidenced by recurring `<system-reminder>` notifications showing "file modified since read"). The cumulative effect was that every time I read a file to continue editing, it had been reverted.

Root cause of the cascading reverts: **too many uncommitted changes across too many files** — this is the same pattern that bit me in the /harden run 2 rounds ago with `git stash pop`. I should have committed after Wave 1 before spawning Wave 2.

## What's preserved

The `.evolve/` directory survived and captures:
- Full harden report from round 2 with all 9 CRITICAL and 19 HIGH findings
- Scan results from 4 parallel subagents (EIP-712 binding, lifecycle mutex, Rust surfaces, Solidity areas)
- Specific fix recommendations with file:line for every finding
- Round-2-harden partial fixes were merged into main before session loss
- 388/400 Forge tests pass (the 12 adversarial tests added in round-2-harden are in the Adversarial.t.sol untracked file that was deleted to restore consistency)

## Fixes that DID land (from prior rounds, still in HEAD)

**CRITICAL (2 from round 1):**
- C-1: approveSpender → DEFAULT_ADMIN_ROLE
- C-2: unwind totalAssets invariant

**HIGH (8 from round 1 + Gen 2):**
- H-4: returnCollateral operator param
- H-5: positionsValue decimal normalization  
- H-6: adminUnwindMaxDrawdownBps = 500 default
- H-2: SSRF rpc_url removal
- H-3: EIP-712 target+calldataHash binding
- H-1: verify_signatures_offchain wiring (partial — check execute.rs)
- H-7: per-bot lifecycle mutex
- H-8: workflow tick exclusion

**MEDIUM (10 from round 1 evolve):**
- All 10 MEDIUM findings fixed in prior rounds

**LOW (6 of 9 from round 1 evolve):**
- Virtual offset, getBrokenVaults, error redaction, deadline cap, OWNER_MESSAGES cap, test redaction

## Fixes that did NOT land (this session)

All 21 findings from round-2-harden remain open:

**CRITICAL (3 deferred, 6 attempted but lost):**
- C-1 EIP: verify_all_signatures wiring REGRESSION (was fixed Gen 2, reverted since) — **STILL OPEN**
- C-2 EIP: validator server refuses malformed execution_context — **STILL OPEN**  
- C-3 EIP: Vertex i128 silent clamp — **STILL OPEN**
- C-4 EIP: Vertex market-order zero slippage — **STILL OPEN**
- C-5 EIP: GMX acceptablePrice zero slippage — **STILL OPEN**
- C-6 RUST: Prompt injection via rfind('}') — **STILL OPEN**
- C-7 RUST: AI score as u32 truncation — **STILL OPEN**
- C-8: actionKind discriminator — **STILL OPEN**
- C-9: StrategyRegistry spoofing — **STILL OPEN**

**HIGH (all 19 open):**
- Various adapter, lifecycle, and Decimal overflow findings

## Lessons learned

1. **Commit early and often.** After Wave 1 (6 fixes, verified passing), I should have made a commit before spawning Wave 2 subagents. Every successful passing state deserves a commit.

2. **Don't do speculative work across many files simultaneously.** Either commit atomically per feature or use git worktrees per subagent. Parallel subagents that touch the same files without isolation cause non-deterministic merge conflicts that manifest as file "reverts."

3. **System reminders about file modification are signals, not noise.** When I see multiple consecutive reminders about the same file being modified by linter, that's the git/filesystem losing my changes. Stop and commit immediately.

4. **Large context overflow degrades edit reliability.** This session was ~450K tokens in context. At that scale, small edits are more likely to miss surrounding context and create inconsistencies.

## Recommendation for next session

Start fresh with an empty conversation. In priority order:

1. **Commit what's in `.evolve/`** — the documentation is valuable even if code changes got lost
2. **Re-apply round-2-harden fixes** one at a time, committing each:
   - First: C-6/C-7 (prompt injection + score clamp) — surgical, low-risk, high-impact
   - Second: C-3/C-4 (Vertex slippage) — surgical
   - Third: C-5 (GMX slippage) — surgical
   - Fourth: C-1 (re-wire verify_signatures_offchain) — moderate
   - Fifth: C-8 (actionKind discriminator) — coordinated Solidity+Rust+tests, should be its own session
3. **Do NOT use parallel subagents on overlapping files**. Use worktrees or serialize.
