# Product Brief

Product: AI Trading Arena is a web trading workspace for launching, ranking, monitoring, and auditing autonomous trading agents across operator-managed venues.

Status: Production-facing beta. The live app is deployed at `https://trading-arena.blueprint.tangle.tools` and reads real operator APIs, while local smoke tests use deterministic fixture operators.

Primary users:
- Crypto traders and DeFi users evaluating whether an agent is active, trustworthy, and worth inspecting.
- Agent operators who deploy, configure, monitor, and revise trading agents.
- Protocol or platform reviewers who need evidence that agents are controlled, auditable, and not presenting fake execution.

Core jobs:
- Understand whether the platform is live: recent fills, volume, active agents, and top movers.
- Choose an agent to inspect from a dense ranked explorer.
- Inspect an agent's account, market chart, fills, risk, positions, runs, decisions, chat trace, and control-plane state.
- Create a paper agent quickly from a natural-language mandate that becomes a canonical `AgentProfile`: objective, mandate, capabilities, broad wired venue access, risk limits, autonomy, learning, telemetry, and activation projection.
- Activate an agent profile with explicit wallet-backed requirements: runtime/service ownership, execution adapter, venue target, assets, collateral, operator route, network, validator trust, review, and secrets.
- Verify that execution, validation, vault, operator, and trace data are accurate enough to act on.

Primary workflows:
- Home: scan market pulse, platform flow, latest fills, and top agents.
- Agents: search, rank, compare, and open agent workspaces.
- Activity: inspect recent execution records and their agent/market context.
- New Agent: turn a natural-language mandate and optional template seed into an `AgentProfile`, start in paper mode, and open the resulting workspace.
- Activation/Provision: convert an `AgentProfile` into a wallet-backed operator instance by choosing the required execution adapter/runtime projection, route, funding, validators, and secrets.
- Agent workspace: inspect performance, portfolio, runs, chat, and operations without losing agent context.
- Operations: audit runtime state, validation, revisions, permissions, vault/secrets, and control availability.

Critical data:
- Agent identity, status, strategy, venue, network, account/vault/operator addresses, and paper/live mode.
- Account value, return, drawdown, fills, total and recent volume, positions, executions, and market candles.
- Trade evidence: fill count source, priced/unpriced fills, outside-range fills, timestamps, prices, notional, status, validation, and provenance.
- Run and chat trace evidence: workflow, decision, tools, reasoning, output, error state, public/private access, and timestamps.
- AgentProfile evidence: objective, raw mandate, market, preferred venue, capabilities, available/preferred protocols, protocol chain map, risk constraints, learning policy, telemetry policy, and activation projection.
- Activation evidence: wallet, network, service, collateral, execution adapter, asset universe, operator route, and launch readiness.

Primary actions:
- Open an agent workspace from Home, Agents, or Activity.
- Switch agent workspace sections: Performance, Portfolio, Runs, Chat, Operations.
- Inspect fills, copy addresses/IDs, open external records when available, and navigate to source agents.
- Connect wallet, authenticate operator access, select network, review activation/provisioning, and configure secrets.
- Collapse/expand navigation and, eventually, persist user-controlled workspace layout.

Creation model decision:
- The user is not buying a strategy pack. The user is defining an autonomous trading agent with a mandate, risk constraints, venue preferences, learning policy, telemetry, and paper/live activation state.
- `AgentProfile` is the durable product primitive. It should be created first, inspected as the source of truth, and passed through launch/provisioning without collapsing multi-venue intent into one visible adapter choice.
- Templates are allowed only as starting points that seed the mandate. They must not imply that the agent is hard-wired to a pack, venue, or deterministic strategy unless the owner explicitly constrains it.
- Strategy type, adapter, execution target, validator trust, asset universe, and collateral fields are runtime compiler outputs. They belong in wallet/operator review, advanced inspection, or error recovery, not as the main mental model.
- The ideal flow is one launch cockpit: write/select mandate, edit the derived AgentProfile, review the runtime plan and operator quote, connect/sign, then land in the agent workspace. `/provision` may remain as a resumable transaction route, but it should not feel like a second product flow.

Creation alternatives evaluated:
- Keep Create and Provision as separate strategy-pack wizards: 4/10. It exposes implementation, forces users to reason about adapters, and makes adaptive multi-venue agents feel smaller than the backend intent.
- Chat-only agent creation: 7/10. It fits AI expectations but hides risk, operator quote, wallet, and venue constraints too easily; useful as an input mode, not the whole control surface.
- AgentProfile-first launch cockpit with derived runtime plan: 9/10. It matches the promise of “tell the agent what to trade and let it figure out the best adaptive strategy,” while still keeping wallet, permissions, operator, validator, telemetry, and paper/live evidence explicit.
- Fully autonomous marketplace agent with no configuration UI: 6/10 today. This could become powerful later, but current operator, whitelist, vault, and validation controls need first-class owner review.

Trust, risk, and compliance:
- Never fake trades, transcripts, validation, success states, or data freshness.
- Make consequential identifiers copyable: bot ID, operator, submitter, vault, transaction/order/reference IDs where present.
- Distinguish paper/live, public/private, loaded/total, priced/unpriced, visible/outside-range, and stale/current states without bloated labels.
- Treat charts, tables, ledgers, and traces as instruments. They must be compact, scannable, source-aware, and honest under missing data.
- Wallet, network, and transaction menus must stay reachable in both expanded and collapsed layouts.

Design posture:
- Dense, professional trading and agent-operations terminal.
- Compact chrome, route-native navigation, restrained color, square data surfaces, stable dimensions, and no nested card stacks.
- Favor tables, charts, ledgers, tapes, inspectors, command surfaces, and copyable records over marketing cards or explanatory panels.
- Light and dark themes are both production surfaces.
- Color hierarchy: neutral surfaces carry structure, Tangle purple marks interaction/selection/focus/primary action, green is reserved for positive trading or healthy completion, amber/red are risk and failure.

Non-goals:
- Do not turn the app into a marketing landing page.
- Do not hide critical trading, wallet, or operator state behind hover-only UI.
- Do not add decorative widgets to fill sparse data.
- Do not bolt on draggable/resizable behavior without a coherent persisted layout model.
- Do not introduce duplicate navigation layers unless each layer has a distinct job.
- Do not present capability focus as a hard venue prison. Agents should carry broad wired venue access and a mandate-derived preference unless a real runtime, validator, wallet, or venue constraint prevents execution.
- Do not maintain separate Create and Deploy product stories. The product story is paper agent first, activation second, graduation to live later.
- Do not make strategy packs the user-facing source of truth. Templates may seed an AgentProfile; runtime strategy fields are compatibility projections until the operator API fully speaks AgentProfile natively.

Evidence:
- `arena/src/routes/_index.tsx`, `leaderboard.tsx`, `activity.tsx`, `create.tsx`, `provision.tsx`, and `arena.bot.$id.*.tsx`
- `arena/scripts/smoke-agent-workspace.mjs`
- `.evolve/arena-workspace-redesign-2026-06-01.md`
- Production release claims must cite the deployed commit verified from the deploy workflow, not just a local build or accepted build hook.

Open questions:
- Which production wallet/auth fixture should be canonical for connected Provision screenshots in CI?
- Which workspace layout preferences should be persisted first: sidebar width, docked fills, inspector width, or route-specific panel arrangement?
- Which agent/run trace fields are intentionally public versus owner-only on the live operator API?
