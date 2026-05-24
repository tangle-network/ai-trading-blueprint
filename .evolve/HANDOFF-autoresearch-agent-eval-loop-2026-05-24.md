# Handoff: Autoresearch + Real Chat-to-Sandbox Self-Improvement Eval

Date: 2026-05-24  
Branch: `drew/autoresearch-agent-eval-loop`  
Repo: `/Users/drew/webb/ai-trading-blueprint`

## Executive Status

This branch is **not ready to call done**. Current quality rating: **7.5/10**.

The product path is now real enough to be valuable:

- Browser agent provisions a bot through local Arena.
- Product chat reaches the sandbox and persists into sandbox memory.
- Owner code-change requests route to the self-improvement MCP.
- MCP dispatch is async and runs in a detached worker instead of blocking a long `/terminals/commands` request.
- MCP performs real multi-shot coding, real file writes, real `bun` demo/test execution, and failure feedback between rounds.
- Live execution stays blocked.

The remaining gap is **coding-loop convergence reliability**, not basic product routing. The hard Rain paper-trading eval sometimes completes, but the latest full run failed after 4 rounds because the generated tests still had risk/accounting assertion failures.

## Current Git State

Command run:

```sh
git status --short --branch
git log --oneline -10
gh pr list --state open
```

State observed:

- Branch: `drew/autoresearch-agent-eval-loop...origin/main [ahead 1]`
- Open PRs: none shown by `gh pr list --state open`
- Local commit ahead: `ad0778c test(evals): add autoresearch quality loop`
- Uncommitted files:
  - `evals/src/product/autoresearch-loop-runner.ts`
  - `evals/src/product/browser-driver.ts`
  - `evals/src/product/chat-sandbox-runner.ts`
  - `evals/src/product/local-stack-runner.ts`
  - `trading-blueprint-lib/src/jobs/activate.rs`
  - `trading-blueprint-lib/src/operator_chat.rs`
  - `trading-blueprint-lib/src/prompts/mod.rs`
  - `trading-blueprint-lib/src/prompts/packs.rs`
  - `trading-blueprint-lib/src/prompts/tools/self_improvement_mcp_server.ts`

Diff size at handoff:

```text
9 files changed, 889 insertions(+), 116 deletions(-)
```

## User Intent / Product Bar

The user is not asking for a toy eval or a mocked unit test. The desired product is:

1. A user provisions a blueprint instance in Arena.
2. The user chats with the trading agent in the product UI.
3. If the user asks for an unsupported trading capability, the trading agent should:
   - start paper/shadow work,
   - dispatch a code-changing task through its local self-improvement MCP,
   - let a coding agent work in the sandbox snapshot,
   - run deterministic executable checks,
   - continue across failures,
   - surface progress/blockers to the user,
   - only escalate/promote after proof.
4. The eval should simulate that real product experience, not call internal mocks or assert strings only.

User temperature: high urgency, low tolerance for fake success. They specifically called out "no fake eval nonsense", "real chat to sandbox RUN", and "feed the user dopamine" by showing useful generated code/artifacts even if the strategy loses money.

## What Was Built / Changed

### 1. System Prompt Routes Owner Code Requests to MCP

Files:

- `trading-blueprint-lib/src/prompts/mod.rs`
- `trading-blueprint-lib/src/prompts/packs.rs`

Changes:

- Added `SELF_IMPROVEMENT_BLOCK`.
- Injects self-improvement instructions into the trading agent system prompt and OpenCode profile instructions.
- Requires owner code/tool/protocol/strategy requests to use `/home/agent/tools/self-improvement-mcp-server.ts`.
- Requires:
  - `self_improvement.create_task`
  - `max_rounds >= 3`
  - deterministic tests
  - paper/shadow only
  - continue after failures
  - do not report success on partial work

Relevant tests:

- `test_build_system_prompt_requires_mcp_continuation_for_owner_code_requests`
- `test_profile_instructions_have_autonomy`

Assessment:

- Good: puts the behavior at the right control boundary: the trading agent is told not to hand-wave unsupported capability work.
- Needs improvement: prompt is still long and mixes product policy, coding-agent expectations, and safety policy. It should eventually be factored into a short owner-facing policy plus a separate coding-agent prompt template.

