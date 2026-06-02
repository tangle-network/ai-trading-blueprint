# AI Trading Arena Workspace Redesign Tracker

Status: in progress  
Owner: claude  
Created: 2026-06-01  
Primary surface: `arena/`  
Reference apps: `/home/drew/code/gtm-agent`, `/home/drew/code/creative-agent`  

## Executive Summary

The arena should stop behaving like a marketing leaderboard page with a bot detail page attached after the fact. The target product is a sidebar-driven trading workspace: global navigation on the left, agent context persistent when an agent is selected, one primary work surface at a time, and no body scrolling for core workflows on desktop. This rewrite keeps the existing live APIs, auth hooks, TradingView Lightweight Charts dependency, operator telemetry, and bot data model, but replaces the route/layout composition that is currently producing header overload, inconsistent tab history, wasted space, and weak chart/trade correlation.

## Direct Diagnosis

The current UI is trying to show everything, so nothing feels important. The agent detail page should feel like a trading terminal with an AI operator attached; right now it feels like a stack of cards, tabs, and telemetry surfaces competing for attention. The chart is the highest-impact gap: it says “performance,” but it does not behave like a professional trading chart, and the trade markers can make an active bot look inactive because they collapse real trades onto sparse NAV checkpoints. The fix is not another round of padding tweaks. The fix is to promote the arena into an actual app shell, make navigation route-native, and let the selected workflow own the viewport.

## Current Diagnosis

### Layout Problems

- `arena/src/root.tsx` renders a fixed top `Header` for all non-immersive pages and adds top padding to `main`. Chat/Runs special-case themselves through query string inspection instead of real route semantics. This is the core layout smell.
- `arena/src/components/layout/Header.tsx` is a top nav with `Leaderboard`, `Home`, and `Deploy`. It works for a simple site, but this is no longer a simple site. A trading cockpit needs horizontal and vertical space for data, not a generic website header.
- `arena/src/routes/arena.bot.$id.tsx` owns both data loading and UI state. It uses `?tab=` query params, a `from=` param, an immersive branch for Chat/Runs, and a separate normal branch with `TabsContent`. This is why navigation feels inconsistent: the URL is not the workspace model; it is a tab state machine pretending to be navigation.
- `arena/src/components/bot-detail/BotHeader.tsx` is sticky, metric-heavy, and horizontally scrolls the section nav. It duplicates the global header problem inside the agent page.
- `arena/src/components/bot-detail/PerformanceTab.tsx` renders the core chart, a right-side trade tape, a checkpoint readout, and summary cards below the fold. This prioritization is wrong. Professional trading performance should own the screen, and secondary context should support it.
- `arena/src/components/bot-detail/PositionsTab.tsx` and `TradeHistoryTab.tsx` are separate surfaces even though they are one workflow: current exposure plus execution history.
- `arena/src/components/bot-detail/ControlsTab.tsx`, `EnvelopeTab.tsx`, `SecretsTab.tsx`, `ReasoningTab.tsx`, `RevisionArenaTab.tsx`, and `TerminalTab.tsx` are separate top-level tab destinations. This creates a loosely grouped set of admin surfaces instead of a coherent operations page.

### Chart/Data Problems

- `PerformanceTab.tsx` builds `chartPoints` from `/metrics/history` snapshots and then maps trades onto the nearest chart point. If a bot has 49 trades but only two or three metric snapshots, many trades collapse into one or two visible markers. That makes the bot look less active than it is, which is a product bug, not a presentation issue.
- `TradingPerformanceChart.tsx` currently renders an `AreaSeries` of account value. This is useful for NAV, but it does not look or behave like a professional Hyperliquid-style trading chart where price candles, fills, positions, and order/execution context are the primary visual language. We need the chart to feel like a real trading system, not a dashboard sparkline that got stretched.
- Existing backend capabilities already include candle infrastructure:
  - `trading-http-api/src/routes/candles.rs` exposes `/market-data/candles` and `/market-data/candles/fetch`.
  - `trading-runtime/src/candle_sources/mod.rs` dispatches venue candle sources, including Hyperliquid, Binance, Coinbase, Drift, Polymarket, and GeckoTerminal.
  - The arena frontend currently has no `useBotMarketCandles` hook and no chart mode that uses those candles.

### Reference App Patterns To Reuse

- GTM agent shell:
  - `/home/drew/code/gtm-agent/src/routes/app.tsx` uses `h-screen flex-col overflow-hidden`.
  - `/home/drew/code/gtm-agent/src/routes/app.workspace.tsx` uses an `IconRail`, optional `ThreadBrowser`, and `main` with `overflow-hidden`.
  - `/home/drew/code/gtm-agent/src/components/icon-rail.tsx` gives the core sidebar pattern: fixed left rail, compact nav, active route state.
- Creative agent shell:
  - `/home/drew/code/creative-agent/src/routes/app.workspace.tsx` uses a `w-52` fixed sidebar with `NavLink`s and a `main` that fills the remaining viewport.
  - The route model is direct and readable: chat, studio, sequences, tasks, proposals, vault, terminal, settings.

## Product Decision

Adopt a workspace shell, not more tabs.

Primary navigation should be route-driven:

- `/` or `/leaderboard`: leaderboard
- `/dashboard`: home / fleet overview
- `/provision`: deploy an agent
- `/create`: deploy from chat
- `/arena/bot/:id`: agent workspace defaulting to performance
- `/arena/bot/:id/performance`: full-screen performance terminal
- `/arena/bot/:id/portfolio`: positions + trades
- `/arena/bot/:id/runs`: full-screen trading runs
- `/arena/bot/:id/chat`: full-screen agent chat
- `/arena/bot/:id/operations`: validation, revision, controls, terminal, envelope, secrets

Do not keep `?tab=` as the primary navigation model. Query params are acceptable for chart range, selected trade, and panel mode, but not for workspace sections.

## Target UX

### Global Shell

Desktop:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  left sidebar  │                    active workspace                         │
│                │                                                            │
│  Home          │  Leaderboard / Dashboard / Deploy / Agent workspace          │
│  Leaderboard   │                                                            │
│  Deploy Agent  │  Body does not scroll for core workspace routes.             │
│                │  Individual tables/transcripts can scroll internally.        │
│  Agents        │                                                            │
│   BTC agent    │                                                            │
│   WETH agent   │                                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

Mobile:

- Keep a compact top bar or bottom nav. No fixed 220px sidebar.
- Chart and transcripts can stack vertically, with internal scrolling only.

### Performance Layout Alternatives — 1280px to 1440px

The current breakpoint still spends too much width on chrome at the exact desktop sizes where a trading chart should feel powerful. At 1280px and 1440px, the global sidebar plus agent rail consume almost a third of the viewport before the chart is drawn. Five options were considered against Hyperliquid-style trading UX, professional desktop trading terminals, and the GTM/creative agent workspace shell pattern:

1. **Winner: Collapsed Agent Rail + Header Subnav**

```text
┌ global sidebar ┬ agent strip: name · metrics · section nav ┐
│                ├──────────────────────────────┬────────────┤
│ agents/home    │ large market chart            │ copilot    │ 1440+
│                │ chart                         │ dock below │ 1280
└────────────────┴──────────────────────────────┴────────────┘
```

Score: 9/10. This is the best tradeoff because it reclaims 224px for the actual trading surface without losing agent context or route-native navigation. It mirrors how real trading apps prioritize the market surface while keeping account/context controls in compact chrome.

2. **Permanent Dual Sidebars**

```text
┌ global sidebar ┬ agent rail ┬ chart ┬ copilot/tape ┐
└────────────────┴────────────┴───────┴──────────────┘
```

Score: 6/10. Stable and discoverable, but the chart feels too narrow at 1280-1440. This is closer to an admin console than Hyperliquid.

3. **Icon-Only Agent Rail**

```text
┌ global sidebar ┬ icons ┬ chart ┬ copilot/tape ┐
└────────────────┴───────┴───────┴──────────────┘
```

Score: 7/10. Better than a full rail, but still spends permanent width on navigation that users only need intermittently. It also hides labels at the moment the product still needs clarity.

4. **Full-Screen Chart With Drawer**

```text
┌ global sidebar ┬ chart fills all remaining space ┐
│                │ drawer overlays copilot/tape    │
└────────────────┴─────────────────────────────────┘
```

Score: 8/10 for power users, 5/10 for general users. It maximizes chart area but hides the live agent narrative, which is one of this product's differentiators.

5. **Bottom Command Dock Everywhere**

```text
┌ global sidebar ┬ chart above                         ┐
│                ├ copilot / tape / readout below      │
└────────────────┴─────────────────────────────────────┘
```

Score: 7/10. Good at 1280, weak at 1440+ because it wastes the horizontal room where a right-side tape/copilot panel should live.

Decision: implement option 1. Keep the full agent rail only on very wide screens, add a compact subnav inside the agent header below that, and increase the sub-1360 Performance dock height so owner copilot and public tape are readable instead of technically present.

### Homepage Layout Alternatives — Fleet Command Center

The homepage has a different job than the agent workspace: it should make platform activity obvious in the first viewport. The strongest references are exchange dashboards and Hyperliquid-style execution views: primary volume/liquidity surface, live tape, then ranked markets/agents. Five options were considered:

1. **Winner: Volume Command Center + Right Execution Tape**

```text
┌ global sidebar ┬ fleet header + KPI strip                         ┐
│                ├ platform volume chart         ┬ latest trades tape│
│                ├ leaderboard controls          ┴──────────────────┤
│                └ ranked agents table/cards                         │
└────────────────┴───────────────────────────────────────────────────┘
```

Score: 9/10. This makes the live platform obvious immediately: how much is trading, what just traded, which agents are active. It matches exchange mental models while preserving the arena leaderboard workflow.

2. **Leaderboard-First With Volume Above Fold**

```text
┌ KPIs ┐
├ leaderboard table ┬ compact volume ┐
└ latest trades below               ┘
```

Score: 7/10. Good for rankings, weaker for “is this live and interesting?” because trades and volume become secondary.

3. **Three-Column Ops Wall**

```text
┌ agents ┬ volume ┬ trades/runs ┐
└ stats  ┴ chart  ┴ activity    ┘
```

Score: 7/10. Dense and powerful, but it becomes cramped at 1280px and risks feeling like an internal admin screen.

4. **Single Massive Volume Chart**

```text
┌ giant platform volume chart ┐
├ latest trades row           ┤
└ leaderboard                 ┘
```

Score: 8/10 visually, 6/10 product-wise. It looks premium but hides the agent/tape story that differentiates the platform.

5. **Agent Cards Hero**

```text
┌ top 3 agents cards ┐
├ volume             ┤
├ trade tape         ┤
└ table              ┘
```

Score: 6/10. It over-indexes on leaderboard gamification and underplays platform-level execution health.

Decision: implement option 1. Put `PlatformVolumeChart` and `LatestAgentTrades` into a first-viewport command grid, add compact chart/tape variants, and keep the leaderboard below as the deeper ranking surface.

### Agent Performance

Desktop target:

```text
┌───────────────┬──────────────────────────────────────────────┬───────────────┐
│ global sidebar │ agent header strip                           │ copilot/tape   │
│               ├──────────────────────────────────────────────┤               │
│ agent nav      │ Hyperliquid-style chart                      │ if whitelisted │
│ Performance    │ - candles when market data exists            │ chat composer  │
│ Portfolio      │ - NAV overlay                                │ else trade tape│
│ Runs           │ - buy/sell/fill markers at real timestamps   │               │
│ Chat           │ - 7D/30D/1Y range                            │               │
│ Operations     │ - crosshair, date axis, visible fills        │               │
└───────────────┴──────────────────────────────────────────────┴───────────────┘
```

The chart should support two first-class modes:

- `Market`: venue price candles plus trade markers. This is the professional trading view.
- `NAV`: portfolio/account value over time with drawdown and checkpoint annotations.

The default should be `Market` when candles exist for the traded instrument and `NAV` otherwise.

### Hyperliquid Trade Page Recon — 2026-06-02

Reference captured with the site-clone workflow against `https://app.hyperliquid.xyz/trade`:

- Rendered screenshot: `.evolve/hyperliquid-trade-recon/reference-1440x900.png`
- Computed style/token extraction: `.evolve/hyperliquid-trade-recon/reference.json`
- Captured state: `71.538 | HYPE | Hyperliquid`, 1440x900 viewport, 585 visible elements.

Extracted design facts:

- The reference uses one app font stack for almost everything: `OurFont, system-ui, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif`.
- Most text is only `12px` or `16px`; the premium feel comes from density and hierarchy, not huge type.
- Primary surface colors are low-contrast exchange blacks and blue-greens: body `rgb(48,48,48)`, panels around `rgb(15,26,31)`, active controls around `rgb(39,48,53)`, positive `rgb(80,210,193)`, negative `rgb(237,112,136)`, muted labels `rgb(148,158,156)`.
- Border radius is usually `0px`, `5px`, or `8px`, not large rounded cards.
- The chart owns the center. Header metrics, order book, trade form, and positions are thin strips/panels around it. There are almost no explanatory subtitles.
- The order book/trade form are not glassy. They are flat, dense, dark panels with subtle dividers and compressed rows.

Chart redesign alternatives after recon:

1. **Winner: Exchange Terminal Strip**

```text
┌ symbol + checkpoint ┬ Price ┬ H/L ┬ Vol ┬ PnL ┬ Fills ┬ mode/range ┐
├─────────────────────────────────────────────────────────────────────┤
│ full dark TradingView candle/NAV chart, no card-stat layer           │
└─────────────────────────────────────────────────────────────────────┘
```

Score: 9/10. This directly fixes the toy problem. It removes the dashboard-card layer, makes the chart materially larger, keeps controls in a single exchange-style strip, and uses Hyperliquid-like colors/radii without copying branding or assets.

2. **Chart + Orderbook Rail**

```text
┌ symbol strip ┐
├ chart ┬ synthetic orderbook/depth ┐
└───────┴───────────────────────────┘
```

Score: 8/10 future, 5/10 today. It would feel more like Hyperliquid, but we do not yet have normalized orderbook/depth across Hyperliquid, Polymarket, DEX spot, and custom venues. Adding fake depth would be worse than the current chart.

3. **All-In Full-Screen Chart**

```text
┌ chart fills everything ┐
└ hover/drawer for fills ┘
```

Score: 8/10 for power users, 6/10 for the arena. It maximizes price action, but it hides the agent’s execution narrative, which is a core differentiator.

4. **TradingView Native Shell**

```text
┌ TV-like toolbar ┐
├ chart           ┤
└ indicators      ┘
```

Score: 7/10. Familiar, but it would make the product feel like an embedded chart widget rather than an agent trading cockpit. It also adds toolbar chrome before we have enough indicator controls to justify it.

5. **Dashboard Card Upgrade**

```text
┌ title + stat cards ┐
├ improved chart     ┤
└ fills card         ┘
```

Score: 4/10. This is close to the current failure mode. Better colors would help, but the structure would still read like a SaaS dashboard, not a professional trading venue.

Decision: implement option 1 now. Keep the existing `lightweight-charts` renderer and venue candle hooks, but make the surrounding Performance surface act like an exchange terminal: dark flat panel, compact symbol strip, inline metrics, tighter controls, larger chart, subtler grid, no visible chart attribution chip, compact NAV marker, and a matching dark execution rail.

### Performance Execution Rail Alternatives — Fill Evidence + Agent Rationale

After the first TradingView chart pass, the chart was credible but the right rail still read like a generic “recent trades” table. That is not enough for a quant/trading workspace. The right rail should answer “what did the agent just do, why did it do it, what venue/instrument/size was touched, and did execution clear validation?” without requiring the user to leave the chart.

The benchmark pattern is Coinbase Advanced / Kraken Pro / Hyperliquid: the primary chart is paired with live execution context, order/depth context, and position/fill state. For prediction markets, Polymarket adds a different requirement: the event/question and outcome side must be visible before raw token identifiers because the market’s semantic object is the outcome, not just the token.

Five alternatives were considered:

1. **Winner: Execution Decision Rail**

```text
┌ selected fill inspector: side / instrument / notional / thesis ┐
├ validation + execution stages                                  ┤
└ fill ledger: large side badge / token logos / market / size     ┘
```

Score: 9/10. It keeps the chart central while making every fill inspectable. It also reuses the existing `DecisionInspector` and `TradeInstrumentDisplay` path, so runs, chat, portfolio, and performance converge on one decision model instead of fragmenting.

2. **Classic Exchange Orderbook Rail**

```text
┌ orderbook/depth ┐
├ latest fills    ┤
└ selected fill   ┘
```

Score: 8/10 once live orderbook depth is available across venues, 5/10 today. The backend has candles and trades, but not a normalized cross-venue orderbook/depth surface ready for all supported instruments.

3. **Copilot-First Rail**

