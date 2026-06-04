# AgentProfile Product Audit

Status: implemented, locally verified, pending production deploy.
Product brief: `PRODUCT_BRIEF.md`
Focus: New Agent, Activation/Provision, run/workflow identity.

## Verdict
- The old model made users choose a strategy pack too early. That is the wrong product primitive for an AI trading agent.
- The winning model is: owner mandate -> canonical `AgentProfile` -> paper agent -> activation adapter projection.
- Templates are allowed only as UI seeds. Runtime `strategy_type` remains a compatibility adapter until the operator API fully speaks AgentProfile natively.

## Alternatives Evaluated
- Keep strategy packs as the product primitive: rejected. Fast to ship, but it makes the agent feel deterministic and venue-constrained.
- Add multi-select strategy packs: rejected. It multiplies UI state while preserving the wrong abstraction.
- Hide all adapter choice: rejected for now. The current runtime, validator, chain, and wallet flows still need a concrete execution adapter.
- AgentProfile canonical with broad wired access plus one adapter projection: selected. It supports agentic mandates, paper-first launch, telemetry, learning policy, and current execution constraints.

## Changes Shipped
- Added `arena/src/lib/agentProfile.ts` with `tangle.trading.agent-profile.v1`.
- Create now builds and submits `agent_profile` at the top level and inside `strategy_config`.
- Create stores `agentProfile` in the draft handoff to Activation.
- Create copy now uses Mandate, Agent Profile, Mandate Templates, and AgentProfile summary instead of launch-ticket/strategy-book language.
- Activation now presents `Agent Profile` and `Activation Adapter`, with profile/objective carried from Create when present.
- Adapter display labels were cleaned: `DEX Spot`, `DeFi Yield`, `EVM Perps`, `Cross-Market Allocator`.
- Operator API accepts `agent_profile` as a source of prompt, projected strategy type, response data, runtime env, and sandbox bootstrap memory.
- Observatory workflow ID moved from `base + 1` to `base + 3` so research, conversation, trading, and observatory runs do not collide.

## Verification
- `pnpm --dir arena typecheck`: passed.
- `pnpm --dir arena test`: passed, 80 files / 459 tests.
- `pnpm --dir arena build`: passed.
- `cargo test -p trading-blueprint-bin create_bot_strategy_config -- --nocapture`: passed.
- `cargo test -p trading-blueprint-bin -- --test-threads=1`: passed, 69 integration tests passed / 1 ignored plus unit targets.
- `cargo test -p trading-blueprint-lib jobs::observatory_cadence -- --test-threads=1`: passed, 10 tests.
- `cargo fmt --check`: passed.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --theme-matrix --screenshot-dir ../.evolve/agent-profile-smoke-2026-06-04/screenshots`: passed.

## Screenshot Evidence
- 44 screenshots captured under `.evolve/agent-profile-smoke-2026-06-04/screenshots`.
- Spot-checked:
  - `1440x900-create-light.png`
  - `1440x900-create-dark.png`
  - `1440x900-provision-connected-light.png`
  - `1440x900-provision-connected-dark.png`

## Remaining Risks
- Backend still requires `strategy_type`/adapter projection for actual execution; this is now compatibility, not product source of truth.
- Activation is still a separate route. Product story is unified, but the route split remains until wallet-backed activation can be folded into the paper-agent workspace.
- Existing historical observatory runs that used the old colliding workflow ID may still appear as research because the old ID is ambiguous.
- Mobile screenshots were not captured in this pass; existing smoke coverage is 1280x800 and 1440x900.