### 2. Operator Chat Routes Code-Changing Owner Messages to MCP

File:

- `trading-blueprint-lib/src/operator_chat.rs`

Changes:

- Detects owner messages that ask for code/tool/provider/protocol/strategy changes.
- Routes those to `run_self_improvement_mcp_turn()` instead of generic `/agents/run`.
- Builds a JSON-RPC call to `self_improvement.create_task`.
- Extracts requested verification commands from user text, including Rain commands:
  - `bun --bun tools/rain-paper/run-demo.ts`
  - `bun test tools/rain-paper/rain-paper.test.ts`
- Important latest change: `wait_for_completion` is now `false`. Chat dispatches the MCP task and returns quickly.

Why `wait_for_completion:false` matters:

- Long `/terminals/commands` HTTP calls timed out around 6 minutes.
- The correct shape is: chat dispatches a task, MCP runs in background, product/eval polls task status/artifacts.

Relevant tests:

- `routes_owner_code_change_requests_to_self_improvement_mcp`
- `extracts_requested_rain_verification_commands`
- `extracts_generic_bun_verification_commands_without_fixture_names`

Assessment:

- Good: routing is real and the chat transcript now says the task was dispatched through MCP.
- Bad: user-visible UX is still a "dispatched" response, not a rich progress UI. This is functional but not dopamine-rich.
- Needs investigation: whether `/api/bots/:id/evolution/self-improve/runs` should expose these MCP tasks. Current eval sees 404 for revision/evolution endpoints.

### 3. Sandbox OpenCode Provider Config

File:

- `trading-blueprint-lib/src/jobs/activate.rs`

Changes:

- Writes `/home/agent/.config/opencode/opencode.jsonc`.
- Registers provider `zai-coding-plan`, model `glm-4.7`, with `apiKey` from `{env:ZAI_API_KEY}`.
- Also registers `openrouter` with env-based key/base URL models.
- Initializes `.config` into sandbox git workspace.

Why this mattered:

Earlier live runs failed with:

```text
Model not found: zai-coding-plan/glm-4.7. Did you mean: glm-4.7?
Model not found: glm-4.7/.
Provider not found
```

Manual live container test proved the temp config works:

```sh
OPENCODE_CONFIG=/tmp/opencode-zai.json opencode run -m zai-coding-plan/glm-4.7
```

Assessment:

- Good: provider/model config is no longer implicit.
- Needs cleanup: sidecar harness selection and provider config are still spread across activation env, profile instructions, and MCP default command.

### 4. MCP Self-Improvement Server Hardening

File:

- `trading-blueprint-lib/src/prompts/tools/self_improvement_mcp_server.ts`

Major changes:

- Added task lock + heartbeat:
  - `TASK_LOCK_HEARTBEAT_MS`
  - `TASK_LOCK_STALE_MS`
  - `taskHasLiveOwner`
  - `writeTaskLock`
  - `clearTaskLock`
- Prevents second MCP process from recovering a task while the real owner process is still alive.
- Added detached process group for coding command.
- Timeout now kills process group:
  - `process.kill(-child.pid, 'SIGTERM')`
  - follow-up `SIGKILL`
- `create_task(wait_for_completion:false)` now forks a detached MCP worker:
  - `bun --bun self-improvement-mcp-server.ts run-task <task_id>`
- `status`, `list_tasks`, `patch`, `backtest`, `promote_candidate` recover interrupted state.
- `promoteCandidate` now awaits `patchTask`.

Failure modes fixed:

1. **Duplicate recovery race**
   - Before: eval inspection called `list_tasks`, saw stale `updated_at`, started recovery while original OpenCode was still alive.
   - After: cross-process lock prevents stale recovery while owner is live.

2. **Zombie OpenCode descendants**
   - Before: timeout killed only shell, descendant `opencode` survived.
   - After: process group kill.

3. **Long HTTP terminal calls**
   - Before: chat held a single sidecar request open for the whole multi-round task and timed out.
   - After: chat dispatches, detached worker continues, eval polls.

