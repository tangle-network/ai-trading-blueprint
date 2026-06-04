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

## Follow-Up Pass - Home Workspace And Fills

Complaints addressed:
- Light theme selected/hover states were neon or pale-on-pale.
- Home bottom panels did not clearly own the remaining page height.
- Recent fills could show empty when the aggregate endpoint returned an empty success.
- Activity fill rows had a row-inspect vs agent-navigation contradiction.
- Agent performance fills could squeeze market/notional labels at wide breakpoints.

Actions shipped:
- Added a persisted home workspace layout with a draggable row split, draggable fills rail width, reset, and minimize/restore controls for fills and top agents.
- Kept home desktop panels full-height while restoring stacked behavior below desktop.
- Tokenized selected chart controls and corrected legacy pale-cyan text mappings for light theme.
- Made an empty latest-fills aggregate fall back to bot ledgers instead of proving an empty tape.
- Made Activity explorer rows select fills directly while the agent link remains the explicit navigation target.
- Rebuilt agent performance fill rows as compact tickets with fill/market on the left and notional/execution detail on the right.

Verification:
- `pnpm --dir arena exec vitest run src/routes/__tests__/index.test.tsx src/components/arena/__tests__/LatestAgentTrades.test.tsx src/components/arena/__tests__/ArenaTopAgentsPanel.test.tsx src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/lib/hooks/useBotApi.test.ts --reporter=dot`
- `pnpm --dir arena typecheck`
- `pnpm --dir arena test`
- `pnpm --dir arena build`
- `pnpm --dir arena smoke:agent-workspace -- --fixture --theme-matrix --screenshot-dir /tmp/arena-home-panels-ship`
- Extra 1600px light performance screenshot against fixture confirmed the side fill rail no longer clips market/notional/action labels.

Remaining product debt after this pass:
- Home layout drag is intentionally scoped to the home workspace; agent workspaces still need a broader persisted layout model before arbitrary draggable/resizable panels should ship.
- My Agents and Operations remain the next highest-value design pass.

## Follow-Up Pass - Shell Alignment, Paper QA Funding, Square Surfaces

Complaints addressed:
- Public pages still had a rounded header/app-bar treatment and non-flush route shells.
- Create and Deploy were closer, but Create still sent a thin bot-create payload and did not explicitly fund paper agents.
- QA/local E2E agents could still be created with prompt-sliced names and no explicit starting paper capital in the creation payload.
- Switching volume ranges could flicker through skeleton states.
- Portfolio, performance fills, activity fills, operations, leaderboard, wallet/network menus, and transactions still had rounded structural frames.

Actions shipped:
- Replaced page headers with a square 56px app bar aligned to the sidebar top row.
- Added `paper_trade: true`, `paper_safe: true`, and `initial_capital_usd: "10000"` to Create, Deploy, active-user lab fresh bots, and the local product API fallback.
- Replaced prompt-sliced local E2E names with strategy-specific QA names.
- Kept previous platform-volume data visible while a new 1D/7D/30D/6M/1Y range is loading.
- Squared major route/workspace surfaces, table wrappers, chart frames, fills rails, operations panels, leaderboard stat panels, and wallet/network/transaction popovers.
- Scoped a workspace-level square override for bordered legacy tab internals without removing unbordered status dots or avatars.

Verification:
- `pnpm --dir arena test src/routes/__tests__/create.test.tsx src/routes/__tests__/provision.test.ts src/components/arena/__tests__/ArenaPageHeader.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx src/components/layout/__tests__/WalletButton.test.tsx src/components/bot-detail/__tests__/EnvelopeNeededBanner.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx src/components/bot-detail/__tests__/RunsTab.test.tsx src/components/bot-detail/__tests__/PortfolioWorkspace.test.tsx src/components/bot-detail/__tests__/OperationsWorkspace.test.tsx src/components/arena/__tests__/LatestAgentTrades.test.tsx`
- `pnpm --dir arena typecheck`
- `npm run build:evals --silent && node --test dist/evals/product/active-user-lab.test.js`
- `pnpm --dir arena build`
- `pnpm --dir arena smoke:agent-workspace -- --fixture --theme-matrix --screenshot-dir /tmp/arena-smoke-shell-final`
- `git diff --check`

Screenshot review:
- `/tmp/arena-smoke-shell-final/1440x900-home-light.png`: square app bar, flush sidebar/main seam, readable light hover/selected state, non-empty fills.
- `/tmp/arena-smoke-shell-final/1440x900-create-light.png`: compact Create surface, contiguous strategy rail, funded paper-agent payload covered by tests.
- `/tmp/arena-smoke-shell-final/1440x900-performance-light.png`: chart/fills rails are square, fill market/notional labels do not overlap.
- `/tmp/arena-smoke-shell-final/1440x900-portfolio-light.png`: positions remain visible above executions.
- `/tmp/arena-smoke-shell-final/1440x900-activity-light.png`: fill row selection and agent navigation are separate actions.
- `/tmp/arena-smoke-shell-final/1440x900-chat-light.png`: no duplicated runs trace when there are no chat sessions.
- `/tmp/arena-smoke-shell-final/1440x900-operations-light.png`: operations record IDs are visible/copyable and dark-on-dark validation regression is absent in the fixture.

Remaining product debt after this pass:
- Existing live QA bots created before this patch may still need `/api/bots/repair-names` and/or a config repair if their persisted records predate the funded paper payload.
- Draggable/resizable panels now exist on key workspaces, but arbitrary drag/reflow across every page still needs a persisted layout model and keyboard/mobile recovery.
- Deploy’s strategy compiler is usable but still deserves a deeper PM-level restructure after live shipping.
