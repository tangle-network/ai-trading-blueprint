# AI Trading Arena Fourth-Pass Systematic Audit

Date: 2026-06-03
Base commit: d7e93e0
Ops task: #951

## Process

This pass re-ran the product audit from the rendered app, not only from source.

1. Rebuilt the route and component inventory from `arena/src/routes` and `arena/src/components`.
2. Captured fixture screenshots for home, agents, activity, create, provision, and every agent workspace tab.
3. Reviewed each page against four users:
   - Hyperliquid trader: market, side, size, notional, leverage, liquidation, margin, fills, PnL.
   - Crypto wallet user: connected wallet, chain, signatures, transaction state, custody boundaries.
   - DeFi dapp user: vault state, collateral, deposits, withdrawals, honest read/write failures.
   - AI app user: agent identity, mandate, reasoning, runs, chat, tools, validation, operator controls.
4. Patched only high-confidence issues visible in screenshots and defendable in tests.
5. Re-ran focused route tests and the fixture smoke harness after each revision.

## Iteration Log

| Round | Evidence | Finding | Action |
| --- | --- | --- | --- |
| Inventory | Source route tree and prior scorecards | The active root uses `ArenaAppShell`; old `Header.tsx` is not mounted | Treated "stacked headers" as page hierarchy density, not a live duplicate app header |
| Screenshot pass | `screens-fourth-pass-before/1440x900-home.png` | Home is now a single trading terminal frame with live pulse, volume, top agent, and fill tape | No broad home rewrite |
| Screenshot pass | `screens-fourth-pass-before/1440x900-leaderboard.png` | Agents page repeated selected-agent identity, account stats, and execution facts in center and right panels | Kept the right cockpit as account/routing owner; center panel now becomes recent fills on wide screens |
| Screenshot pass | `screens-fourth-pass-before/1440x900-create.png` | Create page placeholder suggested ETH-PERP, but computed state defaulted to DEX Spot | Default Create mandate now starts on Hyperliquid Perps |
| Screenshot pass | `screens-fourth-pass-after/1440x900-create.png` | "Hyperliquid / derivatives" truncated in compact cells | Shortened venue label to "Hyperliquid Perps" |
| Verification | Focused tests and fixture smoke | Initial Agents revision removed too much useful context | Revised to keep recent-fill tape and remove only duplicated facts |

## Route Inventory And Rationale

