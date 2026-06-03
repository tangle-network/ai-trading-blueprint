# AI Trading Arena Third-Pass Component Rationale

Date: 2026-06-03
Base commit: 02a7e48
Ops task: #950

## Evaluation Method

Every visible route and major subcomponent was re-evaluated against four concrete users:

- Hyperliquid trading user: needs market, position, side, notional, margin, leverage, liquidation, fill timing, PnL, and execution confidence.
- Crypto wallet user: needs wallet ownership, active chain, address, signatures, transaction state, and fail-closed custody language.
- DeFi dapp user: needs vault/account state, deposits, withdrawals, collateral, price availability, network correctness, and honest read/write failures.
- AI app user: needs agent identity, mandate, tools, runs, reasoning, validation, controls, secrets, and terminal/operator state.

Decision rule: keep a component only if it answers one of those users' immediate questions. If it is decorative, generic, duplicated, or hides real state, it is a design debt item.

## Iteration Log

| Round | What was checked | Finding | Action |
| --- | --- | --- | --- |
| Previous session | Global shell, public pages, dashboard/create/provision, vault, agent workspace, shared tables | App moved from toy leaderboard toward real trading control plane; light theme and action-pill contrast were fixed | Kept as baseline |
| This pass, code scan | Route tree, shared shell, home, leaderboard, activity, performance, portfolio data contracts, tests | Theme remapping is intentional; most dark utility classes are remapped through `.arena-trace-terminal` | No broad color churn |
| This pass, product audit | Specific agent performance dashboard | The chart was credible but still too generic for a Hyperliquid trader; exposure/liquidation risk lived only on portfolio/operations surfaces | Added Hyperliquid exposure strip to performance page |
| This pass, screenshot audit | Fixture Hyperliquid dashboard | Initial strip counted Hyperliquid cash as perp exposure and produced impossible margin/notional relationship | Restricted exposure to perp-like rows and derived margin from explicit margin or notional/leverage |
| This pass, test audit | Existing `PerformanceTab` harness | Harness already covers chart/marker/candle behavior | Extended same suite with exact exposure-risk assertions |

## Route Inventory

| Route | Primary job | Component/subcomponent inventory | Persona rationale | Score after this pass |
| --- | --- | --- | --- | --- |
| `/` | Public arena pulse | `ArenaAppShell`, `ArenaPageHeader`, trust bar, pulse board, latest fill, 24H flow, top agent, platform chart, top agents, wallet/operator gates | Trader gets market activity and latest fill; crypto user sees chain/operator/evidence; DeFi user sees volume/trust context; AI user sees agents as live actors | 8.8 |
| `/leaderboard` | Agent comparison and selection | search, rank table, selected-agent dossier, cockpit, recent fills, nav to performance/portfolio/runs/chat | Trader can rank and inspect agents quickly; AI user can jump into run/chat context; wallet user sees operator/vault details | 8.8 |
| `/activity` | Fill explorer | compact metrics, `LatestAgentTrades` explorer, pagination, fill inspector, evidence/source fields | Trader gets the execution tape; DeFi user gets status and venue; AI user gets reasoning/decision ids | 8.8 |
| `/arena` | Legacy route | redirect | Prevents dead route | 9.0 |
| `/dashboard` | Owner control plane | wallet gate, page metrics, provisions, services, owned agent cards, secrets modal, operator lock states | Crypto user sees owned services and wallet-gated controls; AI user sees owned agents and secrets; DeFi user sees vault/service attachment | 8.5 |
| `/create` | Intent-to-agent launch | strategy book, mandate, inferred venue/risk/route, envelope readiness, deploy path | AI user gets a compiler-style flow; trader gets Hyperliquid preset and liquidation/risk language; wallet user sees launch prerequisites | 8.7 |
| `/provision` | Deployment and activation | blueprint selector, configure step, wrong-chain state, quote/deploy step, secrets step, infrastructure/advanced dialogs | DeFi and wallet users get real signing/quote/chain/secrets path; AI user gets runtime, model, strategy, validator configuration | 8.4 |
| `/vault/:address` | Vault read/write | invalid-address card, stats, collateral stats, admin controls, deposit/withdraw, activity, chain/error gates | DeFi user gets custody/share/collateral facts; crypto user gets chain correctness; failure states do not fake vault data | 8.0 |
| `/arena/bot/:id/performance` | Specific-agent trading dashboard | workspace shell, agent rail, chart header, market/NAV mode, range controls, chart, fills, decision inspector, copilot, new Hyperliquid exposure strip | Trader gets price/NAV/fills plus notional, margin, leverage, liquidation, and uPnL; AI user maps fills to decisions; crypto user sees authenticated/live state | 8.9 |
| `/arena/bot/:id/portfolio` | Positions and execution ledger | portfolio summary, perp/spot positions, margin, leverage, liquidation, execution ledger, validation details | Trader gets risk and fills; DeFi user gets account/asset view; AI user sees validation trail | 8.7 |
| `/arena/bot/:id/runs` | Agent trace/replay | run list, status summary, transcript replay, trace cockpit, decision activity, inspector | AI user gets real run evidence; trader can connect decisions to execution | 8.4 |
| `/arena/bot/:id/chat` | Operator chat | session list, new/rename/delete, run banner, transcript, input, auth/secrets gates | AI user gets operational chat, not a fake prompt box; wallet/operator gates are explicit | 8.5 |
| `/arena/bot/:id/operations` | Control plane | overview, validation, revisions, controls, envelope, secrets, vault, terminal | Operator gets all stateful actions in one shell; DeFi/wallet users get envelope/vault/secrets safety | 8.7 |

