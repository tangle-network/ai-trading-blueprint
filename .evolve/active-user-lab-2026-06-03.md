# Active User Lab Audit

Status: implemented and locally verified
Product: AI Trading Arena
Date: 2026-06-03

## Goal

Operate the trading app like real active users: read Lin's open QA issues, map each issue to a live bot or an honest gap, dispatch paper-safe multi-shot prompts into agents, and make those conversations visible in the app.

## What Exists

- CLI: `npm run agent:user-lab -- audit`
- CLI: `npm run agent:user-lab -- dispatch --issue <n> --watch`
- Runtime prompt generation: `--generate-ideas` uses `@tangle-network/agent-runtime` through `evals/src/sim/llm-call.ts`.
- App link shape: `/arena/bot/<botId>/chat?session=<sessionId>`.

## Lin Issue Coverage

Latest audited open issues from `vutuanlinh2k2`:

| Issue | Scenario | Status after pass | Notes |
|---|---|---|---|
| #57 | Hyperliquid perp envelope | Covered | Fresh owned Hyperliquid perp bot created in this pass. |
| #46 | Cross-strategy allocation | Covered | Existing multi bot has completed run + paper trade evidence. |
| #45 | Market making | Covered | Existing MM bot has completed run + paper trade evidence. |
| #44 | Volatility | Covered | Fresh owned volatility bot created in this pass. |
| #43 | GMX/Vertex perp | Covered | Fresh owned GMX/Vertex perp bot created; run found Vertex not enabled for the bot and chain mismatch. |
| #41 | Polymarket CLOB | Covered | Existing prediction bot candidate. |
| #17 | Production readiness | Covered | Fleet-level smoke covered by existing active bots. |
| #16 | Vault collateral admin | Partial | Generic vault/collateral text is no longer allowed to count as full workflow coverage. |
| #9 | Trade history + validator reasoning | Covered | Recent run/trade evidence now visible in audit. |
| #7 | TEE confidential bot | Partial | Deliberately not faked by a generic paper bot. Needs TEE provisioning/runtime-lock path. |
| #3 | Leaderboard filtering | Covered | Existing fleet candidates cover public ranking/filtering. |

## Changes Shipped Locally

- Added `--fresh-bot` to `agent:user-lab dispatch`.
- Fresh mode provisions an owned paper QA bot using the issue's mapped strategy pack, waits for readiness, configures deterministic LLM secrets, creates a chat session, sends prompts, and prints the app URL.
- Added fresh bot specs for Hyperliquid, cross-strategy, MM, volatility, GMX/Vertex perp, Polymarket, production readiness, trade-history reasoning, and leaderboard QA.
- Left TEE and vault collateral admin without generic fresh bot specs so the CLI fails closed instead of claiming false workflow coverage.
- Tightened coverage sorting and matchers:
  - exact candidates always rank before partial candidates
  - Hyperliquid exact coverage requires `strategy:hyperliquid_perp`
  - collateral admin exact coverage requires a real `collateral-admin-workflow` marker
- Added a production-safe auth fallback in `useOperatorAuth`: a browser test/lab can inject `arena.operator_auth.address` plus a valid operator token into `sessionStorage`.

## Real Run Proof

### Issue #57

Command:

```bash
TRADING_OPERATOR_PRIVATE_KEY="$(cd ~/company/devops/secrets && dotenvx get TRADING_OPERATOR_PRIVATE_KEY -f trading-operator.env)" \
  npm run agent:user-lab -- dispatch --fresh-bot --issue 57 --turns 1 --watch --reply-timeout-ms 180000
```

Result:

- Bot: `trading-e1dcfbec-ec12-468b-8ce5-33213aa1edee`
- Session: `manual-sandbox-fd8dd1b3-977e-42bd-b4d9-d32f4628`
- App: `https://trading-arena.blueprint.tangle.tools/arena/bot/trading-e1dcfbec-ec12-468b-8ce5-33213aa1edee/chat?session=manual-sandbox-fd8dd1b3-977e-42bd-b4d9-d32f4628`
- Agent verified:
  - `strategy=hyperliquid_perp`
  - `paper_trade=true`
  - Hyperliquid account value `$10,000`
  - no open positions or orders
  - Hyperliquid live adapter not enabled for live routing

