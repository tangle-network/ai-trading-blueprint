# AI Trading Arena Component Scorecard - 2026-06-03 second pass

## Rubric

Each visible surface was evaluated against four users:

- Hyperliquid trading user: wants market, side, size, leverage, PnL, liquidation/risk, fills, and live execution confidence.
- Crypto wallet user: wants wallet ownership, chain, address, signing state, custody/funds, and transaction safety.
- DeFi dapp user: wants vaults, deposits, withdrawals, collateral, pricing, network correctness, and failure honesty.
- AI app user: wants agent identity, mandate, reasoning, runs, chat, tools, validation, and operator control without toy prompt UI.

Scoring target: 9+ is shippable professional product quality, 8+ is credible and clean with known data/product limits, below 8 needs another design or data pass before launch.

## Global Shell

| Surface | Components and subcomponents | Persona fit | Data correctness | Verdict |
| --- | --- | --- | --- | --- |
| `ArenaAppShell` | Desktop sidebar, collapsed sidebar, mobile top bar, primary nav, account dock, wallet button, chain switcher, tx dropdown, theme toggle, skip link | Strong for crypto and DeFi users because wallet, chain, tx, and theme are always reachable; strong for AI/trading users because navigation maps to Arena, Agents, Activity, My Agents, Deploy, Create | Uses real wallet and chain controls from provider. No fake state | 8.8. Keep. This removes the prior stacked header problem: one desktop rail or one mobile strip, not multiple bars |
| `ArenaPageHeader` | Title, live dot, metrics, badge, child trust/detail row, command links | Strong for trading scanability. Metrics are dense and consistent across pages | Values come from route data. Uses `-` only where unavailable | 8.7. Keep. Shared header is the right primitive |
| `OperatorSessionBanner` and `OperatorAccessCard` | Auth banner, API URL list, locked states | Strong for wallet and AI operator users because private operator data is not silently faked | Fails closed behind operator auth | 8.5. Keep |
| Theme system | Dark/light terminal variables, hard-coded terminal-class remapping, semantic trade pills | Strong for all personas. Light theme now exists and is legible | Theme tokens are global and verified by screenshots | 8.6 before this pass, 8.9 after action-pill fix |

## Public Pages

| Route | Components and subcomponents | Why it makes sense | Data displayed | Score and action |
| --- | --- | --- | --- | --- |
| `/` Arena | Header metrics, `HeaderTrustBar`, `HomePulseBoard`, `PlatformVolumeChart`, `LatestAgentTrades`, `ArenaTopAgentsPanel`, auth/empty/loading states | Hyperliquid user gets latest fill, flow, top agent, volume chart. Crypto user sees trusted operator/evidence context. AI user sees agent competition state instead of marketing copy | Agent count, 30D volume, fills, network/mode/trust/operator/evidence, latest fill, 24H flow, top agent, live share | 8.7. Keep. Watch: if no public agents, empty state still uses older `glass-card` style but is not production critical |
| `/leaderboard` Agents | Header metrics, search, command links, `LeaderboardTable`, selected agent dossier, selected agent cockpit, recent fills, routing records | Strong trading scanner. It supports finding an agent, comparing activity, then drilling into performance/portfolio/runs/chat | 24H vol/fills/active count, ranking, account/NAV, return, fills, mode, trust, chain, operator, vault, service, recent fills | 8.8. Keep. The selected-agent cockpit is now the right dense trading pattern |
| `/activity` Activity | Compact header, metrics, command links, `LatestAgentTrades` explorer table, pagination, `FillInspector`, auth/empty/loading states | Strong for Hyperliquid and DeFi users because fills are first-class records, not decorative feed cards | Time, agent, fill side, market, USD, ref, mode, venue, status, price, input/output, source, score, reasoning IDs | 8.8 after trade-pill fix. Keep |
| `/arena` redirect | `ArenaRedirect` | Keeps legacy route from dead-ending | Redirects to `/` | 9.0. Keep |

## Owner And Creation Pages

| Route | Components and subcomponents | Why it makes sense | Data displayed | Score and action |
| --- | --- | --- | --- | --- |
| `/dashboard` My Agents | Connect wallet gate, header metrics, provision banner, services section, `ServiceCard`, My Agents section, `HomeBotCard`, operator-auth locked state, empty deployment path, `SecretsModal` | Correct owner control plane. Crypto wallet user sees owned services. AI user sees agent status/secrets. DeFi user sees vault and service attachment. It is no longer generic or off-brand | Services, active agents, NAV, trades, validator average, provisions, locked operator-managed agents, service groups, bot cards | 8.5. Keep. Watch: real connected wallet testing depends on wallet/provider state |
| `/create` Launch Agent | Header status strip, mandate text area, strategy compiler, envelope checks, route chips, strategy book, launch path ledger, readiness rows, live create status, deploy action | AI app user gets a compiler flow instead of a prompt toy. Hyperliquid user gets perps preset, leverage/liquidation buffer copy, replay/envelope/workspace path | Operator, chain, risk gate, inferred strategy profile, venue, replay step, envelope checks, launch path, readiness, operator errors | 8.7. Keep |
| `/provision` Deploy Agent | Wallet gate, deployment header, stepper, `BlueprintSelector`, `ConfigureStep`, wrong-chain banner, `DeployStep`, `SecretsStep`, `InfrastructureDialog`, `AdvancedSettingsDialog` | DeFi and crypto users get the real signing/quote/service/secret flow. AI users get blueprint, strategy pack, runtime, validator, schedule, execution target, and activation | Target chain, selected blueprint, step, operator count, quotes/costs, service mode, execution target, asset universe, collateral cap, AI provider/secrets, lifecycle errors | 8.4. Keep. Watch: visually older than Arena shell in places, but functionally comprehensive and not toy |