Assessment:

- Great: this is the right architectural direction. Long-running coding tasks should be background jobs with persisted status.
- Bad: task state is still JSON files with coarse locks; acceptable for greenfield sandbox, but not a production-grade scheduler.
- Needs consolidation: MCP, old `self-improvement-loop.ts`, revision/evolution endpoints, and eval traces are overlapping concepts. Decide which surface is canonical.

### 5. Product Eval Harness Improvements

Files:

- `evals/src/product/browser-driver.ts`
- `evals/src/product/chat-sandbox-runner.ts`
- `evals/src/product/local-stack-runner.ts`
- `evals/src/product/autoresearch-loop-runner.ts`

Changes:

- Browser BAD prompt now correctly handles `/create`:
  - dev auth and provider/API key are preloaded,
  - click `Create Agent` exactly once,
  - wait for provisioning,
  - do not retry/type/script inject.
- Local stack runner has preflight timeouts and process-group cleanup.
- Chat sandbox runner:
  - sends Rain request through real product chat API,
  - waits for transcript,
  - inspects sandbox with Docker,
  - now polls Rain MCP task/artifacts until terminal state instead of inspecting once,
  - extracts evidence from task JSON, patches, demo artifacts, code excerpts, memory, and evolution endpoints.
- Autoresearch runner:
  - supports `chat_scenario`,
  - can ingest failed product traces,
  - stores/judges raw reports.

Assessment:

- Good: eval is close to real user/product path. It is not unit-test fake.
- Bad: assertions are still brittle in places. Example: one completed run failed because the evaluator expected names like `engine.ts`/`strategy.ts` and `finalBalance`, while generated artifacts used `execution-engine.ts`/`market-maker.ts` and `finalPortfolioValue`/`finalPositions`.
- Needs improvement: eval should judge semantic capability with structured artifact parsing, not filename and substring heuristics.

## Exact Eval Evidence

### Latest Full Product Eval: Failed on Completion

Path:

```text
.evolve/evals/local-product-2026-05-24T01-13-34-945Z/chat-sandbox-report.json
```

Passed assertions:

- browser agent exercised create flow
- operator recorded a new bot
- operator recorded provision progress
- chat session created
- chat transcript contains Rain request
- sandbox memory contains Rain request
- sandbox uses requested coding harness
- sandbox harness produced no runtime process errors
- sandbox self-improvement runtime is executable
- agent responded through product chat
- agent used Rain developer evidence
- agent kept Rain integration paper-first
- agent produced a tactical capability artifact or task
- agent specified validation and risk gates
- no live promotion occurred

Failed assertion:

```text
chat: agent completed an executable Rain paper-trading prototype=false
```

Task evidence:

```text
task_id: sit-1779585401748-063116960870c265
status: failed
failure: no_approved_variant
rounds_used: 4
files_changed:
  eval-artifacts/rain/demo-result.json
  tools/rain-paper/market-fixture.ts
  tools/rain-paper/market-maker.ts
  tools/rain-paper/models.ts
  tools/rain-paper/paper-engine.ts
  tools/rain-paper/rain-paper.test.ts
  tools/rain-paper/rain-sdk-adapter.ts
  tools/rain-paper/run-demo.ts
```

Important latest failure:

```text
RainPaperEngine > max drawdown is tracked
Failed to submit bid: warn: Insufficient balance: required 10.01, available 10.00

Expected orders.length toBe 0
Received 1
```

Interpretation:

- The agent generated useful real code and demo artifacts.
- The demo passed.
- The required test file existed by later rounds.
- The coding loop did not converge inside 4 rounds because the generated paper engine/risk tests still disagreed.
- This is a real failure, not a product routing failure.

### Prior Full Product Eval: Completed MCP Task but Evaluator Was Too Brittle

Path:

```text
.evolve/evals/local-product-2026-05-24T00-59-53-073Z/chat-sandbox-report.json
```

MCP task evidence:

```text
task_id: sit-1779584655535-063116960870c265
status: completed
winner_variant_id: sit-1779584655535-063116960870c265-default
patch_sha256: sha256:ec847c7af77529a035972bc0339d768155dc545ae529682e7a5204fa2322ddae
rounds:
  round 1: demo passed, test file missing
  round 2: demo passed, tests passed
files_changed:
  eval-artifacts/rain/demo-result.json
  tools/rain-paper/execution-engine.ts
  tools/rain-paper/fake-market.ts
  tools/rain-paper/market-maker.ts
  tools/rain-paper/package.json
  tools/rain-paper/rain-paper.test.ts
  tools/rain-paper/run-demo.ts
  tools/rain-paper/types.ts
```

Demo artifact excerpt:

```json
{
  "summary": {
    "marketsCount": 7,
    "initialPortfolioValue": 100000,
    "finalPortfolioValue": 114018.46465839064,
    "totalPnl": -106.10043989139922,
    "totalTrades": 0,
    "winRate": 0,
    "sharpeRatio": -17.082645868417334
  },
  "markets": ["ETH-USD", "BTC-USD", "SOL-USD", "ETH-3500-C-202506", "..."],
  "orders": "10 orders, some filled",
  "trades": "2 trades",
  "finalPositions": "short ETH-USD",
  "liveTradingBlocks": [
    "No live trading keys - this is a paper-only simulation",
    "No validator or trading API integration - production requires validator approval",
    "Required: validator/trading API safety gates, key management, replay protection, chain-specific signing"
  ]
}
```

Why the eval still failed:

- The evaluator looked for specific filename substrings and artifact field names that did not match the generated implementation.
- This was partially fixed in `chat-sandbox-runner.ts` by accepting:
  - `execution-engine.ts` / `paper-engine.ts`
  - `market-maker.ts` / `strategy.ts`
  - `finalPortfolioValue` / `finalPositions`

Interpretation:

- This run is strong proof the product path can work end-to-end.
- It is not sufficient to call done because the latest clean rerun failed to converge.

### Earlier Important Failures

Paths:

```text
.evolve/evals/local-product-2026-05-23T23-34-53-916Z
.evolve/evals/local-product-2026-05-23T23-44-01-001Z
.evolve/evals/local-product-2026-05-24T00-11-55-849Z
.evolve/evals/local-product-2026-05-24T00-35-34-518Z
```

Failures observed:

- OpenCode provider/model missing or wrong:
  - `Model not found: zai-coding-plan/glm-4.7. Did you mean: glm-4.7?`
  - `Model not found: glm-4.7/.`
- Browser BAD agent fought the create flow until prompt clarified.
- MCP recovery raced live task and spawned duplicate OpenCode processes.
- Long sidecar `/terminals/commands` request timed out while MCP was still working.
- Docker had stale sidecars from failed evals; some `docker rm -f` initially failed due local daemon state, later sidecars were cleaned.

## Verification Commands Run

Green:

```sh
npm run typecheck:evals
cargo fmt --check
git diff --check
cargo test -p trading-blueprint-lib operator_chat::tests --lib
cargo test -p trading-blueprint-lib operator_chat::tests::routes_owner_code_change_requests_to_self_improvement_mcp --lib
cargo test -p trading-blueprint-lib self_improvement_mcp_server_exposes_multishot_task_tools --lib
cargo test -p trading-blueprint-lib trading_agent_opencode_config_registers_eval_providers_without_secrets --lib
```

Hard eval command used:

```sh
dotenvx run -f ~/company/devops/secrets/.env.keys -f ~/company/devops/secrets/agent-state.env -- bash -lc '
export TANGLE_ROUTER_BASE_URL="https://router.tangle.tools/v1"
export BAD_TANGLE_ROUTER_BASE_URL="$TANGLE_ROUTER_BASE_URL"
export BAD_TANGLE_ROUTER_API_KEY="$TANGLE_API_KEY"
export BAD_TANGLE_ROUTER_MODEL="deepseek-v4-pro"
export BAD_CASE_TIMEOUT_MS=900000
npm run eval:chat-sandbox -- --chat-timeout-ms 1800000
'
```

Latest result: failed only on executable Rain prototype completion.

## UX / Product Fidelity Assessment

Current UX resemblance to desired product: **medium**.

