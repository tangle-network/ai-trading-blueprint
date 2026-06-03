# AI Trading Arena Sixth-Pass Systematic Audit

Date: 2026-06-03
Base commit: a5c76be
Ops task: #953

## Objective

Re-evaluate every route and visible component against four users:

1. Hyperliquid trader: market, venue, fills, notional, margin, leverage, liquidation, PnL, and execution evidence must be obvious.
2. Crypto wallet user: wallet, chain, signature, transaction, custody, and network state must be explicit.
3. DeFi dapp user: vault, collateral, deposits, withdrawals, service instance, operator, and fail-closed contract state must be honest.
4. AI app user: agent identity, mandate, reasoning, tools, traces, validation, controls, and evidence must be tied to concrete actions.

## Evidence

- Desktop fixture smoke: `.evolve/arena-full-ux-audit-20260603/screens-sixth-pass-desktop/`
- Responsive route capture: `.evolve/arena-full-ux-audit-20260603/screens-sixth-pass-responsive/`
- Create fix captures: `.evolve/arena-full-ux-audit-20260603/screens-sixth-pass-create-fix/`
- Route source: `arena/src/routes`
- Component source: `arena/src/components`
- Focused test: `pnpm --dir arena exec vitest run src/routes/__tests__/create.test.tsx`

## Sixth-Pass Finding

The fifth pass fixed the product thesis and deployment defaults, but responsive screenshots exposed a real mobile Create bug:

- `/create` was using desktop fixed-height rows and hidden overflow on mobile.
- The mandate textarea, compiler, envelope, launch path, and readiness rail were squeezed into nested internal scroll areas.
- This made the first creation workflow feel broken on mobile even though the data and copy were correct.

Fix:

- Mobile and tablet now use natural document flow.
- Fixed-height rows and hidden overflow only apply at desktop breakpoints.
- The default Hyperliquid mandate textarea has enough mobile height to avoid an inner scroll trap.

Verified geometry after fix:

| Viewport | Theme | Main scroll | Textarea | Compiler | Envelope | Submit |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 390x844 | light | 2095 / 788 | 188 | 450 | 444 | 40 |
| 390x844 | dark | 2095 / 788 | 188 | 450 | 444 | 40 |
| 768x900 | light | 1945 / 844 | 168 | 450 | 428 | 40 |
| 768x900 | dark | 1945 / 844 | 168 | 450 | 428 | 40 |

## Route Decisions

| Route | Components and subcomponents | Hyperliquid trader fit | Crypto / DeFi / AI fit | Score | Action |
| --- | --- | --- | --- | ---: | --- |
| `/` | App shell, mobile top bar, sidebar, wallet/chain/theme controls, market pulse, platform volume chart, latest fills, top agents | Strong first scan: ETH-PERP activity, volume, fills, and best agents are visible without marketing fluff | Wallet and chain are visible; AI evidence appears through agent/fill links | 9.0 | Keep |
| `/leaderboard` | Header, filters, leaderboard table, selected agent cockpit, recent fills, workspace links | Good comparison surface for agent volume, fills, strategy, and recent execution | Selected-agent context links into AI trace and portfolio views | 8.9 | Keep |
| `/activity` | Fill tape, selected fill inspector, side/market tokens, USD/price, evidence chips | Correct trading tape: side, market, size, execution, and validation are clear | AI provenance is attached to fills; no wallet action confusion | 8.9 | Keep |
| `/dashboard` | Owner gate, service cards, owned agents, provision banner, secrets modal, operator access state | Correctly scoped to owner/operator work, not public market scan | Separates wallet ownership, secrets, services, and agents | 8.5 | Keep |
| `/create` | Mandate editor, strategy profile chip, strategy compiler, envelope checks, route chips, strategy book, launch path, readiness, CTA | Starts on Hyperliquid perps with leverage, liquidation buffer, replay, and paper start | AI workflow and risk envelope are explicit; mobile now reads cleanly | 9.1 | Fixed |
| `/provision` | Wallet gate, service/runtime facts, stepper, Configure/Deploy/Secrets/Activate, strategy grid, launch summary, guardrails, asset/risk/custom controls | Defaults to Hyperliquid Perps and shows target, collateral, orders, and exits | Wallet, service chain, secrets, quote, and activation are explicit | 9.0 | Keep |
| `/vault/:address` | Address validation, chain warning, vault stats, collateral stats, admin, deposit, withdraw, confirmation, activity | Useful only for vault/account review, not trading performance | Contract state fails closed; DeFi actions and risks are explicit | 8.0 | Keep, needs live vault review |
| `/arena` | Redirect / legacy entry | Prevents duplicate route mental model | No stale shell | 9.0 | Keep |
| `/arena/bot/:id/performance` | Agent shell, status, market header, chart, fills, copilot, risk strip, envelope banner | Strong specific-agent trading view: price, fills, NAV, PnL, margin, leverage, liquidation distance | AI evidence and envelope gating stay adjacent to performance | 9.0 | Keep |
| `/arena/bot/:id/portfolio` | Account header, status chips, equity/cash/notional/uPnL, positions, executions | Clean account/position ledger for the agent | Custody and ledger state are explicit | 8.8 | Keep |
| `/arena/bot/:id/runs` | Run list, status, transcript, reasoning/tool rows, inspector, evidence | Links decisions back to market activity | Core AI traceability surface | 8.6 | Keep |
| `/arena/bot/:id/chat` | Session list, active trace, transcript, reasoning/tool rows, evidence rail, owner sign-in | Useful operator interrogation surface when tied to sessions | AI chat is not generic; it is grounded in run traces | 8.6 | Keep |
| `/arena/bot/:id/operations` | Overview, validation, revisions, controls, envelope, secrets, vault, terminal | Trader can see whether the system is armed, validated, bounded, and recoverable | Best cross-over surface for AI, DeFi, operator, and runtime controls | 8.8 | Keep |