## Vault Pages

| Route | Components and subcomponents | Why it makes sense | Data displayed | Score and action |
| --- | --- | --- | --- | --- |
| `/vault/:address` invalid state | Header metrics, invalid address card, Arena link | DeFi user gets fail-closed address validation | Address invalid, chain blank, status blocked | 8.8. Keep |
| `/vault/:address` read state | Header metrics/address/chain, `VaultStats`, NAV pricing notice, `CollateralStats`, admin panel, error/connect/wrong-chain cards, `DepositForm`, `WithdrawForm`, `VaultActivity` | DeFi dapp user gets custody, shares, NAV, collateral, deposit/withdraw, activity. Crypto user gets chain correctness and wallet gating | TVL, share price, total shares, user shares, asset symbol/decimals, paused state, pricing safety, outstanding/available collateral, max collateral bps, deposit/withdraw limits, vault activity | 8.0. Keep. Watch: live screenshot honestly shows factory-address read failure where no vault contract is deployed. That is data truth, not visual polish |

## Agent Workspace Shell

| Surface | Components and subcomponents | Why it makes sense | Data displayed | Score and action |
| --- | --- | --- | --- | --- |
| `AgentWorkspaceShell` | Desktop agent rail, mobile header, identicon, account card, copy/explorer operator address, section nav, strategy/network/verified footer, focus mode for runs/chat | Right specific-agent dashboard structure. The user can see identity, account value, return, risk, fills, chain, operator address, and workspace sections without extra header bars | Account value, return, Sharpe, drawdown, fills with evidence title, status, paper/live, strategy, network, verification | 8.8. Keep. Watch: live API latency can briefly show `-` metrics |
| Workspace route controller | Legacy tab redirects, section routing, fallback bot resolution, operator auto-auth, command permission, envelope banner, secrets modal | Strong AI/operator model. Does not assume a bot exists; it resolves from store, provision, or operator detail | Bot details, strategy config, risk params, validation trust, operator features, commandability, secrets state | 8.7. Keep |

## Agent Workspace Tabs

| Route/tab | Components and subcomponents | Why it makes sense | Data displayed | Score and action |
| --- | --- | --- | --- | --- |
| `/arena/bot/:id/performance` | `PerformanceTab`, TradingView/lightweight chart, range control, NAV/market mode control, metrics strip, fill list, trade markers, decision feed, copilot panel, unverified notice | Hyperliquid user gets the right primary object: market/NAV chart with fills and PnL context. AI user gets decision feed and copilot | Equity/NAV, PnL, return, fills, high/low, candles, trade markers, market token, freshness, latest fill data, decision items | 8.5. Keep. Watch: chart dominates at first paint when fills are loading; acceptable but still the biggest path to 9+ |
| `/arena/bot/:id/portfolio` | `PortfolioWorkspace`, `PositionsTab`, `TradeHistoryTab`, positions ledger/cards, execution ledger, pager, expanded validation details | Hyperliquid user gets positions, margin, leverage, liquidation, PnL, and execution history. DeFi user gets token/vault account view | Equity, cash, notional, uPnL, market, side, size, margin, usage, leverage, liquidation, time, action, market, size, USD, ref, validation, simulation | 8.7 after trade-pill fix. Fixed invisible sell/short action labels in light theme |
| `/arena/bot/:id/runs` | `RunsTab`, run sidebar, live/completed/failed summary, run banner, transcript replay, trace cockpit, result summary, decision activity strip, decision inspector, run detail fallback | AI app user gets real run traces and tool/reasoning replay; trading user can map run to decision and signal | Run status, workflow kind, duration, tokens, signal, transcript, tools, result JSON, funding/trade/API wallet actions, decision items | 8.4. Keep |
| `/arena/bot/:id/chat` | `ChatTab`, session sidebar, new chat, rename/delete, auth gate, agent status, stop button, run banner, `ChatTranscript`, message input | AI app user gets an operational chat surface tied to the trading agent, not generic chat. Wallet user gets owner sign-in gating | Sessions, active run, transcript, reasoning/tool parts, stop state, input, auth state, secrets requirement | 8.5 after semantic fix. Fixed static agent-response headers rendering as inert buttons |
| `/arena/bot/:id/operations` overview | `OperationsWorkspace`, panel nav, command lanes, status cells, risk console, provenance/record sections | Operator user gets control plane: validation, revisions, controls, envelope, secrets, vault, terminal | Status, runtime, trust, mode, max drawdown, position cap, stop loss, validator score, trades, lifetime, operator/vault/service/workflow | 8.7. Keep |
| `/arena/bot/:id/operations?panel=validation` | `ReasoningTab`, decision feed, validation notices | AI/trading user gets auditability for why trades were approved/rejected | Validator score, simulation, reasoning, signatures, pending validation count | 8.4. Keep |
| `/arena/bot/:id/operations?panel=revisions` | `RevisionArenaTab` | AI app user sees revision/eval loop rather than static bot card | Candidate revisions, validation, promotion state | 8.2. Keep |
| `/arena/bot/:id/operations?panel=controls` | `ControlsTab`, status, lifetime, strategy/risk fields, provisioned settings, validator info, advanced controls | Crypto/AI operator gets mutable controls with auth and lifetime constraints | Active/paused state, strategy config, risk params, lifetime, paper/live, validators, instructions | 8.3. Keep |
| `/arena/bot/:id/operations?panel=envelope` | `EnvelopeTab`, status, sign/submit, revoke, fields | DeFi/crypto user gets explicit risk envelope signing instead of hidden agent permission | Envelope status, owner, chain, risk limits, mode, signature/submit state | 8.6. Keep |
| `/arena/bot/:id/operations?panel=secrets` | `SecretsTab` | AI operator gets provider secrets config and polling without leaking actual values | Provider, key presence, env vars, activation state, operator auth | 8.4. Keep |
| `/arena/bot/:id/operations?panel=vault` | `HyperliquidVaultTab` | Hyperliquid user gets vault settlement and withdrawal queue, which is the right perps-specific operation surface | Mode, subaccount/vault addresses, idle/accounting/pending assets, shares, settlement status, redeem, queue cancel/fulfill | 8.3. Keep. Watch: only useful for Hyperliquid vault-enabled bots |
| `/arena/bot/:id/operations?panel=terminal` | `TerminalTab`, `OperatorTerminalView` | AI/operator user gets live terminal where enabled, with auth gating | Terminal connection/auth state, unsupported feature state, operator URL | 8.1. Keep. Watch: feature depends on operator metadata |