| Route | Core components and subcomponents | Hyperliquid/trading value | Crypto/DeFi/AI value | Fourth-pass verdict |
| --- | --- | --- | --- | --- |
| `/` | `ArenaAppShell`, `ArenaPageHeader`, `HeaderTrustBar`, `HomePulseBoard`, `PlatformVolumeChart`, `LatestAgentTrades`, `ArenaTopAgentsPanel` | Shows latest fill, 24H flow, 30D platform volume, top agent, live/paper split | Wallet/chain/operator/evidence visible; AI agents appear as live operators, not marketing cards | Keep. Dense but coherent. 8.8 |
| `/leaderboard` | search, `LeaderboardTable`, selected-agent dossier, selected-agent cockpit, recent-fill tape, workspace links | Lets a trader rank agents, inspect recent ETH-PERP fills, and jump to performance/portfolio/runs/chat | Operator, vault, chain, trust, service routing remain visible in one cockpit | Changed. Removes duplicate selected-agent context on wide desktop. 8.9 |
| `/activity` | `ArenaPageHeader`, `LatestAgentTrades` explorer, fill table, fill inspector, evidence tags | Best page for execution tape: side, market, USD, price, input/output, source, score | Inspector exposes agent, venue, ref, validation, reasoning provenance | Keep. 8.8 |
| `/arena` | redirect route | Prevents stale legacy entry | No fake content | Keep. 9.0 |
| `/dashboard` | wallet gate, owner metrics, `ProvisionsBanner`, `ServiceCard`, `HomeBotCard`, `SecretsModal`, operator lock state | Owner sees live/paper agents, NAV, trades, validator score | Wallet ownership drives services, vaults, secrets, operator-managed agents | Keep. 8.5 |
| `/create` | mandate editor, strategy book, strategy compiler, envelope checks, launch path, readiness rows, create CTA | Starts from Hyperliquid Perps by default; mandate, venue, risk envelope, replay, and workspace now agree | AI user gets a compiler-like path instead of a blank toy chat box | Changed. 8.9 |
| `/provision` | wallet gate, deployment header, stepper, `BlueprintSelector`, `ConfigureStep`, `DeployStep`, `SecretsStep`, infra/advanced dialogs | Supports Hyperliquid pack but still defaults to general DEX Spot provisioning | Correct chain, quote, service, asset, secret, and activation states | Keep for now. Functionally strong; next visual target. 8.4 |
| `/vault/:address` | invalid-address state, `VaultStats`, `CollateralStats`, `CollateralAdmin`, `DepositForm`, `WithdrawForm`, `VaultActivity` | Shows vault/collateral facts when a real vault address exists | Fails closed on bad addresses or read failures; deposit/withdraw path is explicit | Keep. Data truth matters more than fake polish. 8.0 |
| `/arena/bot/:id/performance` | `AgentWorkspaceShell`, chart header, market/NAV controls, `TradingPerformanceChart`, Hyperliquid risk strip, fills, decision/copilot panels | Professional Hyperliquid dashboard: candles, fills, notional, margin use, max leverage, nearest liquidation, uPnL | Agent identity, operator status, evidence, and envelope warnings are visible | Keep. 8.9 |
| `/arena/bot/:id/portfolio` | portfolio summary, `PositionsTab`, perps/spot positions, liquidation, leverage, execution ledger, validation details | Risk ledger for open positions and execution history | DeFi/account view and AI validation trail | Keep. 8.7 |
| `/arena/bot/:id/runs` | run sidebar, run summary, transcript replay, trace cockpit, decision activity, decision inspector | Maps trades to agent decisions and run outcomes | Core AI traceability surface | Keep. 8.4 |
| `/arena/bot/:id/chat` | session sidebar, new/rename/delete, auth gate, run banner, transcript, input | Operator can question or steer the agent without leaving workspace | Chat is tied to real sessions/runs/tools, not generic chat UI | Keep. 8.5 |
| `/arena/bot/:id/operations` | overview, validation, revisions, controls, envelope, secrets, vault, terminal | Control plane for risk, lifecycle, evidence, and terminal access | Wallet/DeFi/AI safety surfaces live in one section | Keep. 8.7 |

## Component And Subcomponent Decisions

### Global Shell

| Component | Subcomponents | Decision |
| --- | --- | --- |
| `ArenaAppShell` | desktop rail, collapsed rail, mobile top bar, nav, wallet, chain switcher, tx dropdown, theme toggle, skip link | Keep. It is the active single app frame and fixes the prior multi-header failure mode |
| `ArenaPageHeader` | title, live dot, metrics, badge, controls, child detail row | Keep. Dense but consistent across terminal pages |
| `ConnectWalletPanel` | wallet gate, title, description, bullets | Keep. Correct first state for crypto users |
| `OperatorSessionBanner` / `OperatorAccessCard` | auth state, API URLs, locked copy | Keep. Private operator data fails closed |
| Terminal theme variables | dark/light tokens, semantic trade pills, arbitrary utility remap | Keep. Light mode is real and verified in screenshots |

### Public Arena

| Component | Subcomponents | Decision |
| --- | --- | --- |
| `HomePulseBoard` | latest fill, 24H flow, top agent, 30D platform | Keep. This is the first scan a trading user needs |
| `PlatformVolumeChart` | range controls, mode controls, volume bars, live/paper summary | Keep. Good proof of market activity |
| `LatestAgentTrades` | table, panel feed, pagination, fill inspector, action pills, market display | Keep. Core execution evidence |
| `ArenaTopAgentsPanel` | ranked rows, activity stats, workspace link | Keep. Secondary scanner on home |
| `LeaderboardTable` | rank, agent, 24H volume, fills, mode, return, selected row | Keep. Primary comparison surface |
| `SelectedAgentDossier` | middle detail area, recent fills | Changed. On wide desktop it stops repeating identity/stats and becomes recent fills |
| `SelectedAgentCockpit` | identity, quick links, account stats, routing facts | Keep. Single owner of selected-agent account/routing context on wide desktop |

