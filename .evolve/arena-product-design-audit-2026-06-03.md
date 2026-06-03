# Arena Product Design Audit - 2026-06-03

## Product Brief

Source of truth: `PRODUCT_BRIEF.md`.

Primary user jobs:
- Compare autonomous trading agents by real performance, fills, drawdown, venue, and execution evidence.
- Inspect a single agent deeply enough to trust or reject its strategy, risk envelope, and trades.
- Create or deploy a new agent without guessing what capital path, operator path, or venue path will be used.
- Operate a provisioned agent through validation, revisions, runs, chat, and portfolio state without losing context.

Design posture:
- Terminal-grade trading product, not a marketing page.
- Dense, scan-first, legible in light and dark themes.
- Tables are square and data-led; cards are used for repeated entities, modals, and framed tools only.
- Labels must earn their space by disambiguating capital, venue, risk, evidence, or action.

## Page Audit

| Page | Primary job | Current judgment | Action taken |
| --- | --- | --- | --- |
| Home | Market pulse, fills, top agents | Better branded, still chart-heavy | Verified in fixture theme matrix; no code change this pass. |
| Agents | Compare and drill into agents | Cohesive with header system | Verified in fixture theme matrix; no code change this pass. |
| Activity | Scan latest fills and inspect one fill | Rows were oversized and light/dark hover risk remained | Compacted explorer rows, narrowed inspector rail, reduced table minimum width. |
| My Agents | Owner inventory and drafts | Existing dashboard still has some rounded panels | Not changed this pass; remains below agent workspace polish. |
| Create | Convert mandate to agent | Mandate/editor consumed too much first viewport | Reduced editor height, tightened right rail, compacted route chips. |
| Deploy | Configure strategy/operator/capital path | Strategy grid felt jumpy and prediction group felt bolted on | Stabilized strategy card heights, removed click scale, compacted header/panels, normalized prediction-market grid. |
| Agent Performance | Inspect chart, fills, market/NAV | Strongest surface; fills still dense but usable | Verified in fixture theme matrix; no code change this pass. |
| Agent Portfolio | See positions before executions | Executions visually competed with positions | Rebalanced pane rows toward positions and contained executions overflow. |
| Agent Runs | Inspect autonomous trace | Sidebar metadata could force horizontal scroll | Constrained metadata grid and blocked x overflow. |
| Agent Chat | Talk to/inspect agent trace | Sidebar duplicated runs but should not horizontally scroll | Constrained session rows and blocked x overflow. |
| Agent Operations | Validate revisions/envelope/control | Improved but still needs deeper copy/capability pass | Verified in fixture theme matrix; no code change this pass. |
| Provision Wallet Gate | Connect wallet for deploy | Branded and functional | Verified light/dark fixture gate; wallet menu already opens upward/clamped. |

## Component Audit

| Component | Purpose | Decision |
| --- | --- | --- |
| `ArenaPageHeader` | Single app page identity and primary actions | Keep as unified shell; no title badges unless essential. |
| Sidebar nav | Global route switching | Keep navigation-only. Theme/transactions stay in header utilities. |
| Wallet/account dock | Account and network operations | Keep upward, viewport-clamped sidebar popovers; tests cover this. |
| Latest fills explorer | Activity ledger and fill inspector | Dense rows; inspector gets fixed rail; no rounded table shell. |
| Create mandate editor | User intent capture | Large enough for a full strategy sentence, not a hero-sized empty field. |
| Create compiler/envelope | Explain inferred route/risk | Keep compact proof rows; no extra explanatory copy. |
| Deploy strategy cards | Capital/venue profile selection | Stable same-height rows; no active scale; prediction group remains visible but not visually second-class. |
| Portfolio positions | Trust-critical account state | Primary space allocation over executions. |
| Portfolio executions | Audit recent fills | Contained scroll inside lower pane. |
| Runs/Chat sidebars | Select trace/session | No horizontal overflow; metadata wraps to stable second row. |
| Table shells | Trading data display | Square wrappers/thead/tbody/tr/th/td overrides reinforced. |

## Evidence

Commands:
- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/RunsTab.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx src/components/arena/__tests__/LatestAgentTrades.test.tsx src/components/provision/__tests__/ConfigureStep.test.tsx src/routes/__tests__/create.test.tsx src/components/bot-detail/__tests__/PortfolioWorkspace.test.tsx src/components/bot-detail/__tests__/PositionsTab.test.tsx src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx src/components/layout/__tests__/WalletButton.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx --reporter=dot`
- `pnpm --dir arena typecheck`
- `pnpm --dir arena test`
- `pnpm --dir arena build`
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir /tmp/arena-audit-fixture-after`
- `pnpm --dir arena smoke:agent-workspace -- --fixture --theme-matrix --screenshot-dir /tmp/arena-audit-theme-matrix`
- `git diff --check`

Screenshots:
- `/tmp/arena-audit-fixture-after`
- `/tmp/arena-audit-theme-matrix`

## Remaining Product Debt

- Draggable/resizable panels are not implemented. That is a product architecture change, not a polish tweak; it needs persisted layouts, keyboard fallback, and mobile behavior.
- My Agents/dashboard still trails the agent workspace in density and polish.
- Operations/revisions can use a deeper evidence-design pass with copyable IDs and stronger validation grouping.
- Runs and Chat intentionally share trace presentation, but their information architecture should be revisited so Chat does not feel like a duplicate Runs page.