### Issue #44

Command:

```bash
TRADING_OPERATOR_PRIVATE_KEY="$(cd ~/company/devops/secrets && dotenvx get TRADING_OPERATOR_PRIVATE_KEY -f trading-operator.env)" \
  npm run agent:user-lab -- dispatch --fresh-bot --issue 44 --turns 1 --watch --reply-timeout-ms 180000
```

Result:

- Bot: `trading-3e894b00-9d2e-4f33-8dab-33730197ec64`
- Session: `manual-sandbox-09e49fd3-9f35-4b78-b12c-2632169a`
- App: `https://trading-arena.blueprint.tangle.tools/arena/bot/trading-3e894b00-9d2e-4f33-8dab-33730197ec64/chat?session=manual-sandbox-09e49fd3-9f35-4b78-b12c-2632169a`
- Agent replied with concrete volatility configuration inspection and missing fields:
  - `paper_safe` explicit toggle missing
  - `strategy_id` missing
  - `strategy_config.volatility_params` missing
  - no `metrics/latest.json`
  - empty `logs/decisions.jsonl`
  - no volatility-specific tool module yet

### Issue #43

Command:

```bash
TRADING_OPERATOR_PRIVATE_KEY="$(cd ~/company/devops/secrets && dotenvx get TRADING_OPERATOR_PRIVATE_KEY -f trading-operator.env)" \
  npm run agent:user-lab -- dispatch --fresh-bot --issue 43 --turns 1 --watch --reply-timeout-ms 180000
```

Result:

- Bot: `trading-2dac25a3-b8c7-4a0e-a446-2f44ab6eeade`
- Session: `manual-sandbox-e4ffac3b-e5a9-43d4-9146-f4174ad9`
- App: `https://trading-arena.blueprint.tangle.tools/arena/bot/trading-2dac25a3-b8c7-4a0e-a446-2f44ab6eeade/chat?session=manual-sandbox-e4ffac3b-e5a9-43d4-9146-f4174ad9`
- Agent verified:
  - GMX V2 is configured for the bot
  - Vertex exists in `/adapters` but is not in bot `available_protocols`
  - bot chain is Base Sepolia `84532`, while GMX/Vertex issue expects Arbitrum `42161`
  - no Hyperliquid native path is configured

## Verification

- `npm run agent:user-lab -- audit` passed and shows #57, #44, #43 covered; #16 and #7 partial.
- `npm run agent:user-lab -- dispatch --dry-run --fresh-bot --issue 44,43 --turns 1` passed.
- `node --test dist/evals/product/active-user-lab.test.js` passed: 7 tests.
- `npm run typecheck:evals` passed.
- `pnpm --dir arena test -- src/lib/hooks/useOperatorAuth.test.tsx` passed; Vitest ran all arena tests: 78 files, 445 tests.
- `pnpm --dir arena typecheck` passed.
- `pnpm --dir arena build` passed.

## Remaining Risks

- Production app chat is owner-authenticated. Unauthenticated browser screenshot of the fresh session correctly shows no chat sessions.
- The new sessionStorage auth fallback is verified by unit test and local build, but the browser proof using Playwright API was blocked by the repo not exposing `playwright` as an importable local dependency.
- #7 still needs a real TEE provisioning/runtime-lock scenario; a normal paper bot would be false evidence.
- #16 may still need a dedicated collateral admin action harness if the acceptance criteria require cap/write-down mutation proof, not only bot context.

## Next Commands

```bash
TRADING_OPERATOR_PRIVATE_KEY="$(cd ~/company/devops/secrets && dotenvx get TRADING_OPERATOR_PRIVATE_KEY -f trading-operator.env)" \
  npm run agent:user-lab -- dispatch --fresh-bot --issue 41 --turns 1 --watch --reply-timeout-ms 180000
```

```bash
npm run agent:user-lab -- audit
```