## Shared Data Components

| Component | Subcomponents | Why it exists | Verdict |
| --- | --- | --- | --- |
| `LatestAgentTrades` | Panel feed, explorer table, pagination, fill inspector, action pill, market display, agent link | Core trading evidence component. It should be present on home/activity/performance | 8.8 after action-pill fix |
| `LeaderboardTable` | Agent rank rows, selection, activity stats, table columns | Core comparison component for agents | 8.6 |
| `PlatformVolumeChart` | Volume series, summary, live/paper breakdown | Core arena market-health component | 8.4 |
| `ArenaTopAgentsPanel` | Top-agent table/cards by activity | Secondary scanner for public arena | 8.3 |
| `PositionsTab` | Hyperliquid perp table/cards, standard token positions, empty/auth/error states | Core account risk component | 8.7 |
| `TradeHistoryTab` | Compact and full ledgers, pager, expanded details, validation/simulation rows | Core execution audit component | 8.7 after action-pill fix |
| `ChatTranscript` | Empty states, user bubbles, assistant run groups, tool/reasoning rows, failure state, scroll-to-bottom, input | Core AI agent transcript component | 8.5 after inert-button fix |
| `ConnectWalletPanel` | Wallet gate with bullets | Good crypto entry state | 8.4 |
| `ServiceCard`, `HomeBotCard`, `ProvisionsBanner`, `SecretsModal` | Owner services, agent summaries, provision lifecycle, secrets config | Correct My Agents subcomponents | 8.2 to 8.5 |
| Vault form components | `DepositForm`, `WithdrawForm`, `VaultStats`, `CollateralStats`, `CollateralAdmin`, `VaultActivity` | Correct DeFi vault primitives | 8.0 to 8.6 depending on live vault availability |

## Fixes Landed In This Pass

1. Terminal trade action pills now use semantic CSS classes instead of hard-coded arbitrary dark colors. This fixes invisible sell/short/close action labels in light theme and affects portfolio executions, activity explorer, and fill inspectors.
2. Chat transcript run headers no longer render non-collapsible assistant responses as inert buttons. Collapsible tool/reasoning runs remain buttons with `aria-expanded`.

## Remaining Watch Items

1. Live performance and portfolio screenshots can show skeletons while operator APIs are loading. Fixture screenshots prove the layout renders the right data once available; this is not fake-data masking.
2. The vault route is honest but only as useful as the address supplied. A factory or undeployed address correctly shows read failure rather than pretending a vault exists.
3. Performance chart is credible but still the biggest opportunity for a 9+ Hyperliquid-specific dashboard: add margin/liquidation bands and open-position overlays when live operator data exposes them.
4. Provisioning is comprehensive but visually a half-step behind the terminal shell. It is not toy quality, but it is the next page to fully normalize if another design pass is requested.

## Final Confidence

Overall product design confidence after this pass: 8.6/10.

The app now presents as a professional AI trading control plane rather than a toy leaderboard: public arena, owner dashboard, deployment, vault, and agent workspace all expose real trading/operator/wallet state and fail closed when data is unavailable.
