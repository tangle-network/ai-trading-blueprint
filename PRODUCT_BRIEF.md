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
- Deploy a new agent with a clear mandate, strategy, venue, assets, collateral, wallet, network, and review path.
- Verify that execution, validation, vault, operator, and trace data are accurate enough to act on.

Primary workflows:
- Home: scan market pulse, platform flow, latest fills, and top agents.
- Agents: search, rank, compare, and open agent workspaces.
- Activity: inspect recent execution records and their agent/market context.
- Create: compile a natural-language mandate into an agent launch request.
- Deploy/Provision: configure strategy, assets, operator route, collateral, and review before launch.
- Agent workspace: inspect performance, portfolio, runs, chat, and operations without losing agent context.
- Operations: audit runtime state, validation, revisions, permissions, vault/secrets, and control availability.

Critical data:
- Agent identity, status, strategy, venue, network, account/vault/operator addresses, and paper/live mode.
- Account value, return, drawdown, fills, total and recent volume, positions, executions, and market candles.
- Trade evidence: fill count source, priced/unpriced fills, outside-range fills, timestamps, prices, notional, status, validation, and provenance.
- Run and chat trace evidence: workflow, decision, tools, reasoning, output, error state, public/private access, and timestamps.
- Provisioning evidence: wallet, network, service, collateral, strategy profile, asset universe, and launch readiness.

Primary actions:
- Open an agent workspace from Home, Agents, or Activity.
- Switch agent workspace sections: Performance, Portfolio, Runs, Chat, Operations.
- Inspect fills, copy addresses/IDs, open external records when available, and navigate to source agents.
- Connect wallet, authenticate operator access, select network, deploy/review provision, and configure secrets.
- Collapse/expand navigation and, eventually, persist user-controlled workspace layout.

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

Non-goals:
- Do not turn the app into a marketing landing page.
- Do not hide critical trading, wallet, or operator state behind hover-only UI.
- Do not add decorative widgets to fill sparse data.
- Do not bolt on draggable/resizable behavior without a coherent persisted layout model.
- Do not introduce duplicate navigation layers unless each layer has a distinct job.

Evidence:
- `arena/src/routes/_index.tsx`, `leaderboard.tsx`, `activity.tsx`, `create.tsx`, `provision.tsx`, and `arena.bot.$id.*.tsx`
- `arena/scripts/smoke-agent-workspace.mjs`
- `.evolve/arena-workspace-redesign-2026-06-01.md`
- Live deploy commit `287a0650b835f31c5ce1093243fa0fabbbb8a2dd`

Open questions:
- Which production wallet/auth fixture should be canonical for connected Provision screenshots in CI?
- Which workspace layout preferences should be persisted first: sidebar width, docked fills, inspector width, or route-specific panel arrangement?
- Which agent/run trace fields are intentionally public versus owner-only on the live operator API?