```text
┌ agent chat / transcript ┐
└ latest fills compressed ┘
```

Score: 7/10 for owners, 5/10 for public users. The agent narrative is differentiated, but a trading terminal cannot hide fills behind chat. Owners should get copilot, but not at the cost of visible execution evidence.

4. **Trade Table Rail**

```text
┌ table: time / side / instrument / notional ┐
└ selected row expands inline                ┘
```

Score: 6/10. Familiar but too small at 380-420px width, and it recreates the old clipped-table aesthetic the redesign is trying to leave behind.

5. **Event Timeline Rail**

```text
┌ market event ┐
├ agent thought┤
├ validation   ┤
└ execution    ┘
```

Score: 8/10 future state, 6/10 today. This will be strongest once the backend has a canonical market-event + agent-decision + execution event stream. Today, the reliable normalized object is still the trade/run decision item.

Decision: implement option 1 now. Keep all side-panel data backed by existing trades and decision items. Do not invent orderbook/depth placeholders until those feeds are normalized and available for every venue.

### Portfolio

Combine positions and trades into one workspace:

- Top: account equity, cash, margin usage, open risk, unresolved warnings.
- Middle: positions table.
- Bottom/right: trades table.
- Row click opens an execution drawer, not an expanded row that destroys table rhythm.

### Portfolio Layout Alternatives — Exposure + Execution Ledger

The latest fixture shows Portfolio is functionally correct but visually still below the trading-terminal bar. The left positions pane squeezes a wide perps table into a narrow column, creating horizontal scroll and clipped notional columns. The page should answer “what am I exposed to, what just traded, and what risk is unresolved?” without requiring a horizontal table hunt. Five layouts were considered:

1. **Winner: Stacked Exposure Cockpit + Execution Ledger**

```text
┌ exposure summary cards: equity / positions / cash / margin ┐
├ open exposure cards: perps and spot assets, no horizontal scroll ┤
└ execution ledger: large time/action/trade rows + expandable evidence ┘
```

Score: 9/10. This matches trading apps where exposure is a compact account readout and executions are the main ledger. It removes the bad squeezed-table behavior while preserving all existing detail inside drill-down rows and cards.

2. **Side-by-Side Portfolio/Trades Split**

```text
┌ positions table ┬ trades table ┐
└─────────────────┴──────────────┘
```

Score: 6/10. Good on 1600px+ screens, weak at 1280-1440 because both panes become compromised. This is the current failure mode.

3. **Positions-First Table With Trades Drawer**

```text
┌ large positions table ┐
└ trades open in drawer ┘
```

Score: 7/10. Useful for portfolio managers, but this product is agent-observability heavy. Hiding executions makes the live agent less interesting.

4. **Trade Tape First With Exposure Sidebar**

```text
┌ execution ledger ┬ exposure sidebar ┐
└──────────────────┴──────────────────┘
```

Score: 8/10 for active scalpers, 6/10 for slower strategies. Strong visual momentum, but current position/risk state becomes secondary.

5. **Tabbed Exposure / Trades Inside Portfolio**

```text
┌ portfolio nav: exposure | trades | validation refs ┐
└ selected table/card surface                         ┘
```

Score: 5/10. It would reduce density but reintroduces the tab problem we just removed at the route level.

Decision: implement option 1, then revise the desktop execution after screenshot review. The first implementation stacked exposure above the ledger and fixed table clipping, but at 1440x900 and 1280x800 it pushed the execution ledger below the first viewport. Final layout keeps the same data model but renders a two-column desktop cockpit:

```text
┌ exposure rail: summary + risk cards, internal scroll ┬ execution ledger: visible fills, internal scroll ┐
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────┘
```

This is the stronger trading workflow: exposure remains readable, but executions are visible immediately. `PositionsTab` now has a workspace rail density so the full tabular detail remains available outside the workspace while the agent cockpit gets compact exposure cards.

### Runs

Runs is a full viewport operations transcript:

- Left rail: run list, status, timestamp, duration.
- Main: full messages/tool calls/thinking/actions.
- Right inspector: selected run metadata, artifacts, strategy revision, trade side effects.

### Chat

Chat is a full viewport agent conversation:

- Owner/whitelisted user: chat transcript plus composer.
- Public/non-whitelisted user: read-only transcript if available; otherwise show live trade tape and agent state without explanatory filler.
- No normal bot header above it.

### Operations

Operations is a control and audit workspace, not an unstructured collection:

- Runtime: operator, service, status, sync, network, version.
- Safety: risk limits, envelope state, permissions, secrets status.
- Validation: validator history and pending issues.
- Revision: current/live/candidate revisions and promotion status.
- Terminal: embedded terminal only when allowed; otherwise hidden or explicit unavailable state.

### Operations Layout Alternatives — Trading Control Plane

The current Operations route opens directly into the Validation panel. In the latest fixture it produced a mostly empty loading surface, which makes the agent look dormant even when the system has important state to explain: envelope required, secrets status, operator source, paper/live posture, vault wiring, control availability, and terminal capability. Five layouts were considered:

1. **Winner: Overview Cockpit + Drill-Down Panels**

```text
┌ operations rail ┬ runtime / policy / capital / access tiles ┐
│ overview        ├ urgent actions + audit refs               │
│ validation      ├ validation / revisions / envelope cards   │
│ revisions       └ selected drill-down opens in same surface  │
└─────────────────┴────────────────────────────────────────────┘
```

Score: 9/10. Best for expert users because it answers “is this agent safe, live, configured, and controllable?” before asking them to choose a subtool. This matches exchange/admin control planes where health and blockers are visible first, with detailed drawers/panels one click away.

2. **Validation-First Rail**

```text
┌ rail ┬ validation evidence panel ┐
└──────┴───────────────────────────┘
```

Score: 5/10. This is the current model. It is technically simple but opens to a spinner/empty state and hides the most urgent operational state.

3. **Four-Quadrant Ops Wall**

```text
┌ validation ┬ revisions ┐
├ controls   ┼ envelope  ┤
└ secrets/vault/terminal ┘
```

Score: 7/10. Dense and powerful, but it would embed too many heavy lazy panels at once and risks loading the terminal/envelope/secrets stack unnecessarily.

4. **Timeline-First Audit Log**

```text
┌ event timeline ┬ selected event inspector ┐
└────────────────┴──────────────────────────┘
```

Score: 8/10 once the backend emits a unified ops-event stream, 4/10 today. The current API has useful panel-specific data but not one canonical operations event log.

5. **Owner Control Console**

```text
┌ controls/actions ┬ terminal/secrets ┐
└ validation below ┴ revisions below  ┘
```

Score: 6/10. Useful for operators, but too action-heavy for public viewers and weaker for the product’s core safety/audit story.

Decision: implement option 1. Make Operations default to Overview, keep all existing drill-down panels lazy-loaded, and make urgent blockers/actions obvious without waiting for panel data.

## Architecture

### Before

```text
root.tsx
├─ fixed Header unless ?tab=runs/chat
├─ route outlet
│  ├─ _index.tsx leaderboard page
│  ├─ dashboard.tsx
│  ├─ provision.tsx
│  └─ arena.bot.$id.tsx
│     ├─ query param tab router
│     ├─ special immersive Chat/Runs branch
│     ├─ sticky BotHeader
│     └─ Tabs/TabsContent for every bot surface
└─ Footer unless ?tab=runs/chat
```

### After

```text
root.tsx
└─ ArenaAppShell
   ├─ ArenaSidebar
   │  ├─ Home
   │  ├─ Leaderboard
   │  ├─ Deploy Agent
   │  └─ Agent roster / recent agents
   └─ workspace outlet
      ├─ Dashboard
      ├─ Leaderboard
      ├─ Deploy
      └─ AgentWorkspaceShell
         ├─ AgentSidebar / AgentHeaderStrip
         └─ outlet
            ├─ PerformanceWorkspace
            ├─ PortfolioWorkspace
            ├─ RunsWorkspace
            ├─ ChatWorkspace
            └─ OperationsWorkspace
```

## Implementation Tracker

### Progress — 2026-06-01

- Completed the first route-native workspace pass:
  - `root.tsx` now renders `ArenaAppShell` instead of the fixed marketing header/footer shell.
  - Added route aliases for `/arena/bot/:id/performance`, `/portfolio`, `/runs`, `/chat`, and `/operations`.
  - Legacy `?tab=` bot links redirect into the new route model for compatibility.
  - Agent navigation now uses `AgentWorkspaceShell` with persistent agent identity, operator address, status, strategy, return, Sharpe, max drawdown, trades, and equity.
  - Added `arena/scripts/smoke-agent-workspace.mjs` plus `pnpm --dir arena smoke:agent-workspace` to browser-smoke agent workspaces for body scroll, populated-data, and route-history regressions.
- Completed the first workspace composition pass:
  - `PortfolioWorkspace` combines positions and trade history.
  - `OperationsWorkspace` composes validation, revisions, controls, envelope, secrets, Hyperliquid vault, and terminal into one vertical operations surface.
  - Runs and Chat are route-native full-height surfaces with the normal bot header hidden.
  - Runs now exposes compact `Run ID` metadata in the full-height transcript header so a visible trace can be tied back to the persisted run record without scrolling to a fallback detail panel.
- Fixed the visible trade-count/chart-marker bug:
  - `PerformanceTab` now emits trade markers with their own timestamps instead of checkpoint indexes.
  - `TradingPerformanceChart` inserts synthetic time-scale points for trade timestamps so dense trades are not collapsed onto sparse metric snapshots.
  - Added a regression test where 49 trades across two metrics produce 49 chart markers.
- Tightened the performance workspace:
  - Removed bottom summary-card overflow.
  - Chart, stats, checkpoint readout, and trade tape now fit as one full-height workspace with internal scrolling.
- Added homepage platform-volume analytics:
  - `PlatformVolumeChart` renders 1D / 7D / 30D / 6M / 1Y volume controls.
  - Modes: bucket volume (`Hourly` for 1D, `Daily` otherwise), 7D rolling volume, and cumulative volume.
  - Added `trading-http-api` store-level `/platform/volume` aggregation across all persisted trades for the operator.
  - Added fleet and instance operator API `/api/platform/volume`, so homepage volume can query each configured operator once instead of walking every bot.
  - `usePlatformVolumeSeries` now prefers operator aggregate buckets across every configured trading operator URL, not only one Hetzner operator.
  - Per-bot `/trades` pagination remains only as compatibility fallback for older deployed operators that do not yet expose the aggregate route.
  - Added `VITE_TRADING_OPERATOR_API_URLS` and `VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS` so production can include non-Hetzner operator API endpoints without another code deploy. The URL list is normalized, deduped, and included in the deployment fingerprint so stale local caches do not cross deployments.
  - Volume uses priced USD notional from trade history and splits live vs paper notional.
  - Coverage displays fetched agents/operators so the UI is honest while release versions roll forward.
- Improved homepage dashboard density:
  - Converted the oversized hero into a compact command strip plus telemetry tiles.
  - Reduced the platform-volume empty chart height and replaced the dead blank area with a trading-grid empty state.
  - Moved platform volume and latest trades into a first-viewport command grid: the left side owns platform notional, the right side is the execution tape, and the leaderboard remains below as the ranking surface.
  - Tightened the platform-volume control header so `1D`, `7D`, `30D`, `6M`, and `1Y` are available through an explicit range control while chart modes remain visible as bucket / 7D rolling / cumulative.
  - Added in-chart command stats for live notional, paper notional, priced trades, and operator-source coverage.
  - Added fast operator-first homepage hydration so the public fleet roster/trades publish from operator `/api/bots` before slower on-chain enrichment completes.
  - BAD token extraction artifacts:
    - Before density pass: `.evolve/bad-arena-home-20260601-tokens/screenshots/desktop.png`
    - After density/stat fit pass: `.evolve/bad-arena-home-20260601-after-stat-fit/screenshots/desktop.png`
    - Final extraction after title correction: `.evolve/bad-arena-home-20260601-final/screenshots/desktop.png`
  - Final command-center screenshot evidence:
    - `.evolve/arena-home-command-center-smoke-20260601-range-coverage/1440x900-home.png`
    - `.evolve/arena-home-command-center-smoke-20260601-range-coverage/1280x800-home.png`
- Added professional market-chart mode for agent performance:
  - `TradingPerformanceChart` now supports `Market` candles plus volume bars using TradingView Lightweight Charts `CandlestickSeries` and `HistogramSeries`.
  - `PerformanceTab` infers the venue candle token from Hyperliquid trade metadata, prediction token ids, or strategy config and defaults to `Market` when real OHLCV exists.
  - NAV remains a first-class fallback; the UI does not fabricate candles when a venue has no stored candles.
  - Trade markers now attach to the nearest candle timestamp in `Market` mode and to real execution timestamps in `NAV` mode.
  - Added `useBotMarketCandles` on top of the existing bot API hook layer.
  - Added fleet operator `/api/bots/:bot_id/market-data/candles` and singleton operator `/api/bot/market-data/candles` proxies to the existing trading API candle store.
  - Added route-shape regressions for the operator candle/volume endpoints and chart regressions for candlestick/volume rendering.
- Split large workspace bundles:
  - `arena.bot._id` route entry dropped from roughly 629 kB minified / 158 kB gzip to 0.78 kB minified / 0.43 kB gzip by lazy-loading Performance, Portfolio, Runs, Chat, and Operations workspaces.
  - `OperationsWorkspace` dropped from roughly 479 kB minified / 121 kB gzip to 8.65 kB minified / 2.90 kB gzip by lazy-loading validation, revisions, controls, envelope, secrets, vault, and terminal panels.
  - The terminal panel remains isolated at roughly 345 kB minified / 89 kB gzip and now loads only when the user opens Terminal.
  - `connectkit` remains the only >500 kB client chunk at roughly 770 kB minified / 281 kB gzip; it is a wallet-provider boundary and should be handled in a separate wallet-provider architecture pass.
- Completed the post-smoke portfolio quality pass:
  - Position summary cards no longer force four columns inside the split portfolio pane. They cap at two columns, use tighter labels, and keep numeric values readable.
  - The Portfolio workspace now switches from side-by-side panes to stacked full-width internal panes below 1360px, fixing the 1280x800 vertical-letter trade-column failure without shrinking the 1440 desktop terminal layout.
  - The embedded trade history now has a compact portfolio mode that shows Time / Action / Trade by default, hides secondary audit columns only in the split/stacked portfolio view, and keeps expanded row details for validation, execution QA, refs, and validator evidence.
  - Hyperliquid trade rows now show a market token badge plus labeled `Order:` / `Size:` quantities, so the portfolio trade tape reads as executions instead of clipped table text.
  - Final screenshot evidence:
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-responsive-portfolio/1440x900-portfolio.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-responsive-portfolio/1280x800-portfolio.png`
- Completed the post-smoke performance responsive pass:
  - Performance no longer enters the side-tape desktop layout at 1280px after the global sidebar and agent rail consume horizontal space.
  - The 1180-1359px layout keeps the chart full-width, compresses the six key metrics into one row, and moves the trade tape below the chart.
  - The checkpoint readout is hidden below 1360px because the same information is already represented in the stat cards and the clipped card made the page feel broken.
  - The 1440px+ layout preserves the professional right-side trade tape plus checkpoint readout terminal shape.
  - Final screenshot evidence:
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-performance-responsive-final/1280x800-performance.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-performance-responsive-final/1440x900-performance.png`
- Completed the post-smoke trace workspace density pass:
  - Chat no longer renders a 320px session rail for a single public/read-only session. The transcript now owns the available viewport until there are multiple sessions or the signed-in owner can create/manage sessions.
  - Runs no longer renders the run-list rail for a single autonomous run. The selected run header and full trace transcript now use the primary workspace width until there are multiple runs or older pages to navigate.
  - The rule preserves navigation where it has real value and removes dead chrome where it was stealing the exact space users need for reading full transcripts.
  - Final screenshot evidence:
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-trace-rail-density/1440x900-chat.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-trace-rail-density/1440x900-runs.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-trace-rail-density/1280x800-chat.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-trace-rail-density/1280x800-runs.png`
- Completed the Performance owner-copilot pass:
  - Public viewers keep the right-side Trade Tape on Performance, so the chart remains inspectable without auth and shows recent market actions.
  - Authenticated owners now get a lazy-loaded chart copilot panel in that slot. The copilot reuses the existing session stream and `ChatTranscript` UI instead of adding a second chat transport.
  - The copilot can create a real sandbox session before sending if the fixed primary session is not present, which makes the side panel actionable instead of only a transcript preview.
  - Added owner-mode browser smoke coverage by injecting the existing dev E2E operator auth cache before app boot. The smoke now verifies owner Performance renders `Copilot` and fails if the public `Trade Tape` still appears.
  - The owner smoke caught a real sandbox-session integration mismatch: `useSessions` can receive either `Session[]` or an operator `{ sessions }` envelope. `normalizeSessionList` now handles both shapes and is shared by the full Chat workspace and the Performance copilot.
  - The owner panel is split into its own production chunk (`PerformanceCopilotPanel`, roughly 3.06 kB minified / 1.54 kB gzip in the latest build), so public chart viewers do not pay the full chat surface cost.
  - Final screenshot evidence for public/default Performance:
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-performance-copilot/1440x900-performance.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-post-performance-copilot/1280x800-performance.png`
  - Final screenshot evidence for authenticated owner Performance:
    - `.evolve/arena-workspace-fixture-smoke-20260601-owner-performance/1440x900-performance-owner.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-owner-performance/1280x800-performance-owner.png`