### Owner, Create, Deploy

| Component | Subcomponents | Decision |
| --- | --- | --- |
| `ServiceCard` | service state, operator, agent links | Keep. Owner infra visibility |
| `HomeBotCard` | owned agent card, metrics, secrets action | Keep |
| `ProvisionsBanner` | pending/failed deployment lifecycle | Keep. Prevents hidden async failure |
| `SecretsModal` / `SecretsStep` | provider selection, API key state, activation | Keep. AI runtime prerequisite |
| `CreateAgent` | mandate, strategy book, compiler, envelope, launch path, readiness, CTA | Changed. Default and compact venue now match Hyperliquid Perps |
| `BlueprintSelector` | blueprint/runtime choice | Keep |
| `ConfigureStep` | strategy pack, service, assets, risk, customize | Keep. Next polish target |
| `DeployStep` | quote/deploy path | Keep |
| `InfrastructureDialog` / `AdvancedSettingsDialog` | operators, runtime, validation trust, advanced fields | Keep |

### Agent Workspace

| Component | Subcomponents | Decision |
| --- | --- | --- |
| `AgentWorkspaceShell` | agent rail, account card, copy/explorer buttons, section nav, footer facts | Keep. Strong branded specific-agent frame |
| `PerformanceTab` | chart, top metrics, risk strip, fills, copilot/decision panels | Keep after previous pass. Correct Hyperliquid data now appears at top level |
| `TradingPerformanceChart` | candles, volume, markers, NAV overlay, coverage badge | Keep |
| `PortfolioWorkspace` / `PositionsTab` | summary, position cards/table, liquidation, margin, leverage | Keep |
| `TradeHistoryTab` | compact/full ledger, validation, simulation, pagination | Keep |
| `RunsTab` | run list, transcript, trace details, decision feed | Keep |
| `ChatTab` / `ChatTranscript` | sessions, active run, tool/reasoning parts, input | Keep |
| `OperationsWorkspace` | overview plus validation/revisions/controls/envelope/secrets/vault/terminal panels | Keep |
| `EnvelopeTab` | sign/submit/revoke risk envelope | Keep |
| `HyperliquidVaultTab` | account mode, shares, settlement, queue/cancel/fulfill | Keep |
| `TerminalTab` / `OperatorTerminalView` | terminal auth/support states | Keep |

### Vault

| Component | Subcomponents | Decision |
| --- | --- | --- |
| `VaultStats` | TVL, shares, share price | Keep |
| `CollateralStats` | outstanding/available collateral and caps | Keep |
| `CollateralAdmin` | pause/cap/admin controls | Keep |
| `DepositForm` / `WithdrawForm` | amount, approvals, tx state, limits | Keep |
| `ConfirmVaultActionDialog` | confirmation guard | Keep |
| `VaultActivity` | activity history | Keep |

## Changes Landed In This Pass

1. `CreateAgent` now opens with the Hyperliquid Perps mandate prefilled.
2. `CreateAgent` uses "Hyperliquid Perps" as the compact venue label so route/spec cells do not truncate the product category.
3. The Agents page no longer repeats selected-agent identity and account stats in both the middle dossier and right cockpit on wide desktop.
4. The Agents page keeps a recent-fill tape under the selected row, so traders retain execution context while the right cockpit owns account/routing facts.
5. Tests now defend the Hyperliquid default and the compact selected-agent table/dossier behavior.

## Remaining Watch Items

1. Provision remains the next 9+ target. It is comprehensive, but its configure step still has more mixed visual density than the terminal pages.
2. Home is dense by design. It has one app frame, but the page header plus pulse board plus chart header can still feel busy to a non-trader.
3. Vault screenshots are only fully meaningful with a deployed vault address. The current fail-closed behavior is correct.
4. Future Hyperliquid performance work should draw liquidation and margin bands onto the chart if the operator API exposes time-series risk history.

## Confidence

Overall confidence after this fourth pass: 9.0/10 for the public arena and specific-agent Hyperliquid workflow, 8.6/10 for the whole app because provisioning and vault polish still depend on broader product/data decisions.