## Component Decisions

| Area | Component | Subcomponents | Decision |
| --- | --- | --- | --- |
| Global shell | `ArenaAppShell` | Desktop rail, collapsed rail, mobile bar, skip link, wallet, chain, theme, tx drawer | Keep. One app frame; no stacked header bars remain in rendered screenshots |
| Public data | `ArenaPageHeader` | Title, live dot, metrics, badges, controls | Keep. Dense terminal header fits trading users |
| Public data | `PlatformVolumeChart` | Range controls, mode controls, area/histogram chart, summary metrics | Keep. Shows arena flow instead of abstract branding |
| Public data | `LatestAgentTrades` | Side pills, market token, USD, price, evidence, selected inspector | Keep. Primary public proof surface |
| Public data | `LeaderboardTable` | Rank, agent, strategy, mode, volume, fills, return, selected state | Keep. Comparison task is clear |
| Create | Mandate editor | Prompt, strategy chip, keyboard submit, status/error refs | Fixed. Mobile no longer clips or nests the first launch task |
| Create | Strategy compiler | Strategy, profile, venue, replay, promotion, workspace | Keep. Correct AI compilation model |
| Create | Envelope | Leverage cap, liquidation buffer, latency check, replay/envelope/venue route chips | Keep. Correct perps risk story |
| Create | Strategy book | DEX, Hyperliquid, prediction, yield, multi-book cards | Keep. Hyperliquid remains default without hiding other strategy classes |
| Provision | `ConfigureStep` | Command, strategy grid, launch summary, guardrails, assets, risk, advanced settings | Keep. Correct product thesis and data scope |
| Provision | Deploy/secrets/activate steps | Quote, service instance, secrets, activation progress | Keep. Honest deployment pipeline |
| Agent shell | `AgentWorkspaceShell` | Identity, avatar, mode, account stats, address actions, section nav, footer facts | Keep. Specific-agent dashboard now feels branded and concrete |
| Performance | `PerformanceTab` / chart | Market header, time controls, candles, volume, NAV, markers, fills, risk strip | Keep. Future data upgrade: liquidation/margin bands if API exposes time series |
| Portfolio | `PortfolioWorkspace` | Account metrics, positions, executions | Keep. Ledger-oriented and readable in both themes |
| Runs | `RunsTab` | Run list, status, transcript, reasoning, tools, inspector | Keep. AI provenance is concrete |
| Chat | `ChatTab` | Sessions, transcript, reasoning/tool rows, evidence, auth | Keep. Chat is trace-grounded |
| Operations | `OperationsWorkspace` | Overview, validation, revisions, controls, envelope, secrets, vault, terminal | Keep. Comprehensive without inventing fake automation state |
| Vault | Vault components | Stats, collateral, admin, deposit, withdraw, confirmation, activity | Keep. Honest DeFi UX, pending real vault transaction capture |

## Remaining Watch Items

1. Performance chart still needs liquidation and margin bands when the operator API exposes time-series risk.
2. Vault cannot score above 8 until reviewed against a real deployed vault address with live wallet writes.
3. Runs and Chat will feel stronger with production history; the fixture has only one trace.
4. Mobile Create is now correct but long. That is acceptable because the page is a comprehensive launch console, not a one-screen marketing form.

## Confidence

- Public arena pages: 9.0 / 10
- Create and Provision: 9.1 / 10 after this pass
- Specific-agent workspace: 8.8 to 9.0 / 10
- Owner dashboard: 8.5 / 10
- Vault: 8.0 / 10 pending live vault transaction verification

Overall sixth-pass confidence before full release verification: 9.0 / 10.