- Completed the compact agent navigation pass:
  - Compared five 1280-1440px Performance alternatives and selected the collapsed agent rail + header subnav model because it gives the chart back 224px without hiding agent identity or section navigation.
  - The full agent rail now renders only on very wide screens; 1280px and 1440px use a compact route-native subnav in the agent header.
  - Focus-mode Chat/Runs keep a small floating section nav for one-click exits without reintroducing the normal bot header.
  - Performance now switches to chart + side-panel at 1280px because the collapsed rail makes that viable. This keeps the chart intact while preserving public Trade Tape or owner Copilot.
  - Final screenshot evidence:
    - `.evolve/arena-workspace-fixture-smoke-20260601-compact-agent-nav-final-public/1440x900-performance.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-compact-agent-nav-final-public/1280x800-performance.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-compact-agent-nav-final-owner/1280x800-performance-owner.png`
    - `.evolve/arena-workspace-fixture-smoke-20260601-compact-agent-nav-final-public/1280x800-chat.png`
- Completed the Operations control-plane pass:
  - Compared five Operations layouts and selected the Overview Cockpit + Drill-Down Panels model because the previous validation-first route opened on a mostly empty spinner and hid the actual trading system state.
  - Operations now defaults to `Overview`, while direct `?panel=` links and legacy tab redirects still land on the precise drill-down panel.
  - The overview exposes runtime status, execution mode, validation trust, control availability, operator kind, secrets state, sandbox/lifecycle state, identity references, and capability checks before any lazy panel loads.
  - Overview action cards route into the existing lazy Validation, Controls, Envelope, Vault, Secrets, Terminal, and Revisions panels instead of duplicating those surfaces.
  - Desktop overview now uses the available 1280-1440px width for a side identity panel so Bot ID, operator, submitter, vault, service, call, sandbox, chain, and verification time are first-screen data.
  - Added `OperationsWorkspace.test.tsx` to lock the default overview and the action-card drill-down behavior.
  - Final screenshot evidence:
    - `.evolve/arena-operations-overview-smoke-20260601-final/1440x900-operations.png`
    - `.evolve/arena-operations-overview-smoke-20260601-final/1280x800-operations.png`
- Completed the Hyperliquid-inspired terminal chart pass:
  - Used the site-clone recon workflow against `https://app.hyperliquid.xyz/trade` to extract rendered screenshot and computed tokens instead of guessing.
  - Captured reference artifacts:
    - `.evolve/hyperliquid-trade-recon/reference-1440x900.png`
    - `.evolve/hyperliquid-trade-recon/reference.json`
  - Replaced the Performance stat-card shell with a flat dark exchange terminal strip: symbol, checkpoint timestamp, Price, H/L, Vol, PnL, Fills, mode, and range controls in one row.
  - Kept `lightweight-charts` and the existing venue candle/NAV hooks; the change is a presentation/interaction upgrade, not a duplicate chart engine.
  - Updated chart palette toward professional exchange colors: muted dark panel, subtle grid, Hyperliquid-like positive/negative colors, dark tooltip/readout, and no visible attribution chip.
  - Converted the right Performance rail to a matching dark fills rail and gave `DecisionInspector` a terminal variant so selected fills are readable inside the chart surface.
  - Trimmed the terminal decision inspector to summary, notional, instrument, status badges, and thesis. Full stages/evidence stay available in dedicated trade/ops contexts.
  - Hid secondary strip subvalues below 1440px so the 1280px terminal no longer truncates `Low` / ledger-row copy.
  - Final screenshot evidence:
    - `.evolve/arena-hyperliquid-terminal-smoke-20260602-final-resume/1440x900-performance.png`
    - `.evolve/arena-hyperliquid-terminal-smoke-20260602-final-resume/1280x800-performance.png`
- Verification completed:
  - `pnpm --dir arena typecheck` passes.
  - `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx` passes.
  - `pnpm --dir arena exec vitest run src/routes/__tests__/bot-workspace-routing.test.tsx` passes.
  - `pnpm --dir arena exec vitest run src/routes/__tests__/create.test.tsx src/components/provision/__tests__/SecretsStep.envelope-redirect.test.tsx` passes.
  - `pnpm --dir arena exec vitest run src/routes/__tests__/index.test.tsx src/lib/hooks/useBotApi.test.ts src/lib/platformVolume.test.ts` passes.
  - Latest focused regression after the portfolio quality pass: `pnpm --dir arena exec vitest run src/routes/__tests__/bot-workspace-routing.test.tsx src/lib/platformVolume.test.ts` passes.
  - Latest focused regression after the Performance owner-copilot pass: `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx` passes and asserts authenticated owners see the copilot instead of the public trade tape.
  - Latest focused regression after the owner browser-smoke pass: `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx src/lib/platformVolume.test.ts` passes: 19 tests.
  - Latest trade-history readability regression after the portfolio label fix: `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx` passes: 20 tests.
  - Latest compact agent navigation regression: `pnpm --dir arena exec vitest run src/routes/__tests__/bot-workspace-routing.test.tsx src/components/bot-detail/__tests__/PerformanceTab.test.tsx` passes: 13 tests.
  - Latest Operations control-plane regression: `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/OperationsWorkspace.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx` passes: 5 tests.
  - Latest homepage operator-coverage regression: `pnpm --dir arena exec vitest run src/lib/operator/meta.test.ts src/lib/config/deploymentFingerprint.test.ts src/lib/platformVolume.test.ts src/lib/hooks/useBotApi.test.ts` passes: 27 tests.
  - Latest homepage focused regression: `pnpm --dir arena exec vitest run src/routes/__tests__/index.test.tsx src/lib/platformVolume.test.ts src/lib/hooks/useBotApi.test.ts` passes: 15 tests.
  - `pnpm --dir arena test` passes: 55 files, 310 tests.
  - `pnpm --dir arena build` passes.
  - `node --check arena/scripts/smoke-agent-workspace.mjs` passes.
  - `pnpm --dir arena smoke:agent-workspace -- --help` passes.
  - `pnpm --dir arena smoke:agent-workspace -- --url http://127.0.0.1:1337/ --allow-empty` passes against a local dev server when no fixture/live agent is present.
  - `pnpm --dir arena smoke:agent-workspace -- --fixture` passes. This starts a deterministic mock fleet operator plus local app server, then verifies populated Performance, Portfolio, Runs, Chat, and Operations routes at 1440x900 and 1280x800 with no document body scroll and validates Portfolio -> Chat -> browser Back -> Portfolio plus Chat -> Performance one-click navigation.
  - Latest visual smoke after the portfolio quality pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-post-responsive-portfolio` passes.
  - Latest visual smoke after the performance responsive pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-post-performance-responsive-final` passes.
  - Latest visual smoke after the trace workspace density pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-post-trace-rail-density` passes.
  - Latest visual smoke after the Performance owner-copilot pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-post-performance-copilot` passes.
  - Latest public workspace smoke after the session normalizer pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-public-after-session-normalizer` passes.
  - Latest owner Performance smoke: `pnpm --dir arena smoke:agent-workspace -- --owner-performance --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-owner-performance` passes.
  - Latest public workspace smoke after compact agent navigation: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-compact-agent-nav-final-public` passes.
  - Latest owner Performance smoke after compact agent navigation: `pnpm --dir arena smoke:agent-workspace -- --owner-performance --screenshot-dir ../.evolve/arena-workspace-fixture-smoke-20260601-compact-agent-nav-final-owner` passes.
  - Latest public workspace smoke after homepage command-center and operator-coverage pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-home-command-center-smoke-20260601-range-coverage` passes.
  - Latest public workspace smoke after Operations overview pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-operations-overview-smoke-20260601-final` passes.
  - Latest focused regression after the Portfolio exposure-rail pass: `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PositionsTab.test.tsx src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx` passes: 27 tests.
  - Latest public workspace smoke after the Portfolio exposure-rail pass: `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-portfolio-rail-smoke-20260601` passes.
  - Portfolio exposure-rail screenshot evidence:
    - `.evolve/arena-portfolio-rail-smoke-20260601/1440x900-portfolio.png`
    - `.evolve/arena-portfolio-rail-smoke-20260601/1280x800-portfolio.png`
  - Latest full Arena verification after the homepage + Operations + Portfolio passes:
    - `pnpm --dir arena typecheck` passes.
    - `pnpm --dir arena test` passes: 55 files, 311 tests.
  - Latest Hyperliquid terminal chart verification:
    - `pnpm --dir arena test` passes: 66 files, 380 tests.
    - `pnpm --dir arena typecheck` passes.
    - `pnpm --dir arena build` passes.
    - `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-hyperliquid-terminal-smoke-20260602-final-resume` passes.
    - `pnpm --dir arena build` passes.
  - Production deploy workflow fix:
    - `.github/workflows/deploy-arena.yml` now bakes `VITE_TRADING_OPERATOR_API_URLS` and `VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS`, so the deployed homepage volume chart can read the configured public operator fleet instead of only `VITE_OPERATOR_API_URL`.
    - `actionlint .github/workflows/deploy-arena.yml` passes.
    - `VITE_OPERATOR_API_URL=... VITE_TRADING_OPERATOR_API_URLS=... VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS=... pnpm --dir arena build` passes.
  - `cargo check -p trading-blueprint-bin -p trading-instance-blueprint-lib -p trading-http-api` passes.
  - `cargo check --workspace` passes.
  - `cargo test -p trading-http-api --test api_tests` passes: 164 tests.
  - `cargo test -p trading-http-api --test api_tests test_platform_volume_aggregates_priced_trades_across_bots` passes.
  - `cargo test -p trading-http-api --test api_tests test_candle_store_record_and_query` passes.
  - `cargo test -p trading-blueprint-bin operator_api::tests` passes: 40 tests for lib and 40 for bin.
  - `cargo test -p trading-instance-blueprint-lib operator_api::tests` passes: 12 tests.
  - `cargo test --workspace` still fails in pre-existing `trading-blueprint-lib --test integration`: shared `(service_id=0, call_id=0)` state collisions and one host Firecracker permission failure.
  - `pnpm --dir arena build` still emits the existing large-chunk warning for `connectkit`; this is not a correctness failure but should be addressed in a wallet-provider performance pass.
  - BAD LLM scoring previously stalled, but deterministic BAD extraction now completed for the homepage before/after/final passes.

### Progress — 2026-06-02 Design Audit Loop

Evidence gathered:

- Ran live BAD design audit against production Performance route before this pass:
  - `.evolve/bad-agent-workspace-redesign-20260602/report.md`
  - `.evolve/bad-agent-workspace-redesign-20260602/report.json`
  - Production Performance scored `4.5/10`; `trust_clarity` was `2/10`. The rest of the crawl returned `page.goto: Target page, context or browser has been closed`, so only the first route findings were treated as reliable.
- Fanned out three read-only audits:
  - Information hierarchy audit: primary issue is duplicated chrome and weak linkage between chart, exposure, trades, runs, chat, and operations.
  - Code reuse/performance audit: next robustness target is shared market/trade helpers, shared operator aggregate policy, and consistent max-drawdown computation between `useBotLiveSummary` and `useBotEnrichment`.
  - Trading-terminal benchmark audit: strongest architecture remains Exchange Terminal + Fleet Command Center, with Prediction-Market Outcome Board as a venue-specific mode.
- External references checked:
  - TradingView Lightweight Charts markers attach annotations to series data by timestamp: https://tradingview.github.io/lightweight-charts/tutorials/how_to/series-markers
  - Coinbase Advanced emphasizes interactive charts, order books, depth chart, order panel, open orders, and live trade history: https://help.coinbase.com/coinbase/trading-and-funding/advanced-trade/dashboard-overview
  - Kraken Pro frames its product as customizable trading widgets with a non-customizable essential top ribbon and order-book widget: https://support.kraken.com/articles/kraken-pro-trading-interface-guide
  - Polymarket exposes price/probability, bid/ask spread, orderbook depth, and estimated fill price as first-class trading concepts: https://docs.polymarket.com/concepts/prices-orderbook and https://docs.polymarket.com/trading/orderbook

What changed in this pass:

- `AgentWorkspaceShell` now removes redundant `Capital` and `Max DD` text from the metadata row. Capital/max drawdown were already available in stronger places; the duplicate copy caused header wrapping at 1280px and made the agent context feel busy.
- `AgentWorkspaceShell` now renders the operator address as a compact trust control with copy and explorer-link affordances when the configured chain has an explorer. This addresses the BAD trust finding without adding another card above the chart.
- `PerformanceTab` is now mode-aware:
  - Market mode stats: `Last Price`, range move, fills, market high/low, volume.
  - NAV mode stats: NAV, return, range PnL, trades, NAV high/low.
  - This fixes the expert-hostile mismatch where a candle chart could show NAV high/low stats.
- `PerformanceTab` trade tape now reuses `AssetPairDisplay` for DEX trades, renders Hyperliquid market badges, and preserves Polymarket question text as a wrapped outcome label instead of forcing raw pair text.
- `TradingPerformanceChart` now de-noises dense marker text while preserving all marker timestamps. Singleton labels are hidden above the density threshold; grouped markers still show counts like `BUY x4`. This keeps 100+ fills from turning the chart into a wall of orange labels while retaining evidence.
- Added and implemented the Performance Execution Rail decision above:
  - The side panel is now `Execution Tape`, not a generic recent-trades card.
  - The selected fill uses a terminal-style `DecisionInspector` variant with large action, instrument identity, notional, status, agent thesis, validation, execution, and provenance.
  - The fill ledger is card-based instead of a cramped 4-column mini table, so side, time, logos/market, notional, and mode remain readable at the 380-420px right-rail width.
  - The implementation reuses `DecisionInspector`, `TradeInstrumentDisplay`, and `buildDecisionItemsFromTrades`; it does not add a duplicate trade-history pathway.
- Implemented the first integrated Performance terminal pane:
  - Lightweight Charts 5.2 pane support now adds an Account NAV / PnL lower pane under market candles when account checkpoints exist.
  - Market mode no longer forces users to choose between price action and account context; it shows candles, volume, fills, and NAV in one terminal frame.
  - Account mode remains available as a focused fallback, but the expert default can now carry both market and portfolio evidence together.
  - `PerformanceTab` tests now assert the lower pane is created and receives account-value data, preventing silent regression back to a price-only chart.
- `TradingPerformanceChart` demotes the TradingView attribution from a loud pill to a small corner label so it does not compete with the x-axis.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx` passes: 12 tests. Added regression that Market mode shows market stats and does not show `Range PnL`.
- `pnpm --dir arena exec vitest run src/routes/__tests__/bot-workspace-routing.test.tsx src/components/bot-detail/__tests__/PerformanceTab.test.tsx` passes: 15 tests.
- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx src/components/bot-detail/__tests__/PositionsTab.test.tsx` passes: 27 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes; existing `connectkit` large-chunk warning remains.
- Browser fixture smoke passes:
  - `.evolve/arena-workspace-smoke-20260602-trust-market-stats/1440x900-performance.png`
  - `.evolve/arena-workspace-smoke-20260602-trust-market-stats/1280x800-performance.png`

Remaining high-leverage work:

- Run production browser smoke against real deployed bot routes after Pages/operator deployment; deterministic fixture smoke is now available and passing locally.
- Deploy the new `/api/platform/volume` operator route everywhere so the homepage no longer needs the compatibility fallback.
- Configure `VITE_TRADING_OPERATOR_API_URLS` / `VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS` with every public operator API endpoint that should count toward platform volume. A true “all third-party operators” number still requires a real operator endpoint registry or indexer; the browser cannot count an unknown operator API it cannot discover.
- Backfill/store venue candles for active Hyperliquid and prediction-market bots so the new Market chart mode has real OHLCV on live agents.
- Split or lazily load the wallet-provider boundary so the `connectkit` chunk no longer dominates client output.
- Extract shared market/trade helpers so Hyperliquid labels, candle-token inference, Polymarket labels, and nearest-candle matching do not continue to live in separate screen components.
- Fix max-drawdown consistency between `useBotLiveSummary` and `useBotEnrichment`; the audit found one path uses `Math.max` while another uses `Math.min`.
- Add a run/chat side inspector that ties transcript messages to decision, validation, exposure delta, fills, and risk state.
- Build the Prediction-Market Outcome Board mode: probability chart, bid/ask spread, depth, expiry/resolution context, and estimated fill/slippage using Polymarket CLOB data.
- Continue visual polish on sidebar footer, root dashboard density, and mobile navigation after authenticated screenshots.