## Component Decisions

### Global Shell

| Component | Subcomponents | Keep/change decision |
| --- | --- | --- |
| `ArenaAppShell` | desktop rail, mobile bar, nav, wallet, chain switcher, theme toggle, tx dropdown, skip link | Keep. It fixes the old stacked-header problem by providing one persistent nav/control frame |
| `ArenaPageHeader` | title, live dot, metrics, command links, trust/detail row | Keep. Shared density and hierarchy make pages feel branded |
| `OperatorAccessCard` / `OperatorSessionBanner` | locked states, API URL, auth status | Keep. Data is fail-closed instead of silently mocked |
| Theme remapping | terminal variables, arbitrary-color remaps, semantic trade pills | Keep. Light mode is supported through variables while limiting churn in existing components |

### Public Arena Components

| Component | Subcomponents | User value | Decision |
| --- | --- | --- | --- |
| `HomePulseBoard` | latest fill, 24H flow, top agent, platform volume | Fast scan for traders and crypto users | Keep |
| `PlatformVolumeChart` | volume series, live/paper split, summary | Arena market-health proof | Keep |
| `LatestAgentTrades` | panel feed, explorer table, pagination, fill inspector | Core execution evidence | Keep |
| `ArenaTopAgentsPanel` | rank rows/cards, activity metrics | Secondary scanner | Keep |
| `LeaderboardTable` | rank, agent, strategy, NAV, return, fills, mode | Primary agent comparison | Keep |
| `SelectedAgentDossier` / `SelectedAgentCockpit` | identity, status, trust, recent fills, links | Makes the agents page feel like a product cockpit | Keep |

### Owner and Provision Components

| Component | Subcomponents | User value | Decision |
| --- | --- | --- | --- |
| `ConnectWalletPanel` | wallet gate, bullets | Correct crypto entry state | Keep |
| `ServiceCard` | service state, operator, agents, links | Owner can manage provisioned infra | Keep |
| `HomeBotCard` | owned agent status, metrics, links | Owner sees deployed agents | Keep |
| `ProvisionsBanner` | deployment lifecycle | Prevents hidden async provisioning | Keep |
| `SecretsModal` / `SecretsStep` | provider key state, activation | AI app user can make agent runnable | Keep |
| `BlueprintSelector` | blueprint/runtime selection | AI/DeFi user can choose deployment target | Keep |
| `ConfigureStep` | strategy pack, runtime, execution target, risk fields | Strong data model; visually next in line for polish | Keep, watch |
| `DeployStep` | quotes, chain, tx state | Wallet user gets real transaction path | Keep |
| `InfrastructureDialog` / `AdvancedSettingsDialog` | operator/runtime details | Useful advanced controls | Keep |

### Agent Workspace Components

