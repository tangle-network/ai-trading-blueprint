# AI Trading Arena UX Route Scorecard

Audit date: 2026-06-03
Scope: arena routes and primary route components, evaluated for Hyperliquid trader, crypto wallet user, DeFi dapp user, and AI app user.

## Scoring Rubric

- 9-10: production-grade, clear data hierarchy, branded, useful without explanation.
- 7-8: solid, route intent and data are right, minor polish left.
- 5-6: useful but visually or structurally inconsistent.
- 1-4: confusing, misleading, unreadable, or toy-like.

## Route Matrix

| Route | Primary components | Before | After | Decision |
| --- | --- | ---: | ---: | --- |
| `/` | `ArenaPageHeader`, `PlatformVolumeChart`, `LatestAgentTrades`, `ArenaTopAgentsPanel` | 8.5 | 8.5 | Keep. Correct first screen for trader scan: volume, fills, top agent, ranking. |
| `/leaderboard` | `ArenaPageHeader`, `FilterBar`, `LeaderboardTable`, selected agent dossier | 8.3 | 8.3 | Keep. Strong agent discovery and right per-agent drilldown. |
| `/activity` | activity tape and selected trade detail | 8.2 | 8.2 | Keep. Good for recent fills and venue-level market behavior. |
| `/dashboard` | `ConnectWalletPanel`, `ArenaPageHeader`, `ServiceCard`, `HomeBotCard`, `OperatorAccessCard` | 5.5 | 8.0 | Fixed. Disconnected/loading/empty/populated states now use the same arena terminal shell and one header. |
| `/create` | mandate input, strategy book, compiler, envelope, readiness | 8.0 | 8.4 | Polished. Copy now reads as mandate/replay/envelope/workspace, with Hyperliquid risk language. |
| `/provision` | blueprint selector, deploy console, secrets, launch summary | 8.3 | 8.3 | Keep. Strong launch console; fixture smoke verifies connected and disconnected views. |
| `/vault/:address` | `VaultStats`, `CollateralStats`, `DepositForm`, `WithdrawForm`, `VaultActivity` | 6.2 | 7.7 | Fixed shell. Contract state remains honest; page now shares terminal header, route metrics, tighter cards. |
| `/arena/bot/:id/performance` | `AgentWorkspaceShell`, `PerformanceTab`, `TradingPerformanceChart`, copilot panel | 8.2 | 8.2 | Keep. Chart and metrics are useful for Hyperliquid performance review. |
| `/arena/bot/:id/portfolio` | `PortfolioWorkspace`, `PositionsTab`, `TradeHistoryTab` | 5.0 | 8.1 | Fixed. Light theme ledger readability and dense execution table contrast are now correct. |
| `/arena/bot/:id/runs` | `RunsTab`, run details, reasoning trace | 7.8 | 7.8 | Keep. Good AI-agent provenance; fixture covers empty and populated states. |
| `/arena/bot/:id/chat` | `ChatTab`, transcript, run context | 7.8 | 7.8 | Keep. Useful for AI app user; fixture covers transcript surfaces. |
| `/arena/bot/:id/operations` | `OperationsWorkspace`, controls, reasoning, terminal, envelope, vault | 8.0 | 8.0 | Keep. Control plane is dense, branded, and verified in smoke. |

## Component Findings

### Fixed

- `PortfolioWorkspace`: removed hard-coded dark `!` table overrides and moved shell/table colors to terminal CSS variables.
- `PositionsTab`: ledger loading, empty, metrics, and table shells now use terminal variables, so light mode stays readable.
- `TradeHistoryTab`: compact execution table, skeletons, pager, empty state, size/USD/ref cells now use terminal variables.
- `dashboard.tsx`: replaced old generic page chrome with `ConnectWalletPanel` and `ArenaPageHeader`; removed duplicate stats bar.
- `create.tsx`: upgraded launch vocabulary from generic prompt/backtest language to mandate, replay, envelope, and venue/risk copy.
- `vault.$address.tsx`: migrated route shell to the arena terminal system; added route metrics and address/chain readout.
- `VaultStats`, `CollateralStats`, `DepositForm`, `WithdrawForm`, `VaultActivity`: tightened visible vault card radius to match app controls.

### Kept

- Home, agents, activity, provision, performance, runs, chat, and operations already passed the route-level scan after the previous redesign.
- Vault read failures remain visible and explicit. The fix was presentation, not hiding failed contract state.

## Verification

- `pnpm --dir arena test`: 76 files, 431 tests passed.
- `pnpm --dir arena build`: production client and SPA build passed.
- `pnpm --dir arena smoke:agent-workspace -- --url http://127.0.0.1:5176 --fixture --screenshot-dir ../.evolve/arena-full-ux-audit-20260603/screens-after-final`: passed.
- Light screenshots captured in `.evolve/arena-full-ux-audit-20260603/screens-after/` for dashboard, vault, home, agents, create, provision, and workspace views.

## Remaining Risk

- Connected wallet dashboard visual quality is covered by component tests and shared shell, but still needs a real wallet/browser capture before a final design freeze.
- Vault route is visually aligned now, but live usefulness depends on pointing users at actual deployed vaults instead of factory addresses.