### Phase 0 — Baseline And Failing Repro

- [x] Add browser regression for agent section navigation.
  - Files: `arena/src/routes/__tests__/bot-workspace-routing.test.tsx` or existing route tests.
  - Regression: leaving Chat/Runs and clicking Performance changes the URL and renders performance content in one click.
  - Verification: `pnpm --dir arena exec vitest run src/routes/__tests__/bot-workspace-routing.test.tsx` passes and covers Performance -> Chat -> browser Back -> Performance, Chat -> Performance in one click, and legacy `?tab=terminal` -> `/operations?panel=terminal`.

- [x] Add chart/trade-count regression.
  - Files: `arena/src/components/bot-detail/__tests__/PerformanceTab.test.tsx`, `TradingPerformanceChart.test.tsx`.
  - Regression: 49 trades across sparse metric snapshots produce 49 marker records or an explicit cluster count, never two silent markers.
  - Verification: test asserts marker source count and visible cluster labels.

- [x] Add viewport fit smoke.
  - Files: existing browser smoke harness or new `arena/scripts/smoke-agent-workspace.mjs`.
  - Desktop targets: 1440x900 and 1280x800.
  - Assertion: `document.scrollingElement.scrollHeight <= window.innerHeight + 2` on Performance, Runs, Chat, Portfolio, Operations.
  - Verification: `node --check arena/scripts/smoke-agent-workspace.mjs`, `pnpm --dir arena smoke:agent-workspace -- --help`, local `--allow-empty` smoke, and strict `pnpm --dir arena smoke:agent-workspace -- --fixture` pass.

### Phase 1 — Route-Driven Shell

- [x] Create `ArenaAppShell`.
  - File: `arena/src/components/layout/ArenaAppShell.tsx`.
  - Reuse the GTM/creative pattern: `h-[100dvh] overflow-hidden`, fixed sidebar, flex outlet.
  - Remove body-level scroll for app routes.

- [x] Replace fixed top header with sidebar navigation.
  - File: `arena/src/root.tsx`.
  - Keep wallet/chain/tx controls in sidebar footer or compact top strip inside the shell.
  - Preserve `Header` only if needed for legacy/mobile fallback.

- [x] Create `ArenaSidebar`.
  - Implemented as part of `ArenaAppShell` rather than a separate file.
  - File: `arena/src/components/layout/ArenaSidebar.tsx`.
  - Items: Home, Leaderboard, Deploy Agent, Create From Chat, recent/live agents.
  - Use `NavLink`, not manual active matching.

- [x] Convert agent sections from query tabs to routes.
  - Files:
    - `arena/src/routes/arena.bot.$id.tsx` becomes `AgentWorkspaceShell`.
    - Add `arena/src/routes/arena.bot.$id._index.tsx` redirect/default to performance if supported by fs-routes, or render performance directly.
    - Add `arena/src/routes/arena.bot.$id.performance.tsx`.
    - Add `arena/src/routes/arena.bot.$id.portfolio.tsx`.
    - Add `arena/src/routes/arena.bot.$id.runs.tsx`.
    - Add `arena/src/routes/arena.bot.$id.chat.tsx`.
    - Add `arena/src/routes/arena.bot.$id.operations.tsx`.
  - Shared data extraction should move into `arena/src/lib/hooks/useAgentWorkspaceBot.ts` or a route component utility, not copy/paste across child routes.

- [x] Delete query-tab coupling.
  - Query tabs remain only as compatibility redirects.
  - File: `arena/src/routes/arena.bot.$id.tsx`.
  - Remove `VALID_BOT_TABS`, `handleTabChange`, `from`, immersive branch, and `TabsContent`.
  - Back button is now browser-native route history; in-app Back links to the previous non-chat route or `/arena/bot/:id/performance`.

### Phase 2 — Agent Workspace Layout

- [x] Replace `BotHeader` with `AgentWorkspaceChrome`.
  - Implemented as `AgentWorkspaceShell`.
  - New file: `arena/src/components/bot-detail/AgentWorkspaceChrome.tsx`.
  - Contains compact agent identity, operator, address, status, 30D return, Sharpe, max DD, portfolio value.
  - Sidebar nav: Performance, Portfolio, Runs, Chat, Operations.
  - No sticky card wall; no grouped horizontal tabs.

- [x] Make Performance full height.
  - File: `arena/src/components/bot-detail/PerformanceWorkspace.tsx`.
  - Layout: `grid-cols-[minmax(0,1fr)_360px]`, height fills the viewport below one compact agent strip.
  - Right panel: AI copilot if chat is writable; trade tape otherwise.
  - Internal panel scrolling only.

- [x] Combine positions and trades.
  - New file: `arena/src/components/bot-detail/PortfolioWorkspace.tsx`.
  - Reuse `PositionsTab` and `TradeHistoryTab` internals by extracting table components.
  - Row detail opens drawer or side inspector.

- [x] Make Runs and Chat route-native full-screen workspaces.
  - Files: `RunsTab.tsx`, `ChatTab.tsx`, new route wrappers.
  - Remove special root query detection.
  - Preserve public read-only transcript work from ops-board `#922`.

- [x] Create Operations workspace.
  - New file: `arena/src/components/bot-detail/OperationsWorkspace.tsx`.
  - Compose extracted pieces from `ReasoningTab`, `RevisionArenaTab`, `ControlsTab`, `TerminalTab`, `EnvelopeTab`, `SecretsTab`.
  - No horizontal scrolling nav; use a left sub-list or 2x2 panels.

### Phase 3 — Professional Chart

- [x] Add market candle hook.
  - Implemented inside existing hook module rather than adding a duplicate hook file: `arena/src/lib/hooks/useBotApi.ts`.
  - Source existing operator API endpoints:
    - `GET /api/bots/:bot_id/market-data/candles?token=...&from=...&to=...&limit=...`
    - `GET /api/bot/market-data/candles?token=...&from=...&to=...&limit=...`
    - Frontend does not fetch historical candles on demand yet; live operators need candle backfill/storage to make Market mode available.
  - Infer candle source from strategy:
    - `hyperliquid_perp` -> `hyperliquid`
    - `polymarket_*` -> `polymarket`
    - Base DEX pools -> `geckoterminal`
    - fallback -> NAV mode only.

- [x] Replace area-only chart with terminal chart.
  - File: `arena/src/components/bot-detail/TradingPerformanceChart.tsx`.
  - Add `CandlestickSeries` for market mode.
  - Keep NAV as line/area overlay or separate mode.
  - Add fills at actual trade timestamps; cluster only when genuinely overlapping, with visible count.
  - Price lines for entry, current price, stop/risk remain future polish where the strategy/runtime exposes those levels.

- [x] Fix marker mismatch.
  - File: `arena/src/components/bot-detail/PerformanceTab.tsx` or new chart data adapter.
  - Stop storing one marker per NAV checkpoint.
  - Build markers directly from `Trade[]`.
  - If multiple trades land in the same rendered pixel/time bucket, show `BUY x7` / `SELL x3`, not a single marker.

- [x] Move total trade count out of the page bottom.
  - File: new `AgentMetricsStrip`.
  - Total trades belongs in the persistent agent metrics strip and Portfolio workspace, not a summary card below the chart.

### Phase 4 — Dashboard Rewrite

- [x] Add platform-volume analytics to the homepage.
  - File: `arena/src/components/arena/PlatformVolumeChart.tsx`.
  - Ranges: 1D, 7D, 30D, 6M, 1Y.
  - Modes: bucket, 7D rolling, cumulative.
  - Data source prefers aggregate operator volume across configured operator URLs and falls back to paginated per-bot trade history for older deployments.

- [x] Replace remaining scattered dashboard areas with command-center home.
  - File: `arena/src/routes/dashboard.tsx` or `_index.tsx` depending final route decision.
  - Home: fleet health, active agents, live capital, recent incidents/actions, deploy CTA.
  - Leaderboard: table-first, dense, no random bottom stats.

- [x] Keep latest trades as an explorer feed, but move it to the right context.
  - File: `arena/src/components/arena/LatestAgentTrades.tsx`.
  - It should live on Leaderboard/Home as a compact activity strip, not compete with agent performance.

- [x] Add agent roster in sidebar.
  - File: `ArenaSidebar.tsx`.
  - Query from existing `useBots` and `useBotEnrichment`.
  - Show active/recent agents with status dot and compact return.

### Phase 5 — QA, Audit, Release

- [x] Full local verification.
  - `pnpm --dir arena typecheck`
  - `pnpm --dir arena test`
  - `pnpm --dir arena build`

- [x] Deterministic browser smoke.
  - Verify no body scroll for Performance, Portfolio, Runs, Chat, Operations at 1440x900 and 1280x800.
  - Verify route navigation:
    - Performance -> Chat -> browser Back -> Performance. Covered by `bot-workspace-routing.test.tsx`.
    - Chat -> sidebar Performance -> Performance in one click. Covered by `bot-workspace-routing.test.tsx`.
    - Portfolio -> Chat -> Back -> Portfolio. Covered by `pnpm --dir arena smoke:agent-workspace -- --fixture`.
  - Verify chart:
    - candle mode renders for Hyperliquid fixture bot.
    - trade marker count or clusters explain all trades in selected range.
    - 7D/30D/1Y changes date range and axis labels.

- [ ] Production browser smoke.
  - Run `pnpm --dir arena smoke:agent-workspace -- --url <deployed-arena-url>` after Pages/operator deployment.
  - Capture screenshots for homepage, agent Performance, Portfolio, Runs, Chat, and Operations with live data.

- [ ] BAD design audit.
  - Run against production or local preview after the shell rewrite.
  - Target score: 8.5+ before deploy, 9+ before considering ops-board `#898` done.

- [ ] Ship.
  - Commit, push, wait for CI, verify Pages deploy, run production smoke.

## Specific Bugs To Close

### Performance Requires Multiple Clicks / Stale Chat With Navbar

Likely contributing causes:

- Workspace state is query-param based, not route based.
- `root.tsx` hides global header by sniffing `?tab=chat|runs`.
- `arena.bot.$id.tsx` has two render paths for the same Chat/Runs components: immersive and normal.
- Normal content uses `TabsContent` without a real visible `TabsList`/`TabsTrigger` model.

Fix:

- Route-native sections.
- One Chat route, one Runs route.
- No `?tab=`.
- No root-level query sniffing.

### 49 Trades But Two Chart Markers

Likely contributing causes:

- `buildTradeMarkers()` creates an array with length equal to NAV chart points.
- `nearestChartPointIndex()` maps every trade to the nearest sparse metric snapshot.
- Later trades overwrite earlier markers at the same snapshot index except for tooltip count.

Fix:

- Build chart markers from trade timestamps, not NAV snapshot indices.
- Show visible clusters when multiple trades overlap.
- In market-candle mode, plot fills against venue price candles.
- In NAV mode, show trade bands/events at real times even when no NAV checkpoint exists.

## API Changes

Preferred minimal API additions:

```ts
GET /api/bots/:bot_id/market-data/candles?token=BTC&source=hyperliquid&interval=1h&limit=500
```

Response:

```ts
{
  candles: Array<{
    token: string
    timestamp: number
    open: string
    high: string
    low: string
    close: string
    volume?: string
    source?: string
  }>
  total: number
}
```

This should proxy existing trading HTTP candle routes. If the operator route already exposes `GET /market-data/candles`, the frontend can call that through `buildBotScopedPathForDeploymentKind` without new backend shape.

## Alternatives Considered

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| Keep current layout and polish CSS | Fast | Does not fix tab model, wasted vertical space, or chart/data mismatch | Rejected |
| Keep query params but rewrite visual layout | Smaller diff | Still creates broken browser/back semantics | Rejected |
| Use iframe TradingView Advanced Chart | Professional chart quickly | Licensing/branding/data integration/control issues; harder to show custom agent fills | Rejected for now |
| Use Lightweight Charts properly with candles/fills | Already dependency-approved, controllable, fast | Needs candle hook and chart adapter work | Accepted |
| One operations mega-page | Reduces top-level nav clutter | Can become dense | Accepted with structured panels |
| Separate every admin tool route | Clear URLs | Too many sidebar items; repeats current clutter | Rejected |

## Success Criteria

- No body scrolling on desktop for Performance, Portfolio, Runs, Chat, Operations at 1440x900 and 1280x800.
- Sidebar navigation is route-native and browser Back behaves without custom `from=` state.
- Performance page has a professional market chart for Hyperliquid/perp agents when candle data exists.
- Trade marker accounting is explainable: visible markers plus clusters reconcile to selected-range trade count.
- Positions and trades share one Portfolio workspace.
- Chat and Runs are full-view workspaces with no duplicated normal/immersive variants.
- Public/non-owner chat state is useful: read-only transcript or trade tape/state, not empty unexplained space.
- Existing arena tests pass; new routing/chart/layout smoke tests fail on the old model and pass on the rewrite.
- BAD audit improves materially from the current 3.4/10 and no longer flags empty/no-context core agent views.

## Rollback Plan

- Keep current bot data hooks unchanged during Phase 1.
- Introduce new shell/components alongside current components.
- Route default can be switched back by reverting only route files if the shell fails.
- Do not delete old `PerformanceTab`, `PositionsTab`, `TradeHistoryTab`, `ChatTab`, or `RunsTab` until their extracted replacements pass browser smoke.
- If candle mode is unstable, ship NAV mode with fixed marker accounting and guard market mode behind a feature flag/env toggle.

## Open Questions

- Should `/` remain Leaderboard, or should `/dashboard` become the logged-in command center and `/leaderboard` become the public ranking page?
- Should public agent chat transcripts be exposed by default, or only selected “safe trace” projections from operator logs?
- Should Terminal be a standalone sidebar item for owners, or remain inside Operations?
- What is the canonical route for deploying from chat: `/create`, `/provision?mode=chat`, or a Deploy workspace with mode switch?

## Immediate Next Commit

1. Deploy the operator `/api/platform/trades` route everywhere, then verify the homepage tape uses aggregate operator reads instead of per-bot fanout.
2. Configure every public operator endpoint in `VITE_TRADING_OPERATOR_API_URLS` / `VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS`; if the product needs trustless all-operator coverage, add an endpoint registry/indexer rather than pretending configured URLs are global discovery.
3. Run `pnpm --dir arena smoke:agent-workspace -- --url <deployed-arena-url>` against an actual deployed bot and capture desktop/mobile screenshots.
4. Backfill venue candles for active Hyperliquid and prediction-market bots so Market mode is not empty on live agents.
5. Do a wallet-provider performance pass to isolate or defer `connectkit` without breaking wagmi/ConnectKit auth.
6. Run BAD design audit on the deployed workspace and patch the highest-confidence visual issues.

## 2026-06-01 Platform Aggregate Homepage Pass

Shipped in the current local diff:

- Added operator-wide `GET /platform/trades` in `trading-http-api` and public `GET /api/platform/trades` in the binary operator API.
- Changed the homepage execution tape to prefer one aggregate trades request per configured operator, falling back to the old per-bot reads only when every aggregate source fails.
- Upgraded `PlatformVolumeChart` from a custom SVG to TradingView Lightweight Charts, using histogram bars for bucketed volume and area series for 7D/cumulative views.
- Replaced the top homepage `Capital` stat with `30D Volume` from the platform aggregate query, so the first viewport shows real platform activity before bot-level portfolio enrichment catches up.
- Deferred root/dashboard bot enrichment until after first paint and removed always-on enrichment from the global app shell to avoid duplicate metrics/portfolio/trade-count request storms.
- Updated the fixture smoke operator to expose `/api/platform/trades`, so browser smoke covers the aggregate tape happy path.

Verification:

- `cargo check --workspace`
- `cargo test -p trading-http-api test_platform_trades_returns_latest_trades_across_bots --test api_tests`
- `cargo test -p trading-blueprint-bin test_public_platform_trades_route_returns_latest_trades_across_bots --test operator_api_tests`
- `pnpm --dir arena exec vitest run src/lib/hooks/useBotApi.test.ts src/lib/hooks/useBotEnrichment.test.ts src/providers/TradingSyncProvider.test.ts`
- `pnpm --dir arena typecheck`
- `pnpm --dir arena build`
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-platform-aggregate-smoke-20260601b`

Screenshot proof:

- `.evolve/arena-platform-aggregate-smoke-20260601b/1440x900-home.png`

Remaining deployment gap:

- The live operator currently exposes `/api/platform/volume`; it will not expose `/api/platform/trades` until this binary diff is deployed to the box and Pages is redeployed with the new frontend bundle.

## 2026-06-02 Collapsible Rails + Empty-State Activity Pass

Shipped in the current local diff:

- Made the global Arena sidebar collapsible at desktop widths. The collapsed state keeps icon navigation, wallet/theme/chain controls, and agent shortcuts available while giving the trading workspace more horizontal room.
- Split the global sidebar roster into `My Agents` and `Fleet` when the connected wallet matches bot `submitterAddress`. If ownership cannot be proven, the roster is labeled as `Fleet` instead of implying the agents were created by the viewer.
- Made the wide-screen agent rail collapsible. The full rail still shows identity, route sections, and trust metadata; the collapsed rail keeps section icons and agent identity accessible without consuming chart width.
- Made Chat and Runs internal sidebars collapsible when those rails render for multiple sessions/runs.
- Replaced the Performance empty-chart dead zone with an explicit first-checkpoint state that still shows strategy/mode/trade context.
- Reused the canonical aggregate `LatestAgentTrades` surface as the Performance side-panel fallback when the selected bot has no recent fills, so cold agents still show live platform activity instead of an empty tape.
- Added an `enabled` gate to `useLatestAgentTrades`/`LatestAgentTrades` so fallback feeds do not fetch unless the panel is actually active.
- Extended `arena/scripts/smoke-agent-workspace.mjs` to click and verify the global sidebar and wide-screen agent rail collapse in-browser.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/RunsTab.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx src/lib/hooks/useBotApi.test.ts` passes: 32 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes with the pre-existing `connectkit` large-chunk warning.
- `node --check arena/scripts/smoke-agent-workspace.mjs` passes.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-collapsible-rails-smoke-20260602c` passes.

Screenshot proof:

- `.evolve/arena-collapsible-rails-smoke-20260602c/1440x900-performance.png`
- `.evolve/arena-collapsible-rails-smoke-20260602c/1280x800-performance.png`

## 2026-06-02 Dense Marker + Sidebar Relevance Audit Loop

Shipped in the current local diff:

- Fan-out audits found two high-confidence issues after the first pass:
  - `ArenaAppShell` filtered/sorted/sliced the public top-8 before wallet relevance, so a viewer's own low-PnL bot could disappear from the sidebar.
  - Dense trade marker mode hid labels but still rendered one marker and one NAV time-scale anchor per raw fill, so high-fill bots still produced a visual wall and warped chart spacing.
- Fixed sidebar relevance by filtering wallet/operator-relevant bots before sorting/slicing and by treating direct operator-address matches as relevant without making them commandable.
- Made bot workspace routes start with the global sidebar collapsed while keeping it manually expandable and preserving the full leaderboard route.
- Removed the empty dashed sidebar instruction block when no wallet-relevant agents exist; the nav stays quiet instead of over-explaining.
- Replaced exact-only marker grouping with deterministic dense buckets by time and side for NAV and market charts.
- Fed clustered marker placements into NAV point insertion, so dense fills no longer add one synthetic chart point per raw trade.
- Added clustered marker readouts with time range, sampled trade details, and `+N more` context.
- Updated the Performance trade tape badge from `Last 6` to `Last 6 of N` when the loaded trade set is larger than the visible tape.
- Updated browser smoke to accept the new default-collapsed agent workspace rail and verify both expand/collapse directions.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/performanceChart.test.ts src/components/layout/__tests__/ArenaAppShell.test.tsx src/lib/utils/botAccess.test.ts src/routes/__tests__/bot-workspace-routing.test.tsx` passes: 32 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena test` passes: 58 files, 329 tests.
- `pnpm --dir arena build` passes with the pre-existing `connectkit` large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-smoke-20260602-final-cluster-sidebar` passes.

Screenshot proof:

- `.evolve/arena-workspace-smoke-20260602-final-cluster-sidebar/1440x900-performance.png`
- `.evolve/arena-workspace-smoke-20260602-final-cluster-sidebar/1280x800-performance.png`

### Live Follow-Up

- Production smoke after `65b6012` selected `trading-235dc697-928d-4dc4-a412-26b64beefb6a`; the 21-fill NAV chart was clustered cleanly (`SWAP x16`) and the tape showed `Last 6 of 21`.
- A second live smoke selected `trading-7c7fdca4-b3b6-4ac8-8917-2144b1a3a416` and exposed a live-only RangeError: `maximumFractionDigits value is out of range` for large fractional market volume formatting.
- Fixed `formatChartNumber` so values over 1000 do not request decimal `minimumFractionDigits`, and added a fractional-large-volume regression in `PerformanceTab.test.tsx`.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx` passes.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes with the pre-existing `connectkit` large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-workspace-smoke-20260602-format-fix` passes.

## 2026-06-02 Decision Feed + Inspector Pass

Current problem after the shell/chart work: the product still asks users to infer agent behavior from separate traces, trade tables, and raw run JSON. That is not good enough for a trading system. A serious venue makes the action, market, validation, execution state, and provenance visible at the point of attention.

### Five Layout Alternatives Considered

1. Right decision inspector plus horizontal activity strip.

```text
+--------------------+--------------------------------+----------------------+
| Runs / Sessions    | Transcript / Chart / Ledger     | DECISION INSPECTOR   |
| run completed      |                                | BUY YES @ $0.64      |
| validation failed  | selected transcript/chart/table | reason / validator   |
| order filled       |                                | fill / strategy hash |
+--------------------+--------------------------------+----------------------+
| 10:31 STATE | 10:32 DECISION | 10:33 VALIDATED | 10:34 FILLED         |
+----------------------------------------------------------------------------+
```

Verdict: accepted. This matches exchange-style attention flow: tape/strip for scanning, inspector for audit depth. It reuses existing run/trade data without backend work.

2. Exchange blotter above every workspace.

```text
+------------------------------------------------------------------------+
| TIME | AGENT | ACTION | MARKET | NOTIONAL | VALIDATION | EXECUTION      |
+------------------------------------------------------------------------+
| Chart / transcript / tables                                             |
+------------------------------------------------------------------------+
```

Verdict: useful later for Performance/Portfolio, but too much table chrome inside Chat/Runs.

3. Inline decision cards inside transcripts.

```text
Agent message
  Decision card
  Tool output
  Execution card
```

Verdict: good for trace comprehension, but it buries scan state and requires deeper transcript-part contracts.

4. Trade tape upgrade only.

```text
| latest fills |
| latest fills |
| latest fills |
```

Verdict: insufficient. It shows fills, not skipped decisions, validation failures, or why the agent did nothing.

5. Dedicated Decisions tab.

```text
Performance | Portfolio | Runs | Chat | Decisions | Operations
```

Verdict: rejected for now. It hides the answer behind another navigation choice and makes the current tabs weaker.

### Shipped Slice

- Added `arena/src/lib/decisionFeed.ts`, a shared normalizer for autonomous run results and trade metadata.
- Moved Runs result parsing/signal extraction into the shared decision feed so Chat, Runs, Performance, and Portfolio can converge on one interpretation.
- Added `DecisionActivityStrip` for dense exchange-style scan state.
- Added `DecisionInspector` for action, market, reason, notional, validation, execution, stage state, and provenance.
- Wired the strip + inspector into Runs and public Chat replay without changing owner write behavior.
- Added regression tests for run normalization, trade provenance, strip selection, inspector rendering, public Chat replay, and Runs replay.

Verification:

- `pnpm --dir arena exec vitest run src/lib/decisionFeed.test.ts src/components/bot-detail/shared/__tests__/DecisionInspector.test.tsx src/components/bot-detail/__tests__/RunsTab.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx` passes: 4 files, 17 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena test` passes: 60 files, 334 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-decision-feed-smoke-20260602b` passes.

Screenshot proof:

- `.evolve/arena-decision-feed-smoke-20260602b/1440x900-runs.png`
- `.evolve/arena-decision-feed-smoke-20260602b/1440x900-chat.png`

Next highest-ROI continuation:

1. Add a tiny workspace primitive layer for panels, metric tiles, nav strips, segmented controls, and empty/loading states.
2. Reuse the decision feed in Performance so chart marker clicks select the same inspector object as trade table rows.
3. Reuse the decision feed in Portfolio so a position/trade click explains the originating strategy, validator score, execution status, and revision/candidate hash.

## 2026-06-02 Workspace Primitive Consolidation Pass

Shipped as the second slice after the decision inspector:

- Added `WorkspacePrimitives.tsx` with a shared `WorkspaceNavStrip` and `WorkspaceMetric`.
- Migrated `AgentWorkspaceShell` focus nav, normal workspace subnav, and top metric tiles to the shared primitives.
- Kept DOM behavior route-native: nav buttons still expose `aria-current="page"` and call the same route selection handler.
- Avoided a new wrapper/shell. This is a visual-token consolidation pass, not more layout chrome.
- Added `WorkspacePrimitives.test.tsx` for nav selection semantics and metric rendering.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/shared/__tests__/WorkspacePrimitives.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx src/components/bot-detail/__tests__/BotHeader.test.tsx` passes: 3 files, 12 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena test` passes: 61 files, 336 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-primitives-smoke-20260602` passes.

Screenshot proof:

- `.evolve/arena-primitives-smoke-20260602/1440x900-performance.png`

## 2026-06-02 Performance + Trade Decision Inspector Reuse

Problem:

- Performance still had a professional chart and a separate right-side tape, but the tape did not answer the core user question: what did the agent decide, why, under what validation, and what execution state resulted?
- Trade History still hid details when a row had no validator payload, even when the agent had rationale/provenance. That made the most interesting paper/live data feel randomly inaccessible.
- The smoke harness was still asserting the older `Trade Tape` label, so the browser gate itself was not aligned with the new product direction.

Shipped:

- Converted the Performance right rail from a passive `Trade Tape` to a selectable `Decision Tape`.
- Reused the shared `DecisionInspector` and `buildDecisionItemsFromTrades` path so chart/tape/trade-history decisions share one normalization contract.
- Added selected-state trade buttons in Performance; selecting a fill updates the inspector with rationale, venue, notional, validation, execution, stage state, and provenance.
- Made every Trade History row expandable, including rows with no validator response, so users can inspect agent rationale and captured trade provenance instead of needing a separate validation record.
- Updated the deterministic browser smoke expectations from `Trade Tape` to `Decision Tape`, and tightened owner-mode smoke so public decision tape cannot leak into owner copilot mode.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx src/lib/decisionFeed.test.ts src/components/bot-detail/shared/__tests__/DecisionInspector.test.tsx` passes: 4 files, 39 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena test` passes: 61 files, 338 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `node --check arena/scripts/smoke-agent-workspace.mjs` passes.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-performance-decision-smoke-20260602` passes.

Screenshot proof:

- `.evolve/arena-performance-decision-smoke-20260602/1440x900-performance.png`
- `.evolve/arena-performance-decision-smoke-20260602/1280x800-performance.png`

### Live Release Follow-Up

- Deployed UI commit `6e1e2c60f637aafa96874d710876490b66db2525`; Cloudflare Pages run `26796678034` passed.
- CI and Static Analysis also passed for `6e1e2c60f637aafa96874d710876490b66db2525`.
- Live smoke initially failed because `https://3ee95e53.trading-arena.pages.dev` could not read `https://178.104.232.124.sslip.io`: the operator had `CORS_ALLOWED_ORIGINS` effectively defaulted to localhost-only after restart.
- Fixed the live Hetzner runtime by setting:
  - `CORS_ALLOWED_ORIGINS=https://trading-arena.blueprint.tangle.tools,https://trading-arena.pages.dev,https://3ee95e53.trading-arena.pages.dev`
  - restarted `trading-blueprint-runtime.service`; runtime came back active.
- Made the fix durable in commit `cfb8216484ae33279af98dfccc6f2fb88cde686e`:
  - `deploy/go-live.sh` now writes production Arena CORS origins into generated `settings.env`.
  - `settings.env.example` documents the same public operator roster/trade origins.
- Live smoke after CORS fix passes:
  - `pnpm --dir arena smoke:agent-workspace -- --url https://3ee95e53.trading-arena.pages.dev --screenshot-dir ../.evolve/arena-performance-decision-live-6e1e2c6-after-cors`
  - Selected recently traded bot `trading-e625f119-2a0f-4e51-9a35-f54f5a6f316a`.

Screenshot proof:

- `.evolve/arena-performance-decision-live-6e1e2c6-after-cors/1440x900-performance.png`

## 2026-06-02 Focus Workspace Polish Pass

External reference refresh:

- Coinbase Advanced documents the standard advanced-trading first viewport as interactive charts, order book, order panel, open orders, and live trade history: https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/dashboard-overview
- Kraken Pro emphasizes customizable widgets, an essential top ribbon, full-featured charting, live order books, streaming trades, and direct on-chart order management: https://support.kraken.com/articles/kraken-pro-trading-interface-guide and https://pro.kraken.com/
- Polymarket's CLOB docs make bid/ask, spread, midpoint probability, partial fills, and offchain matching/onchain settlement the core market concepts: https://docs.polymarket.com/concepts/prices-orderbook
- Hyperliquid's docs frame the venue as a price-time-priority order book, so its UI needs to expose fills, direction, market, and execution state without hiding order-flow context: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-book
- TradingView Lightweight Charts series markers attach events by time and can auto-scale to avoid clipped markers, which supports using the chart as an execution-evidence surface rather than a decorative sparkline: https://tradingview.github.io/lightweight-charts/tutorials/how_to/series-markers and https://tradingview.github.io/lightweight-charts/docs/next/api/interfaces/SeriesMarkersOptions

### Focus Navigation Alternatives — Chat + Traces

The remaining uncertainty was how much global chrome should survive in Chat and Traces. These views are not ordinary dashboard tabs; they are transcript workspaces where users need to read full reasoning, tool calls, and outcomes without scrolling past headers. Five options were considered:

1. **Winner: Minimal Global Focus Rail + Floating Agent Section Nav**

```text
| icon rail | full transcript canvas                                     |
| 56-64px   |                                    Performance Portfolio... |
```

Score: 9/10. Keeps escape/navigation one click away, removes wallet/network/tx utility chrome from the reading surface, and preserves the route-native section nav. This matches the GTM/creative agent workspace principle while respecting trading app density.

2. **No Global Rail In Focus**

```text
| full transcript canvas |
| back button only       |
```

Score: 8/10 for pure reading, 5/10 for product navigation. It maximizes the transcript but makes switching agents/arena contexts feel modal and can trap users in deep links.

3. **Persistent Full Global Sidebar**

```text
| 256px global sidebar | transcript | inspector |
```

Score: 4/10. Too much width is spent on navigation while users are trying to read messages. This recreates the "three layers of sidebars" problem.

4. **Top Header Only**

```text
| horizontal nav/header |
| transcript            |
```

Score: 6/10. Familiar, but it consumes vertical space, which is exactly what the user is feeling when the composer/final message falls below the fold.

5. **Collapsible Session Rail As Primary Nav**

```text
| sessions/traces rail | transcript | inspector |
```

Score: 7/10 when there are many sessions/runs, 5/10 when there is only one. The current rule is better: show the rail only when it carries real navigation value.

Decision: implement option 1. Chat and Traces now keep the collapsed global rail but shrink it and remove utility controls in focus mode. The transcript gets the viewport, and users still have route-native exits through the floating section nav.

### Shipped In This Slice

- `ArenaAppShell` now detects Chat/Traces focus routes and switches from the normal collapsed `w-20` sidebar to a tighter `w-16` focus rail.
- Focus routes hide the chain switcher, theme toggle, transaction dropdown, and wallet button from the global rail. Those controls remain on normal app routes, but they no longer compete with transcripts.
- Chat focus headers now show the actual agent/bot name when the primary session is selected or when the user is reading public replay data. The old generic `Trading Agent` fallback is gone.
- `ChatTranscript` now uses dynamic agent branding, so assistant reasoning/tool groups are labeled with the actual agent name instead of a generic role.
- Traces reuse the same dynamic branding and fixed a duplicated metadata label: stored run id is `Run ID`, not a second `Trace ID`.
- Performance chart mode controls now read `Price` / `Account` instead of shouting all-caps `PRICE` / `ACCOUNT`, matching the rest of the refined UI hierarchy.
- Transcript icon controls now have explicit button types, labels, and decorative icons hidden from screen readers.

Verification:

- `pnpm --dir arena exec vitest run src/components/layout/__tests__/ArenaAppShell.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx src/components/bot-detail/__tests__/RunsTab.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx` passes: 4 files, 19 tests.
- `node --check arena/scripts/smoke-agent-workspace.mjs` passes.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena exec vitest run --reporter=dot` passes: 61 files, 338 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-focus-polish-smoke-20260602` passes.
- Deterministic BAD token extraction against the built preview passes:
  - `bad design-audit --url http://127.0.0.1:4173/ --profile saas --extract-tokens --json --sink .evolve/bad-arena-focus-polish-20260602`
  - Result: 47 unique colors, 3 fonts, 18 type-scale entries. This confirms the next broad design-system tranche should consolidate tokens rather than add more local visual variants.