What resembles real UX:

- Browser agent uses the local Arena UI to create a bot.
- Product chat API is used.
- A real manual chat session is created.
- The owner request appears in sandbox memory.
- Assistant responds in product chat.
- The sandbox is provisioned with harness env and prebuilt tools.

What is weak:

- The UI itself does not yet visibly stream the MCP task lifecycle, generated files, failing tests, retry rounds, or demo artifact.
- The assistant response is currently more like "task dispatched" than a rich progress surface.
- Eval inspects artifacts via Docker, not through the product UI.
- The "dopamine" artifact exists in the sandbox (`demo-result.json`, generated code), but the product does not surface it well.
- Revision/evolution endpoints returned 404 in the eval for this flow; they are not unified with MCP task history yet.

Recommendation:

- Treat MCP task history as a first-class product object:
  - show task status in chat,
  - show rounds/shots,
  - show tests run,
  - show generated files,
  - show demo artifact preview,
  - show "blocked, prompt me again with X" if out of rounds.

## What Is Good / Great / Bad

### Great

- Real end-to-end path exists from browser provisioning to chat to sandbox to MCP code generation.
- The system can produce real code and pass executable checks.
- Background MCP worker model is the right direction.
- Safety posture is preserved: paper/shadow only, no live keys, no live promotion, validator/trading API gates preserved.

### Good

- Focused unit tests protect the routing and provider-config behavior.
- Eval has a hard scenario that catches real convergence failures.
- Artifacts are rich enough to diagnose: task JSON, shots, test commands, stderr/stdout, code excerpts, demo JSON.

### Bad

- MCP convergence is not reliable under `4 rounds x 4 min`.
- Eval is still partly heuristic and filename/string dependent.
- Product UI does not surface enough of the self-improvement loop.
- Old and new concepts overlap:
  - `self-improvement-loop.ts`
  - `self-improvement-mcp-server.ts`
  - `/evolution/self-improve`
  - revision arena
  - autoresearch loop
  - agent-eval traces
- Stale historical bot workflows spam local logs with connection-refused errors during evals. This pollutes signal and should be isolated or cleaned in eval setup.

## Immediate Next Actions

### 1. Diagnose MCP Convergence Failures

Skill: `/diagnose`

Input:

```text
.evolve/evals/local-product-2026-05-24T01-13-34-945Z/chat-sandbox-report.json
```

What to inspect:

- `chat_scenario.sandbox.commands.rain_task_evidence.stdout`
- `chat_scenario.sandbox.commands.rain_root_checks.stderr`
- generated failing task:
  - `sit-1779585401748-063116960870c265`

Acceptance:

- Identify why round 4 did not resolve risk/accounting tests.
- Decide whether the prompt needs a narrower "fix only failing tests" mode, a larger budget, or a deterministic repair loop.

### 2. Improve Continuation Prompt and Budget

Skill: `/pursue` or direct focused edit

Likely files:

- `trading-blueprint-lib/src/prompts/tools/self_improvement_mcp_server.ts`
- `trading-blueprint-lib/src/operator_chat.rs`

Specific ideas:

- Add a separate repair prompt after the first failing test:
  - "Do not add new abstractions or tests. Fix only the failing commands below."
  - Include exact command, status, stdout/stderr, and current file list.
- Increase default eval task budget for hard chat scenarios:
  - `max_rounds`: 6 or 8
  - `coding_timeout_ms`: 6-8 minutes for first round, 3-4 minutes for repair rounds
- Consider allowing a repair round that edits only existing files if test file exists.

Acceptance:

- Latest hard eval passes twice in a row, or produces one pass and one clearly model-quality failure with actionable artifacts.

### 3. Replace Brittle Eval Heuristics with Structured Artifact Validation

Skill: `/harden`

File:

- `evals/src/product/chat-sandbox-runner.ts`

Specific changes:

- Parse `rain_task_evidence.stdout` as JSON.
- Parse `demo-result.json` from sandbox artifact.
- Require semantic keys:
  - market list non-empty
  - orders or quotes non-empty
  - positions/trades/risk blocks present
  - live trading disabled
  - both required commands passed in last shot