| Component | Subcomponents | User value | Decision |
| --- | --- | --- | --- |
| `AgentWorkspaceShell` | agent rail, mobile header, identicon, account card, explorer links, section nav | Gives specific-agent dashboard a branded terminal frame | Keep |
| `BotHeader` | agent status, identity, metrics | Immediate context | Keep |
| `PerformanceTab` | chart, stats, range/mode controls, fills, decision inspector, copilot | Main trading page. Improved this pass with exposure/liquidation strip | Changed |
| `TradingPerformanceChart` | lightweight-charts market/NAV chart, candles, volume, markers, coverage badge | Correct charting engine and evidence overlay | Keep |
| `PortfolioWorkspace` / `PositionsTab` | perp cards/table, margin, leverage, liquidation, token positions | Core risk ledger | Keep |
| `TradeHistoryTab` | compact/full fills, validation, simulation | Execution audit | Keep |
| `RunsTab` | run list, transcript, decision feed, result detail | AI traceability | Keep |
| `ChatTab` / `ChatTranscript` | session state, reasoning/tool rows, input | AI operator surface | Keep |
| `OperationsWorkspace` | panel nav, control sections | Operator console | Keep |
| `ReasoningTab` | validation/decision feed | AI/trading audit | Keep |
| `RevisionArenaTab` | revision/eval loop | AI improvement loop | Keep |
| `ControlsTab` | status, risk, lifecycle, validator fields | Operator control | Keep |
| `EnvelopeTab` | sign/submit/revoke risk envelope | DeFi/wallet safety primitive | Keep |
| `SecretsTab` | provider secrets state | AI runtime prerequisite | Keep |
| `HyperliquidVaultTab` | vault/share/accounting/settlement/withdraw queue | Hyperliquid-specific DeFi state | Keep |
| `TerminalTab` / `OperatorTerminalView` | live terminal/auth/unsupported states | Advanced operator capability | Keep |

### Vault Components

| Component | Subcomponents | User value | Decision |
| --- | --- | --- | --- |
| `VaultStats` | TVL, share price, shares | DeFi custody facts | Keep |
| `CollateralStats` | outstanding/available collateral, caps | Risk/collateral visibility | Keep |
| `CollateralAdmin` | pause/cap/admin operations | Owner controls | Keep |
| `DepositForm` / `WithdrawForm` | amount, approvals, tx state, limits | Wallet-user write path | Keep |
| `ConfirmVaultActionDialog` | confirmation state | Prevents accidental funds movement | Keep |
| `VaultActivity` | transaction/activity history | DeFi audit trail | Keep |

## Change Landed In This Pass

`PerformanceTab` now surfaces a Hyperliquid exposure strip for perp agents:

- `Perp Risk`: pending, no open perps, or open position count.
- `Notional`: summed open perp notional from live portfolio positions.
- `Margin Use`: margin divided by live account equity.
- `Max Lev`: maximum open-position leverage.
- `Nearest Liq`: nearest liquidation price plus distance from current price.
- `uPnL`: summed unrealized PnL with positive/negative tone and stale/live copy.

The strip intentionally excludes Hyperliquid cash rows. Margin is taken from explicit `marginUsedUsd`, then derived from `notionalUsd / leverage` if necessary, and only falls back to position value when that value does not exceed notional.

Why this matters: a Hyperliquid trader does not judge a strategy dashboard only by chart shape. They need to know whether the agent is carrying exposure, how much margin it is consuming, how close it is to liquidation, and whether the account is making or losing money right now.

## Remaining Watch Items

1. Provisioning remains functionally comprehensive but visually less tight than the terminal workspace. It should be the next polish target if the mandate is to push every route from high-8 to 9+.
2. Vault route quality depends on using a deployed vault address. The current behavior is correct: invalid or undeployed addresses show explicit failure instead of fake numbers.
3. Performance chart can reach a stronger 9+ later by drawing liquidation/margin bands directly on the chart when the operator API provides time-series risk history. The strip added here is the right first step because it uses data already available today.

## Confidence

Overall confidence after this pass: 8.8/10.

The public pages, owner pages, vault pages, and specific-agent workspace now consistently answer real trading, wallet, DeFi, and AI-operator questions. The specific-agent performance route moved from "credible chart" toward "professional Hyperliquid trading dashboard" by surfacing live exposure and liquidation risk without inventing data.