Screenshot proof:

- `.evolve/arena-focus-polish-smoke-20260602/1440x900-chat.png`
- `.evolve/arena-focus-polish-smoke-20260602/1440x900-runs.png`
- `.evolve/arena-focus-polish-smoke-20260602/1440x900-performance.png`
- `.evolve/bad-arena-focus-polish-20260602/screenshots/desktop.png`

## 2026-06-02 Sidebar Scope + Product Vocabulary Pass

Problem being solved:

- The left sidebar could still look like a grab bag of public agents because it used broad ownership/relevance semantics instead of strict command permission. That matched the user's complaint: some agents in the sidebar were not callable by the logged-in wallet.
- The app had mostly moved from "bot/trade telemetry" to "agent/execution workspace", but a few high-visibility labels still leaked old or misleading vocabulary.
- The decision inspector treated `PAPER` as a venue, which is wrong; for users it is execution mode.
- Performance decision tape rendered `Notional unavailable`, which made valid decision rows look broken.

Decision:

- Keep public discovery on Arena.
- Keep broad owned/relevant inventory on My Agents.
- Make the persistent left roster strictly commandable: verified operator-backed agent, connected wallet equals submitter/permitted caller, not archived/unknown.
- Do not create another sidebar or another filter state. The sidebar has one job: quick access to agents the current wallet can command.

Shipped in this slice:

- `ArenaAppShell` now uses `isBotCommandableByWallet` for the sidebar roster instead of `isBotOwnedByWallet`.
- The duplicated sidebar heading was collapsed into one `Commandable` label.
- Added a regression proving an operator-owned/service-relevant agent does not appear in the command sidebar unless the wallet is the permitted submitter.
- Route metadata and empty states now say `Agent`, not `Bot`.
- Portfolio summary labels now use `NAV`, `Account Equity`, and `Priced Positions`, removing the `Account Total` / `Bot Equity` / `Positions Value` ambiguity.
- `DecisionInspector` shows paper fills as `Mode: Paper`, not `Venue: PAPER`.
- Performance decision tape hides missing notional instead of showing `Notional unavailable`.

Verification:

- `pnpm --dir arena exec vitest run src/components/layout/__tests__/ArenaAppShell.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx src/components/bot-detail/shared/__tests__/DecisionInspector.test.tsx src/components/bot-detail/__tests__/PositionsTab.test.tsx src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx --reporter=dot` passes: 6 files, 52 tests.
- `node --check arena/scripts/smoke-agent-workspace.mjs` passes.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena exec vitest run --reporter=dot` passes: 61 files, 340 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-sidebar-scope-smoke-20260602b` passes for `smoke-hyperliquid-agent`.

Next broad tranche:

- Token/type consolidation remains the biggest objective design-system debt from BAD extraction: 47 unique colors and 18 type-scale entries.
- Highest ROI next implementation is to extend `WorkspacePrimitives` beyond nav/metrics into shared panel/state/header primitives and migrate active workspace surfaces without adding wrapper chrome.

## 2026-06-02 Focus Route + Routing Contract Pass

Problem being solved:

- Chat and Traces still felt like nested dashboards: global app rail, floating agent tabs, and session/trace rails all competed for the same viewport.
- Focus routes hid some sidebar utilities, but `ArenaAppShell` still subscribed to the full bot store. Fleet sync could therefore rerender the root shell even when the sidebar was invisible.
- Bare agent URLs rendered performance but left the URL non-canonical, which made browser back/default-tab behavior harder to reason about.
- Operations panels were local state only. The app accepted `?panel=...`, but clicking a panel did not update history, reload state, or shareable URLs.
- The parent route treated unknown operator metadata as "chat unavailable"; direct `/chat` and `/runs` loads could flash the wrong state before metadata resolved.
- A mount-time query invalidation in the agent route refetched detail, portfolio, trades, metrics, and summary just from opening the page. Mutation paths already invalidate after real changes, so this was a flicker risk without a user action.

Shipped in this slice:

- Focus routes (`/chat`, `/runs`) now remove the global app sidebar and mobile top chrome entirely.
- Focus routes set the app `main` to `overflow-hidden`, leaving scrolling to the transcript/run panel instead of nesting page scroll with inner scroll.
- The bot-store subscription moved into `DesktopArenaSidebar`, which is not mounted on focus routes.
- Focus routes now have a compact floating toolbar: back to agent performance plus agent section hot buttons.
- Bare `/arena/bot/:id` canonicalizes to `/arena/bot/:id/performance`.
- Chat/Traces nav stays available while operator metadata is unknown; the child components own the final unsupported-state rendering once metadata loads.
- Operations panel changes now call back to the route and persist in `?panel=...`.
- Operations lost one duplicated header row; the current panel name and description live in the single top header.
- Removed route-level blanket query invalidation; targeted invalidation remains in secrets/control mutation paths.

Verification:

- `pnpm --dir arena exec vitest run src/components/layout/__tests__/ArenaAppShell.test.tsx src/components/bot-detail/__tests__/OperationsWorkspace.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx --reporter=dot` passes: 3 files, 14 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena exec vitest run --reporter=dot` passes: 61 files, 343 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-focus-route-smoke-20260602` passes for `smoke-hyperliquid-agent`.
- `git diff --check` passes.

Fanout audit findings to carry forward:

- Navigation/IA: keep eliminating parallel nav models; next route-state fix is deleting/merging the stale `BotHeader` model and adding a "view all commandable" escape hatch.
- Data surfaces: execution count semantics are still the biggest trust gap. Need distinguish total executions, loaded ledger rows, and range executions; add total count/pagination where APIs cap results.
- Data surfaces: build one `InstrumentDisplay` for DEX, Hyperliquid, and prediction markets so execution rows stop relying on clipped text badges.
- Performance/flicker: TradingView chart still rebuilds on refresh. Next chart tranche should create the chart once and update series/markers in-place.
- Performance/flicker: chat/run transcripts still need virtualization or `content-visibility` plus batched stream updates.
- BAD live audit against `987efc7` was partially useful but the process hung after page 2 and was terminated. Partial scores confirmed the public dashboard/provision pages are still weaker than the agent workspace; do not use that interrupted run as a final score.

## 2026-06-02 Execution Count + Chart Lifecycle Pass

Problem being solved:

- The trade ledger API already had pagination totals, but both operator proxy crates stripped the envelope down to a bare array.
- The arena then collapsed metric snapshots, roster counts, and loaded trade rows into one `Executions` label, creating visible contradictions like leaderboard `1` vs ledger `12`.
- Performance charts used TradingView Lightweight Charts, but the component recreated the entire chart/canvas whenever live metrics, trades, or markers refreshed.

Fanout inputs:

- Data/count audit: proxy envelope stripping was the root trust gap; add a frontend `TradePage` and keep legacy-array compatibility.
- Chart/perf audit: `lightweight-charts@5.2.0` supports `series.setData(...)` and marker-plugin `setMarkers(...)`; rebuild only on mode/theme changes.
- IA audit: do not hide provenance behind generic labels; separate total executions from loaded ledger rows.

Shipped in this slice:

- `trading-blueprint-bin` and `trading-instance-blueprint-lib` now return paginated `/trades` envelopes: `{ trades, total, limit, offset }`.
- Both proxies preserve upstream totals when present and synthesize totals for fallback/local legacy arrays.
- Arena added `TradePage` / `useBotTradePage`, exposing `trades`, `total`, `loaded`, `limit`, `offset`, `hasTotal`, `isCapped`, and `legacyArray`.
- `useBotTrades` remains a compatibility wrapper over `useBotTradePage`.
- Trade History shows concise ledger coverage: `Showing 50 of 110` or `50 loaded` for legacy arrays.
- Performance resolves execution counts by provenance: `Total Executions` for trade/metric totals, `Loaded Executions` when loaded rows are the only source beating stale checkpoints.
- The Decision Tape shows `Last N of total` when totals are known and `loaded` only when totals are unavailable.
- TradingView chart runtime now initializes once per active mode, stores chart/series/marker APIs in refs, and updates series data + markers in place on refresh.
- `fitContent()` runs on initial chart creation/mode switch, not every live refresh, preserving the user's viewport.
- Secrets/control mutations invalidate the new `bot-trade-page` query key.

Verification:

- `pnpm --dir arena exec vitest run src/lib/hooks/useBotApi.test.ts src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx src/components/bot-detail/__tests__/PerformanceTab.test.tsx --reporter=dot` passes: 3 files, 50 tests.
- `pnpm --dir arena typecheck` passes.
- `cargo test -p trading-blueprint-bin test_get_bot_trades --test operator_api_tests -- --nocapture` passes: 2 tests.
- `cargo test -p trading-instance-blueprint-lib test_metrics_and_trades_prefer_remote_trading_api_payload --test operator_api_tests -- --nocapture` passes: 1 test.
- `pnpm --dir arena exec vitest run --reporter=dot` passes: 61 files, 349 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit large-chunk warning.
- `cargo check --workspace` passes.
- `cargo fmt` and `git diff --check` pass.

Next high-ROI gaps:

- Add real viewer capability/permitted-caller fields to operator bot records so the sidebar can stop inferring commandability from submitter address.
- Consolidate DEX, Hyperliquid, and prediction market rendering into one `InstrumentDisplay` with logos/market image/outcome metadata.
- Make the professional chart a single integrated surface: candles + fills + volume + lower NAV/PnL pane instead of Price/Account as mutually exclusive modes.
- Continue reducing global/sidebar chrome: product nav should not become a scrolling agent roster.

## 2026-06-02 Fan-Out Audit + Market Pulse Tranche

Problem being solved:

- The homepage still did not answer "is the arena alive right now?" fast enough. The trade tape, platform volume, and agent ranking were split across unrelated surfaces.
- The performance workspace was closer to a trading terminal, but owner copilot could still displace the execution tape, making the most important proof of agent behavior disappear.
- Trade display logic had drifted across homepage tape, performance tape, trade history, and helper modules. That duplication is how `WET`/clipped market labels and inconsistent long/short coloring come back.
- Latest-trades fallback was too coarse: if one operator aggregate endpoint failed while another succeeded, the hook did not fetch per-bot trades for the failed operator, so live fills could vanish.

Fan-out conclusions:

- IA/product audit winner: **Exchange Terminal + Agent Copilot**. The primary surface is execution proof and market/account charting; chat is a docked tool when the user can command the agent, not a replacement for fills.
- Homepage winner: **Market Pulse**. First viewport should show platform volume, live fill tape, top return, most active agent, and deploy path. Leaderboard becomes the deeper ranking surface below.
- Trading benchmark finding: exchange dashboards separate market activity, account state, execution ledger, and orders. We should keep using TradingView Lightweight Charts, but the product should behave more like Hyperliquid/Kraken/Coinbase than a generic card dashboard.
- Code/perf audit winner: centralize trade display and bot visibility policy first. This yields trust and speed without a large rewrite.

References checked:

- Coinbase Advanced dashboard overview: `https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/dashboard-overview`
- Kraken Pro interface guide: `https://support.kraken.com/vi/articles/kraken-pro-trading-interface-guide?mode=consumerapp`
- Hyperliquid order book docs: `https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-book`
- Polymarket order book/prices docs: `https://docs.polymarket.com/concepts/prices-orderbook`
- TradingView Lightweight Charts markers: `https://tradingview.github.io/lightweight-charts/tutorials/how_to/series-markers`

Shipped in this slice:

- Added `arena/src/lib/tradeDisplay.ts` with shared action labels, buy/sell tone policy, market labels, Hyperliquid perp labels, instrument badge text, mode labels, USD formatting, and age formatting.
- Added `arena/src/lib/botVisibility.ts` with shared public leaderboard, operator trade candidate, platform volume candidate, and per-operator fallback selection policy.
- `LatestAgentTrades` is now a `Live Fill Tape`: row-click opens the agent performance page, action labels use shared long/short semantics, market badges use shared instrument labels, and timestamps carry absolute titles.
- `useLatestAgentTrades` now falls back per failed aggregate operator instead of waiting for every aggregate endpoint to fail.
- `usePlatformVolumeSeries` uses the same operator candidate policy and fallback predicate.
- Homepage changed to a `Market Pulse` command surface: compact live header, platform stats, top-return and most-active links, platform volume chart, and live fill tape above the leaderboard.
- Performance market mode now leads with market stats: last price, range high/low, volume, range PnL, and total trades. Account/NAV stats stay in Account mode.
- Owner copilot no longer replaces execution evidence; recent trades and the decision inspector remain visible, with copilot docked below when authenticated.
- Agent header metrics become visible at `1360px` instead of waiting for `2xl`, reducing the "where did the agent metrics go?" issue on normal desktop widths.
- Global app nav now says `My Agents` instead of generic `Home`.

Verification so far:

- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/routes/__tests__/index.test.tsx src/lib/tradeDisplay.test.ts src/lib/botVisibility.test.ts src/lib/hooks/useBotApi.test.ts src/lib/platformVolume.test.ts` passes: 6 files, 42 tests.
- `pnpm --dir arena exec vitest run src/components/layout/__tests__/ArenaAppShell.test.tsx` passes: 1 file, 7 tests.
- `pnpm --dir arena test` passes: 64 files, 367 tests.
- `pnpm --dir arena build` passes with the pre-existing ConnectKit/chunk-size warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-fanout-market-pulse-smoke-20260602` passes for `smoke-hyperliquid-agent`.
- BAD token extraction against the production preview passes:
  - `bad design-audit --url http://127.0.0.1:4173/ --profile saas --extract-tokens --json --sink .evolve/bad-arena-market-pulse-20260602`
  - Result: 42 unique colors, 3 fonts, 17 type-scale entries. Prior broad extraction was 47 colors / 18 type-scale entries.
- `git diff --check` passes.

Still open after this tranche:

- Replace text-only instrument badges with a real shared `InstrumentDisplay` that can render token logos, Hyperliquid assets, and prediction market imagery/outcomes.
- Convert the performance chart into an integrated terminal surface: candles + fills + volume + lower NAV/PnL pane, not a Price/Account toggle.
- Rework operations into a safety cockpit; right now it is still too much metadata/admin surface.
- Add operator-level bot summaries so homepage enrichment does not have to lean on many per-bot requests.

## 2026-06-02 Data Purpose Audit + Layout Selection

Every visible element now has to justify one of five jobs:

1. What is happening now?
2. Which agent did it?
3. Which market/instrument was touched?
4. What was the size/result/risk?
5. What action or drilldown is available?

Anything else is demoted, hidden behind details, or removed from the first viewport.

Layout alternatives considered:

### 1. Exchange Terminal + Agent Copilot — 9.4/10, selected

```text
Home      [Market Pulse: volume chart] [Latest Trades]
          [Leaderboard: ranked agents, active first]

Agent     [compact agent strip: name/operator/status/return/DD/trades]
Perf      [professional chart + markers] [recent trades + selected decision]
Portfolio [account/risk strip] [positions + trade history]
Chat/Run  [full-height transcript] [explicit details drawer]
Ops       [safety cockpit] [evidence/evolution/policy/runtime drilldowns]
```

Why: best matches professional trading workflows. Chart, fills, exposure, and reasoning stay synchronized; the AI agent is the operator behind the terminal rather than a dashboard decoration.

### 2. Fleet Command Center — 8.5/10

```text
Home owns venue heatmap, live volume, latest trades, alerts, all agents.
Agent pages are drilldowns.
```

Strong for observers and platform ops, weaker when a user evaluates one agent's trading decisions.

### 3. Trace-First Replay Studio — 8.0/10

```text
Transcript is primary.
Chart/fills/positions become synchronized evidence panes.
```

Best for debugging cognition, not first-glance trading quality.

### 4. Modular Widget Terminal — 7.6/10

```text
User arranges chart, book, fills, transcript, positions, controls.
```

Powerful later, but configurability would currently hide weak defaults.

### 5. Minimal Portfolio Tracker — 6.2/10

```text
Leaderboard + per-agent chart + simple trade table.
```

Clean but too passive for a live self-improving trading system.

Data/button decisions for the next tranche:

- Keep live status, agent identity, operator address, account value, return, drawdown, trade count, chart, latest trades, positions, trade history, transcript, validation evidence, and safety envelope.
- Rename Executions -> Trades, NAV -> Account Value except vault internals, Risk Score -> Validator Score, Trade Ledger -> Trade History, Decision Tape -> Recent Trades.
- Demote Sharpe when sample size is weak, connected-operator coverage, raw IDs, generic product claims, and public owner-only affordances.
- Remove text-only market avatars wherever a shared instrument component can render token logos, prediction outcomes, or perp identity.
- Move copilot into a secondary/drawer surface on Performance; move session/run lists into compact selectors in immersive Chat/Runs; move identity/provenance refs below the safety cockpit.

Current implementation tranche:

1. Ship shared trade/instrument identity across homepage tape and performance rail.
2. Remove chart/list flicker from platform volume and leaderboard sparklines.
3. Tighten homepage/leaderboard terminology and row navigation.
4. Keep the larger dynamic-auth and operator-summary refactors as separate data-correctness patches because they touch operator session/API contracts.

### Shipped

- Added shared `TradeInstrumentDisplay` on top of existing asset display primitives.
- Homepage and performance trade rails now use real token-pair logos for DEX trades, Hyperliquid perp identity/size labels, and prediction-market question/outcome labels.
- Removed the old clipped text instrument badge helper from production code.
- Replaced per-row Chart.js leaderboard sparklines with a tiny SVG sparkline, eliminating dynamic Chart.js imports and canvas create/destroy churn.
- Reworked `PlatformVolumeTradingChart` to keep one Lightweight Charts runtime and update series data in place on live refresh/range changes.
- Removed the duplicated `Priced Positions` account card that contradicted account value by excluding cash.
- Normalized visible labels: dashboard `Executions` -> `Trades`, `Avg Risk Score` -> `Avg Validator`, leaderboard `Risk Score` -> `Validator`.
- Shortened leaderboard search placeholder and added USD unit metadata to platform volume chart readout.

### Verification

- `pnpm --dir arena exec vitest run src/components/bot-detail/shared/__tests__/AssetDisplay.test.tsx src/lib/tradeDisplay.test.ts src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/PositionsTab.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx src/routes/__tests__/index.test.tsx --reporter=dot` passes: 6 files, 38 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena test` passes: 65 files, 370 tests.
- `pnpm --dir arena build` passes with the pre-existing large ConnectKit chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-data-purpose-smoke-20260602` passes for `smoke-hyperliquid-agent`.
- `bad design-audit --url http://127.0.0.1:4173/ --profile saas --extract-tokens --json --sink .evolve/bad-arena-data-purpose-final3-20260602` passes extraction: 42 colors, 3 fonts, 17 type-scale entries.

### Residual Findings

- BAD deep audit scored the unauthenticated homepage poorly, but the same run killed the preview before pages 2-4 and produced false zero-page scores. Treat it as advisory only.
- Real remaining product gaps: persistent wallet/account capital context, deploy cost/risk preview, operations safety cockpit, operator-level bot summaries, URL-scoped auth for same-kind operators, and integrated chart lower pane.

## 2026-06-02 Navigation + Scope Audit

Rule: public discovery and wallet command surfaces must stay separate.

- Public surfaces can show leaderboard agents, platform volume, and latest trades across operators.
- Wallet surfaces (`/dashboard`, deploy follow-ups, service expansion, command shortcuts) should show only agents relevant to the connected wallet: submitter/caller match, direct operator match, matching wallet service vault, or tracked local provision. Owned/operated service membership keeps the service visible, but does not by itself make every bot on that service a wallet agent.
- The global app sidebar should remain product navigation only. It should never become a live agent roster because that mixes public discovery with user commandability and creates the "random agents in my sidebar" failure mode.
- Service expansion inside `My Agents` should not inherit every public bot on that service. It should use the same wallet-scoped agent set as the main dashboard cards.
- Collapsed navigation is a user workspace preference, so it should persist across route changes and reloads.

Implementation selected:

1. Keep `/api/bots` fleet reads public for homepage/leaderboard/volume.
2. Keep `useBots()` broad because multiple public surfaces depend on it.
3. Scope `dashboard.tsx` service rows from `visibleMyBots`, not `authoritativeBots`.
4. Persist `ArenaAppShell` desktop sidebar collapse state in localStorage.

Rejected alternatives:

- Auth-scope all operator bot sync: would break public leaderboard, latest trades, and platform volume.
- Re-add a callable-agent list in the sidebar: worsens the three-sidebar problem and repeats the original confusion.
- Hide owned services if no commandable bots are visible: loses useful service/provision state.

## 2026-06-02 Focus + Data Semantics Audit

Fan-out findings applied in this tranche:

- Navigation: agent routes already hide the global sidebar, but focus pages still felt layered because the route header, chat/run header, and transcript chrome all stacked. `Risk & Ops` remains the largest nested-nav surface and should be split or collapsed next.
- Data semantics: displayed trade count mixed metrics snapshots, roster values, and trade-ledger totals. The ledger total is the only honest count for visible executions.
- Density/performance: focus chat/runs should be full-height shells, not cards inside cards; portfolio should avoid nested page scroll; trade instruments should render through one shared component.

Implementation selected:

1. Make chat/runs focus mode use a floating icon control cluster instead of a layout-consuming top bar.
2. Hide the internal chat/run headers and decision strip in immersive mode so the transcript owns the viewport.
3. Flatten Portfolio into two fixed-height panels with stable scroll gutters: `Portfolio` and `Executions`.
4. Reuse `TradeInstrumentDisplay` in Trade History for token pairs, Hyperliquid perps, and prediction markets.
5. Make `/trades.total` canonical for displayed trade count; metrics/roster counts are fallbacks only.

Shipped changes:

- `AgentWorkspaceShell` focus controls are now icon-only with accessible labels.
- `ChatTab` and `RunsTab` immersive shells no longer render `glass-card` / rounded outer chrome and no longer show the extra decision strip.
- `PortfolioWorkspace` now keeps panel headers fixed and scrolls only the data bodies.
- `TradeHistoryTab` uses the shared instrument renderer and no longer labels historical Hyperliquid rows as `USDC/USDC`; unknown Hyperliquid assets fall back to `Hyperliquid`.
- `useBotEnrichment` now prefers trade ledger totals over stale/synthetic metric counts.
- `smoke-agent-workspace.mjs` now validates the new `Executions` label and clicks icon-only focus controls by accessible name/title.

Verification:

- Focused suite passes: `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx src/routes/__tests__/bot-workspace-routing.test.tsx src/components/bot-detail/shared/__tests__/WorkspacePrimitives.test.tsx src/lib/hooks/useBotEnrichment.test.ts src/components/bot-detail/__tests__/ChatTab.test.tsx src/components/bot-detail/__tests__/RunsTab.test.tsx --reporter=dot` (6 files, 55 tests).
- Full arena test passes: `pnpm --dir arena test -- --reporter=dot` (65 files, 378 tests).
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes with the pre-existing large ConnectKit chunk warning.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-focus-scope-smoke-20260602` passes and captures 1440x900 / 1280x800 screenshots for home, performance, portfolio, runs, chat, and operations.
- `git diff --check` passes.

Still open:

- Split or simplify `Risk & Ops`; it is still top-level tab plus nested tab bar.
- URL-sync selected run/session state so browser history is meaningful within trace/chat surfaces.
- Memoize trade rows/transcript markdown and remove expensive table/glass paint layers in the next performance tranche.
- Reconcile current account value across performance, portfolio, and leaderboard using live portfolio state where possible.
- Whitelist/redact public run/trade fields if public bot state should not expose strategy reasoning or endpoint topology.

## 2026-06-02 Workspace Language + Route Semantics Loop

Decision: the product surface should call autonomous execution histories `Runs`, not `Traces`. `trace_id` remains a backend/audit field, but navigation, empty states, loading states, and owner-only copy should use the same word the user sees in the workspace.

Shipped changes in this loop:

- Workspace nav `Traces` -> `Runs`.
- Workspace nav `Risk & Ops` -> `Operations`.
- Runs sidebar, empty states, loading state, owner-only state, transcript placeholder, and no-transcript detail titles now use `Runs` / `run` language.
- Operations validation copy now says simulation results instead of simulation traces.
- Smoke expectations now enforce `Runs` and `Operations` visible copy.

Route-stack decision:

- Keep focus-mode `Back to agent` links as `replace`. Removing `replace` regresses browser history by sending the user back into full-screen Chat/Runs after they have already returned to the agent view.

Verification:

- `pnpm --dir arena exec vitest run src/routes/__tests__/bot-workspace-routing.test.tsx src/components/bot-detail/__tests__/RunsTab.test.tsx --reporter=dot` passes: 2 files, 18 tests.

## 2026-06-02 Expert Trading Terminal Alternatives

Reference research used for this pass:

- Hyperliquid order books are price-time priority CLOBs with perp margin checks, so an agent terminal must expose execution sequence, fills, and margin/account state as first-class context: https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/order-book
- Polymarket prices are probabilities and the order book/spread determines executable price, so prediction-market agents need probability, spread/depth, liquidity, outcome, and resolution context instead of generic token-pair UI: https://docs.polymarket.com/concepts/prices-orderbook
- Coinbase Advanced positions itself around TradingView charting plus configurable widgets for split-second execution, which validates a terminal-style workspace over scattered dashboard cards: https://www.coinbase.com/advanced-trade
- Kraken Pro exposes chart, order book, market trades, and order/position context in the trading interface; the market-trades feed uses direction/color as immediate execution signal: https://support.kraken.com/articles/kraken-pro-trading-interface-guide
- IBKR Mosaic puts charts, watchlists, quote detail, order entry, portfolio, order monitor, and news in one customizable window, which is the right model for a serious multi-venue agent operator: https://www.ibkrguides.com/traderworkstation/mosaic-layout.htm
- Lightweight Charts supports multi-pane/price-scale style work, markers, and chart synchronization primitives; we should extend the current chart instead of replacing it: https://www.tradingview.com/blog/en/announcing-lightweight-charts-3-0-19155/

### Alternative 1 — Agent Terminal Cockpit

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Agent strip: name · mode · operator · account · return · DD · trades         │
├──────────────────────────────────────────────────────────┬───────────────────┤
│ Chart: venue candles + fill markers + volume             │ Execution         │
│                                                          │ Inspector         │
│ Lower pane: NAV / PnL / drawdown                         │ selected fill     │
│                                                          │ recent fills      │
│                                                          │ rationale         │
├──────────────────────────────────────────────────────────┴───────────────────┤
│ Compact rail: positions · open risk · live run status · promotion status      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Rating: 9.4/10. Best default because it is closest to Hyperliquid/Kraken/Coinbase mental models while adding the agent-specific advantage: why the fill happened. It makes the interesting thing obvious: chart move, trade marker, selected decision, current account state.

Tradeoff: requires disciplined right-rail hierarchy and strong fallbacks for agents without market candles.

### Alternative 2 — Quant Mission Control

```text
┌─────────────────────────────┬────────────────────────────────────────────────┐
│ Strategy state + promotion  │ Runs transcript / current reasoning cycle      │
│ risk budget + drift         │                                                │
├─────────────────────────────┼────────────────────────────────────────────────┤
│ chart + executions          │ evaluator scores + self-improvement candidates │
└─────────────────────────────┴────────────────────────────────────────────────┘
```

Rating: 8.7/10. Strong for self-improving agents and genetic orchestration, weaker for fast trading because price/execution is not always first.

### Alternative 3 — Exchange Clone Pro

```text
┌─────────────┬────────────────────────────┬──────────────┐
│ Markets     │ Chart                      │ Order book   │
│ watchlist   │                            │ / depth      │
├─────────────┴────────────────────────────┴──────────────┤
│ Positions · orders · fills · agent logs                  │
└──────────────────────────────────────────────────────────┘
```

Rating: 8.1/10. Familiar to active traders, but our agents do not always expose a real order form/order book across all venues. It risks copying exchange furniture without exposing the agent edge.

### Alternative 4 — Arena Intelligence Dashboard

```text
┌──────────────────────────────────────────────────────────┐
│ Platform volume · latest trades · leaderboard             │
├──────────────────────────────┬───────────────────────────┤
│ selected agent preview       │ copilot / trade tape       │
└──────────────────────────────┴───────────────────────────┘
```

Rating: 7.8/10. Best for discovery/homepage, not best for a selected agent. Keep this model for `/`, not `/arena/bot/:id/performance`.

### Alternative 5 — Conversation-First Agent Room

```text
┌──────────────────────────────────────────────────────────┐
│ Full transcript / chat / run playback                     │
├──────────────────────────────┬───────────────────────────┤
│ compact chart                │ compact portfolio          │
└──────────────────────────────┴───────────────────────────┘
```

Rating: 7.2/10. Good for understanding long reasoning sessions, but too slow for trading unless the user explicitly enters Chat/Runs focus mode. We already moved Chat/Runs toward this.

Selected direction: Alternative 1 for agent Performance, Alternative 2 for Operations, Alternative 4 for Home. Do not introduce another sidebar. Build professional terminal density inside the existing route-native shell.

Immediate implementation rule:

- Performance should have one right-rail concept: `Execution Inspector`. `Execution Tape` and `Fill Ledger` are the same mental object and must merge.
- Operations should reuse shared workspace navigation primitives; no hand-rolled second nav that drifts from the main workspace system.
- Chart work should extend the current Lightweight Charts runtime, preserving existing candle, marker, volume, and lower NAV pane behavior.

Shipped in this tranche:

- Performance chart heading now names the workspace like a terminal (`ETH-PERP Terminal` for Hyperliquid market mode, `Account Terminal` for NAV mode) instead of generic widget copy.
- Performance right rail now has one concept: `Execution Inspector`.
- The fill list inside that rail is `Recent Fills`, with `Side / Instrument / Notional`, not a separate `Fill Ledger`.
- Operations panel navigation now uses the shared `WorkspaceNavStrip` primitive, removing duplicated tab styling and behavior.
- Operations Overview now fills the safety cockpit with real guardrails: max drawdown, position cap, stop loss, and runtime window.

Verification so far:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/__tests__/OperationsWorkspace.test.tsx src/components/bot-detail/shared/__tests__/WorkspacePrimitives.test.tsx --reporter=dot` passes: 3 files, 21 tests.
- `pnpm --dir arena typecheck` passes.

## 2026-06-02 Sandbox Rail + Live Fill Tape Alignment Pass

Source audit:

- Reviewed `/home/drew/code/agent-dev-container/products/sandbox/web/src/layouts/DashboardLayout.tsx`, `src/globals.css`, `src/components/ThemeCustomizer.tsx`, and the sandbox UI package rail primitives before touching Arena shell code.
- Reused the sandbox direction, not the package wholesale: compact icon rail density, single-purpose footer controls, direct active nav states, and bounded `h-screen` workspace behavior. Arena keeps its existing wallet, chain, transaction, route, and auth primitives.

Shipped in this slice:

- Global sidebar footer no longer wraps `ThemeToggle` in oversized card-like containers. Collapsed sidebar now uses a tight icon rail for expand, chain, theme, and transaction history. Expanded sidebar uses one compact footer control row plus wallet below it.
- Desktop sidebar width tightened from `w-20` to `w-16` when collapsed, with 44px nav targets and sandbox-style active item treatment.
- Homepage Market Pulse command row is now viewport-bounded and gives both primary siblings the same `h-full min-h-0` contract.
- `Live Fill Tape` panel no longer tries to squeeze the full trade table into a 540px sibling. Panel mode renders a purpose-built vertical execution feed with sticky headers, internal `overflow-y-auto`, agent identity, action, instrument, mode, and notional. The full wide table remains available for the non-panel variant.
- Smoke navigation assertions now inspect the actual sidebar nav DOM labels instead of brittle body-text matches, which survives collapsed/icon rail layout changes.

Verification:

- `pnpm --dir arena exec vitest run src/components/layout/__tests__/ArenaAppShell.test.tsx --reporter=dot` passes: 1 file, 8 tests.
- `pnpm --dir arena exec vitest run src/components/arena/__tests__/LatestAgentTrades.test.tsx src/routes/__tests__/index.test.tsx --reporter=dot` passes: 2 files, 3 tests.
- `pnpm --dir arena test -- --reporter=dot` passes: 66 files, 380 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-fill-tape-feed-smoke-20260602` passes.
- Visual inspection of `.evolve/arena-fill-tape-feed-smoke-20260602/1440x900-home.png` and `1280x800-home.png` confirms the volume chart and fill tape share the same height, the fill tape scrolls internally, and there is no horizontal tape scrollbar.

## 2026-06-02 Hyperliquid Terminal Live-Data Correction Pass

Production evidence after `fix: upgrade arena performance terminal chart` (`ae27508`):

- GitHub Actions:
  - `Deploy arena UI to Cloudflare Pages` passed: `26814302862`.
  - `Static Analysis` passed: `26814302854`.
  - `CI` passed: `26814302875`.
- Live smoke:
  - `pnpm --dir arena smoke:agent-workspace -- --url https://trading-arena.blueprint.tangle.tools --allow-empty --screenshot-dir ../.evolve/arena-production-hyperliquid-terminal-smoke-20260602-ae27508` passed.
  - Selected real recently traded bot: `trading-eecc41ef-255f-4360-82c5-a59306d1c92c`.
  - Browser operator API/CORS passed for `https://178.104.232.124.sslip.io`.

Live screenshot audit:

- The production NAV chart could render with `Account` heading while the `Market` chart-mode button still appeared selected when no market candles were available.
- The terminal `Fills` strip could show a checkpoint-derived count (`168`) while the visible ledger rail and agent header showed the inspectable trade history count (`100`). That is technically explainable but product-hostile; the trading surface should privilege the ledger the user can inspect unless the trade API returns an explicit total.
- DEX pair labels in the terminal fills rail were inheriting the shared asset-pair primary text color instead of the terminal override, making `USDC/WETH` too low contrast.
- Market-mode x-axis labels were too long at 1280px because candle ticks could pick NAV checkpoint labels like `Jun 2, 3:10 AM`.

Shipped in this slice:

- Chart mode buttons now reflect the effective rendered mode. If market candles are unavailable, `Market` is disabled and `NAV` is the active mode.
- Fill counts now prefer the trade API total, then loaded ledger rows, then checkpoint metrics as a fallback. This keeps the Performance strip aligned with the trade rail and agent header in live data.
- `AssetPairDisplay` now accepts `labelClassName`, so `TradeInstrumentDisplay` can render DEX pairs with readable terminal text while preserving token logos.
- Performance terminal rail passes explicit terminal label color for selected and listed fills.
- Market chart axis labels now use compact candle ticks in market mode and prefer candle labels over NAV checkpoint labels.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/shared/__tests__/AssetDisplay.test.tsx --reporter=dot` passes: 2 files, 22 tests.
- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/shared/__tests__/AssetDisplay.test.tsx src/components/bot-detail/__tests__/performanceChart.test.ts --reporter=dot` passes: 3 files, 30 tests.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-performance-terminal-count-mode-smoke-20260602-axis` passes.
- Visual inspection of `.evolve/arena-performance-terminal-count-mode-smoke-20260602-axis/1280x800-performance.png` confirms compact x-axis labels and readable instrument labels in the terminal fill rail.
- `pnpm --dir arena test` passes: 66 files, 383 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes.

## 2026-06-02 Hyperliquid Terminal Contrast Correction

Live screenshot audit after `fix: align arena terminal live data` (`7fdbb1f`):

- `.evolve/arena-production-terminal-count-mode-smoke-20260602-7fdbb1f/1280x800-performance.png` confirmed the mode fallback, fill count, and DEX-pair label fixes were live.
- The same 1280px screenshot exposed one remaining theme leak: neutral terminal strip values such as account equity, fills, and high/low inherited the global light-theme primary text token inside the dark terminal shell.

Shipped in this slice:

- Terminal stat values now keep exchange-style success/error colors only for directional PnL/move values.
- Neutral terminal stat values are forced to the terminal foreground color (`#f6fefd`) so light and dark page themes cannot reduce contrast inside the chart shell.
- `PerformanceTab` regression coverage now asserts the NAV fallback button state and the terminal foreground class on neutral account stats.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/PerformanceTab.test.tsx src/components/bot-detail/shared/__tests__/AssetDisplay.test.tsx src/components/bot-detail/__tests__/performanceChart.test.ts --reporter=dot` passes: 3 files, 30 tests.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-performance-terminal-neutral-stats-smoke-20260602` passes.
- Visual inspection of `.evolve/arena-performance-terminal-neutral-stats-smoke-20260602/1280x800-performance.png` confirms neutral terminal stats render bright inside the Hyperliquid-style chart shell.

## 2026-06-02 Home Command Terminal Pass

Pre-patch evidence:

- Ran `bad design-audit --url https://trading-arena.blueprint.tangle.tools --pages 1 --profile defi --audit-passes standard --sink .evolve/bad-arena-home-continuation-20260602 --json`.
- BAD scored production Home at `6/10` legacy, `5.5/10` v2 rollup. Highest-leverage dimensions were product intent (`5/10`) and workflow (`5/10`).
- The reliable findings matched the live screenshot: the first viewport was split between repeated KPI cards, a chart/tape row, and a leaderboard that started below the fold. The page read like a dashboard stack instead of an arena command surface.

Five alternatives considered:

1. **Chart-left command terminal**

```text
┌ compact arena header: agents · 30D volume · 30D fills · deploy ┐
├──────────────────────────────────────┬─────────────────────────┤
│ Platform volume chart                │ Live fills              │
│                                      ├─────────────────────────┤
│                                      │ Top agents              │
└──────────────────────────────────────┴─────────────────────────┘
```

Score: 9.1/10. Best for the default Home route because it keeps the most exchange-like object, volume over time, dominant while making the two action feeds visible: current fills and winners.

2. **Tape-first arena**

```text
┌ header ┐
├──────────────────────────┬─────────────────────────────────────┤
│ Volume chart             │ Live fills full height              │
├──────────────────────────┤                                     │
│ Top agents compact       │                                     │
└──────────────────────────┴─────────────────────────────────────┘
```

Score: 8.4/10. Strong for "is anything happening right now" but weaker as a trading product because it demotes platform volume and ranking.

3. **Leaderboard-first exchange board**

```text
┌ header ┐
├──────────────────────────────┬─────────────────────────────────┤
│ Top agents table             │ Volume chart                    │
│                              ├─────────────────────────────────┤
│                              │ Live fills                      │
└──────────────────────────────┴─────────────────────────────────┘
```

Score: 8.0/10. Good for competition, weaker for the agent system because live market activity feels secondary.

4. **Three-column exchange split**

```text
┌ leaderboard ┬ chart ┬ fills ┐
```

Score: 7.5/10. Familiar from exchange terminals but too cramped at 1280px after the global sidebar.

5. **Copilot-first Home**

```text
┌ chat/copilot ┬ chart + fills + leaderboard preview ┐
```

Score: 7.0/10. Better for onboarding, worse for the core promise that interesting trading activity should be obvious before the user asks.

Selected implementation: Alternative 1.

Shipped in this slice:

- Home now uses a bounded `Arena market terminal` region instead of a stacked chart row plus below-fold leaderboard.
- The command header is compact and removes duplicated KPI card chrome. It shows only the platform title, active pulse, agent count, 30D volume, 30D fills, and Deploy.
- The platform volume chart owns the left side of the first viewport.
- The right rail stacks `Fills` and `Top agents`, so current activity and winners are visible at 1280px without scrolling.
- `LatestAgentTrades` panel mode now uses a compact three-column feed: `Time`, `Agent / Market`, `USD`, with the action pill and notional in the right column. This fixes the clipped Market/USD columns that appeared when the right rail narrowed.
- Top-agent strategy labels now use `HL Perp` instead of leaking raw `hyperliquid_perp` strings.
- Missing bot-level fill counts now render as `-` instead of contradicting the live fill tape.

Verification:

- `pnpm --dir arena exec vitest run src/routes/__tests__/index.test.tsx src/components/arena/__tests__/LatestAgentTrades.test.tsx --reporter=dot` passes: 2 files, 3 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-home-command-terminal-smoke-20260602-v2` passes.
- Visual inspection of `.evolve/arena-home-command-terminal-smoke-20260602-v2/1280x800-home.png` confirms the chart, fill tape, and top-agent panel all fit in the first viewport and the fill tape no longer clips Market/USD.

## 2026-06-02 Portfolio + Leaderboard Explorer Pass

User-reported problems:

- Portfolio felt like a 0-2/10 surface: card rail, mismatched tables, excessive labels, too many font sizes, and an executions panel with a meaningless `50 loaded` pill.
- The fill detail presentation repeated paper/validation/execution concepts and made paper trades feel like prose instead of ledger entries.
- The app needed a separate leaderboard/agent explorer instead of forcing Home to carry the full table.
- Collapsed global sidebar leaked logo text; transaction dropdown could fall behind the page; the chain/footer cluster felt fragile.

### Component Purpose Audit

| Surface | Component | Purpose | Kept / Changed | Deletion rule |
|---|---|---|---|---|
| Global shell | `ArenaAppShell` | Product navigation and account controls | Kept, with `Leaderboard` route added and collapsed mark fixed to icon-only | Remove any nav item that is not a primary workflow |
| Global shell | `TxDropdown` | Transaction inspection | Kept, now supports upward menu placement in the sidebar | Do not let popovers live behind workspace panes |
| Home | `_index.tsx` | First-screen live market terminal | Kept as chart + fills + compact winners | Do not re-add the full leaderboard table to Home |
| Leaderboard | `leaderboard.tsx` | Etherscan-style agent explorer | Added as separate route with platform volume, fill tape, metrics, full agent table | If it does not rank, inspect, or explain platform activity, it belongs elsewhere |
| Leaderboard table | `LeaderboardTable` | Dense ranked agent list | Changed from large mixed-font table to explorer ledger | Remove medals/card styling that competes with the table |
| Portfolio parent | `PortfolioWorkspace` | Current exposure + executions | Changed from side-by-side card/table mismatch to stacked ledgers | Portfolio should not use card rails for positions |
| Positions | `PositionsTab` | Account strip + positions ledger | Added `workspaceLayout="ledger"` with dense tables | Labels must be table headers or compact metric labels only |
| Executions | `TradeHistoryTab` | Paged execution ledger | Added offset pagination, visible size/USD/mode columns, simplified expanded row | Never show `loaded` copy or duplicate paper/validation prose |
| Chart | `PerformanceTab` + chart components | Professional market/NAV terminal | Prior pass retained; no new change here | Trade count must come from trade ledger, not just metric checkpoints |
| Runs/Chat | `RunsTab`, chat routes | Full transcripts/control conversation | Still needs session-list work; not addressed in this slice | Hide owner-only terminals rather than over-explaining access |

### Leaderboard / Explorer Alternatives

1. **Winner: Explorer Split**

```text
┌ metrics: 24H volume · fills · fills/hr · active ┐
├ platform volume chart ┬ latest fills tape        │
├───────────────────────┴─────────────────────────┤
│ full ranked agent table                          │
└──────────────────────────────────────────────────┘
```

Score: 9/10. It cleanly separates the homepage command terminal from the deeper explorer workflow. It also maps to Etherscan-style mental models: summary, chart, latest activity, full table.

2. **Leaderboard-Only Table**

```text
┌ metrics ┐
├ full table only ┤
```

Score: 6.5/10. Fast and simple, but it fails the product requirement to make platform volume and trading velocity obvious.

3. **Trade-Tape-First Explorer**

```text
┌ latest fills full width ┐
├ chart + table           ┤
```

Score: 7.5/10. Strong for activity, weak for ranking and operator comparison.

4. **Analytics Dashboard**

```text
┌ volume ┬ trades/hr ┬ operators ┐
├ charts everywhere              ┤
└ table below                    ┘
```

Score: 6/10. Too dashboard-like and likely to reintroduce repeated labels and dead space.

5. **Agent Cards Grid**

```text
┌ top agents cards ┐
├ volume/tape      ┤
```

Score: 5/10. It looks less like a trading system and makes comparison worse.

Selected implementation: Alternative 1.

### Portfolio Alternatives

1. **Winner: Stacked Ledger**

```text
┌ Portfolio: compact account strip + positions table ┐
├ Executions: paged table with detail expansion       ┤
└─────────────────────────────────────────────────────┘
```

Score: 9/10. Best use of width, aligned visual language, and no mismatch between cards and tables.

2. **Two-Column Matching Tables**

```text
┌ positions table ┬ executions table ┐
```

Score: 7/10. Better than the old card rail, but too cramped at 1280px and still creates independent scroll conflicts.

3. **Execution-First Portfolio**

```text
┌ executions large ┐
├ positions small  ┤
```

Score: 7.5/10 for active scalpers, weaker for portfolio inspection.

4. **Tabbed Positions / Executions**

```text
┌ internal tabs ┐
├ table         ┤
```

Score: 6/10. Saves space but hides one half of the portfolio workflow.

5. **Cards With Better Alignment**

Score: 4/10. Still wrong primitive. Positions and fills are ledgers.

Selected implementation: Alternative 1.

Shipped in this slice:

- Added `/leaderboard` as a separate route with 24H volume, fills, fills/hour, active-agent metric strip, platform volume chart, latest fill tape, and full ranked agent table.
- Added `Leaderboard` to global navigation and linked Home to the new route.
- Reworked `LeaderboardTable` into a dense explorer ledger with operator identicons, strategy, account, 30D return, Sharpe, drawdown, win rate, fill count, and state.
- Extracted `formatCompactUsd` into `arena/src/lib/format.ts` for shared Home/Leaderboard formatting.
- Changed `PortfolioWorkspace` to stacked ledgers.
- Added `workspaceLayout="ledger"` to `PositionsTab`.
- Wired `useBotTradePage` to existing backend `offset` support.
- Replaced `TradeHistoryTab` coverage badges with range + prev/next pager.
- Added size, USD, and mode columns to compact execution rows.
- Removed the heavy decision inspector from expanded trade rows while preserving validator details, simulation detail, and real agent/validator reasoning.
- Fixed collapsed sidebar branding to icon-only and opened the transaction dropdown upward from the sidebar footer.

Verification:

- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/TradeHistoryTab.test.tsx src/components/bot-detail/__tests__/PositionsTab.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx src/routes/__tests__/leaderboard.test.tsx src/routes/__tests__/index.test.tsx --reporter=dot` passes: 5 files, 42 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena test` passes: 67 files, 386 tests.
- `pnpm --dir arena build` passes. The existing `connectkit` / `TerminalTab` chunk warning remains unchanged.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-portfolio-leaderboard-smoke-20260602-v5` passes.
- Visual inspection passed:
  - `.evolve/arena-portfolio-leaderboard-smoke-20260602-v5/1440x900-leaderboard.png`: full explorer table fits with no horizontal clipping.
  - `.evolve/arena-portfolio-leaderboard-smoke-20260602-v5/1280x800-leaderboard.png`: table remains readable in the tighter desktop viewport.
  - `.evolve/arena-portfolio-leaderboard-smoke-20260602-v5/1440x900-portfolio.png`: portfolio and executions render as aligned ledgers with internal table scroll only.

## 2026-06-02 Agent Explorer Separation Pass

User-reported problem:

- The homepage should not carry the full leaderboard/agent-table job. The app needs a clean separate leaderboard/agent explorer page that can show platform/blueprint volume, fills/hour, latest trades, and a professional Etherscan-style agent table.

Decision:

- Home is the live command glance: platform volume plus latest fills.
- `/leaderboard` is the dedicated Agent Explorer: aggregate strip, volume chart, latest fills ledger, searchable ranked agent table.
- The global sidebar label is `Agents`, while the URL remains `/leaderboard` for route stability.

Screenshot-driven correction:

- First pass placed the latest fills explorer table beside the volume chart. At 1440px it forced horizontal scrolling inside the right rail, which failed the Etherscan-style page goal.
- Final layout stacks full-width rows: volume chart, latest fills table, agents table. This keeps every fill column visible and makes the explorer page read like a real ledger surface rather than a cramped dashboard rail.

Shipped in this slice:

- Removed the homepage `Top agents` mini-table and search so Home no longer duplicates the full explorer workflow.
- Increased the homepage live fill panel from 12 to 18 rows because it now owns the right side by itself.
- Renamed the primary nav entry from `Leaderboard` to `Agents`.
- Reworked `/leaderboard` title and metadata to `Agent Explorer`.
- Added a searchable agent table header on `/leaderboard`.
- Added `LatestAgentTrades` `explorer` mode with a full-width ledger: Time, Agent, Fill, Market, USD, Ref. It intentionally omits the old Mode/Status columns that repeated paper/status concepts.
- Updated the browser smoke fixture expectations to defend the new Home/Explorer split.

Verification:

- `pnpm --dir arena exec vitest run src/routes/__tests__/index.test.tsx src/routes/__tests__/leaderboard.test.tsx src/components/arena/__tests__/LatestAgentTrades.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx --reporter=dot` passes: 4 files, 14 tests.
- `pnpm --dir arena exec vitest run src/routes/__tests__/leaderboard.test.tsx src/components/arena/__tests__/LatestAgentTrades.test.tsx --reporter=dot` passes after the full-width explorer correction: 2 files, 4 tests.
- `pnpm --dir arena test -- --reporter=dot` passes: 67 files, 387 tests.
- `pnpm --dir arena typecheck` passes.
- `pnpm --dir arena build` passes. Existing large-chunk warnings remain unchanged.
- `pnpm --dir arena smoke:agent-workspace -- --fixture --screenshot-dir ../.evolve/arena-agent-explorer-smoke-20260602` passes.
- Visual inspection passed:
  - `.evolve/arena-agent-explorer-smoke-20260602/1440x900-home.png`: Home is now volume + fills, with no ranked-agent duplicate.
  - `.evolve/arena-agent-explorer-smoke-20260602/1440x900-leaderboard.png`: Agent Explorer shows full-width volume, latest fills, and agents ledgers with no horizontal squeeze.
  - `.evolve/arena-agent-explorer-smoke-20260602/1280x800-leaderboard.png`: the explorer remains readable at tighter desktop width.