- Stop overfitting to filenames except for required `tools/rain-paper/rain-paper.test.ts` and `run-demo.ts`.

Acceptance:

- The prior completed run at `.evolve/evals/local-product-2026-05-24T00-59-53-073Z` would pass under the evaluator.
- The latest failed run remains failed because MCP status is `failed` and tests failed.

### 4. Surface MCP Task State in Product UI/API

Skill: `/pursue`

Likely files:

- operator API routes around bot session/evolution
- Arena chat UI components
- MCP task history exposure from sandbox, likely via operator proxy/exec or a stored task mirror

Acceptance:

- A user can see:
  - "working on task"
  - current round
  - generated files
  - last test failure
  - final demo artifact or blocker
- Eval stops relying exclusively on Docker inspection and can assert product-visible evidence.

### 5. Consolidate Self-Improvement Surfaces

Skill: `/critical-audit` then `/deep-clean`

Question to answer:

Which is canonical?

- MCP task store under `/home/agent/.evolve/mcp-self-improvement`
- `self-improvement-loop.ts` and agent-eval/autoresearch packages
- revision arena/evolution API

Recommended direction:

- MCP is the task/job driver.
- agent-eval/autoresearch judges traces/results and improves prompts/specs.
- revision/evolution API displays/promotes approved candidates.
- The product chat is the user command surface.

Acceptance:

- One diagram or short architecture note in code comments/docs may be justified.
- No duplicate "self-improvement status" sources with conflicting states.

## Senior Engineering Warnings

- Do not weaken the hard eval to pass. It is finding a real quality issue.
- Do not turn Rain code into a committed static fixture. The point is emergent chat-to-code generation.
- Do not claim "autonomous profitable strategy generation" from these evals. Current proof is: real product can dispatch and run self-improvement coding tasks, sometimes producing useful paper prototypes.
- Do not expand to live trading before the paper/shadow flow is reliably convergent and visible.
- Do not rely on Docker sidecar state from prior runs; every serious eval should start clean.

## Suggested Takeover Commands

Orient:

```sh
cd /Users/drew/webb/ai-trading-blueprint
git status --short --branch
git log --oneline -10
gh pr list --state open
```

Fast checks:

```sh
npm run typecheck:evals
cargo fmt --check
git diff --check
cargo test -p trading-blueprint-lib operator_chat::tests --lib
cargo test -p trading-blueprint-lib self_improvement_mcp_server_exposes_multishot_task_tools --lib
```

Hard eval:

```sh
dotenvx run -f ~/company/devops/secrets/.env.keys -f ~/company/devops/secrets/agent-state.env -- bash -lc '
export TANGLE_ROUTER_BASE_URL="https://router.tangle.tools/v1"
export BAD_TANGLE_ROUTER_BASE_URL="$TANGLE_ROUTER_BASE_URL"
export BAD_TANGLE_ROUTER_API_KEY="$TANGLE_API_KEY"
export BAD_TANGLE_ROUTER_MODEL="deepseek-v4-pro"
export BAD_CASE_TIMEOUT_MS=900000
npm run eval:chat-sandbox -- --chat-timeout-ms 1800000
'
```

Inspect latest eval:

```sh
latest=$(ls -td .evolve/evals/local-product-* | head -1)
jq '.assertions' "$latest/chat-sandbox-report.json"
jq '.chat_scenario.answers' "$latest/chat-sandbox-report.json"
```

Inspect task evidence from report:

```sh
jq -r '.chat_scenario.sandbox.commands.rain_task_evidence.stdout' "$latest/chat-sandbox-report.json"
jq -r '.chat_scenario.sandbox.commands.rain_root_checks.stderr' "$latest/chat-sandbox-report.json"
```

## Final Take

The work is directionally strong and no longer fake. It proves most of the real product path and found the right next hard problem: **self-improvement job convergence and product-visible task UX**.

The next senior engineer should not restart architecture from scratch. They should:

1. keep MCP as the background job driver,
2. harden convergence,
3. parse artifacts semantically,
4. expose task progress through the product,
5. run the hard eval until it passes reliably without loosening the core proof.
