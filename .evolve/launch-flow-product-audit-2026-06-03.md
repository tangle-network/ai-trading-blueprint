# Product Design Audit

Status: implemented and locally verified
Product: AI Trading Arena
Primary users: crypto traders, DeFi users, agent operators, protocol reviewers
Reference surfaces: `PRODUCT_BRIEF.md`, `/create`, `/provision`, `ConfigureStep`
Product brief: `PRODUCT_BRIEF.md`

## Inventory
- Route/page: `/create`
- Components: page header, mandate textarea, compiled brief, risk envelope, strategy presets, launch path, execution status, create CTA, resizable strategy rail
- States: default Hyperliquid prompt, strategy preset selected, prompt edited, creating, create failed, rail collapsed/resized, light/dark theme
- Data dependencies: operator API URL/auth token, inferred strategy type, static strategy hints/profiles
- Known complaints: strategy compiler unclear, duplicates Deploy mentally, too many labels, light theme broken by dark hard-coded colors

- Route/page: `/provision`
- Components: wallet gate, deploy header, step nav, wrong-network banner, blueprint/configure/deploy/secrets steps
- States: disconnected, connected, wrong network, ambiguous instance route, step current/done/locked, light/dark theme
- Data dependencies: wallet/network, blueprint registry, service/operator status, selected strategy pack
- Known complaints: Deploy flow busy, form layout unclear, strategy/prediction market controls shake, old dark UI remains in customization/modal-adjacent areas

- Component: `ConfigureStep`
- Components: header state cells, agent identity, strategy pack grid, prediction packs, provision review rail, guardrails, assets, operator route, collateral
- States: DEX, Hyperliquid, Polymarket/CLOB, service loading/error/mismatch, instance operator selected, advanced dialog entry, rail collapsed/resized
- Data dependencies: strategy packs, selected assets, service info, operator selections, collateral cap
- Known complaints: strategy/prediction flow unclear, right rail generic, light theme missing, labels not purposeful

## Page Evaluations
### Create
Purpose: turn a natural-language mandate into a paper-agent create request and open the resulting workspace.
Primary user decision: "Is this mandate parsed into the intended strategy, venue, risk, and paper route?"
Current score before: 6.5/10
Target score: 8.5/10
Findings: the CTA said "Deploy Agent" even though the route only creates a bot through the operator API; "Strategy Compiler" sounded like a separate system but showed a static inferred brief; hard-coded dark colors made light theme non-production.
Complaint ledger: Create/deploy duplication fixed; compiler purpose clarified; light theme tokenization fixed for this route; deeper compiler data contract still unresolved.
Alternatives:
- Keep Create as a deploy shortcut: 4/10. Fast, but product-confusing and undermines wallet-backed Deploy.
- Remove Create and force all users through Deploy: 5/10. Clean IA, but loses fast NL mandate workflow.
- Define Create as paper-agent draft/create and Deploy as wallet-backed provision: 9/10. Best fit with product brief and current API contract.
Decision: Create is now "Create Paper Agent"; compiler is "Compiled Brief"; right rail is presets/path/execution rather than deploy readiness.
Changes shipped: UI copy, status copy, test expectations, theme tokens.
Verification: `pnpm --dir arena test -- src/routes/__tests__/create.test.tsx src/components/provision/__tests__/ConfigureStep.test.tsx`; `pnpm --dir arena build`; screenshots `/tmp/arena-create-light.png`, `/tmp/arena-create-dark.png`, `/tmp/arena-create-light-mobile.png`.
Remaining risk: compiled brief is still heuristic inference from text, not a real compiler artifact from the operator.

### Deploy / Configure
Purpose: explicit wallet-backed provisioning workflow with hard requirements before launch.
Primary user decision: "Are identity, strategy pack, infrastructure, risk/collateral, and review ready to provision?"
Current score before: 6.5/10
Target score: 8/10
Findings: top cells said Strategy/Route/Risk but the page job is provisioning readiness; panels said Command/Strategy/Launch Summary, which is generic and hides hard requirements.
Complaint ledger: Deploy vs Create boundary fixed; configure labels clarified; light theme tokenization fixed for configure shell and main controls; old advanced modal remains a separate pass.
Alternatives:
- Wizard-first form with one page per decision: 6/10. Clear but slow and increases navigation friction.
- Single dense configure workspace with a review rail: 8.5/10. Fits trading/ops users and existing resizable layout.
- Conversational strategy compiler inside Deploy: 5/10. Tempting, but would duplicate Create and blur provisioning requirements.
Decision: keep dense workspace; rename panels to Agent Identity, Strategy Pack, Infrastructure, Readiness, Provision Review.
Changes shipped: top cell labels, panel titles, tokenized active/hover/warning states.
Verification: `pnpm --dir arena test -- src/routes/__tests__/create.test.tsx src/components/provision/__tests__/ConfigureStep.test.tsx`; `pnpm --dir arena build`; disconnected Deploy screenshot `/tmp/arena-provision-light.png`; connected Configure covered by component tests.
Remaining risk: prediction pack strategy grouping still needs a deeper interaction pass; connected Provision screenshots require wallet fixture support.

## Cross-Cutting System Findings
- Navigation: Create and Deploy now have distinct jobs; remaining metadata "Deploy Agent" applies to the wallet gate and document title.
- Theme: launch surfaces now use `--arena-terminal-*` variables for foreground/background/borders/hover/active states.
- Tables/charts: not touched in this pass.
- Density: no new explanatory panels were added; labels were renamed instead of expanded.
- Copy/labels: removed the worst duplicate deploy language from Create.
- Interactions: existing resizable rails preserved; no new draggable behavior bolted on.
- Responsiveness: desktop and 390px Create screenshots inspected; mobile header metrics still truncate but no overlap or unreadable text.
- Data truth: Create still uses heuristic inference; recorded as product risk.
- Production/deploy: pending verification and ship.

## Verification
- Commands: `pnpm --dir arena test -- src/routes/__tests__/create.test.tsx src/components/provision/__tests__/ConfigureStep.test.tsx`; `pnpm --dir arena build`
- Browser checks: local Vite preview at `http://127.0.0.1:4173`; waited for route text before capture
- Screenshots: `/tmp/arena-create-light.png`, `/tmp/arena-create-dark.png`, `/tmp/arena-create-light-mobile.png`, `/tmp/arena-provision-light.png`
- Deployment: pending
- Live proof: pending

## Next Pass
- Build a real compiler artifact contract if the operator can return parsed strategy, venue, constraints, missing fields, and confidence.
- Add connected Provision screenshot fixture or story route so CI can visually verify ConfigureStep light/dark states.
- Rework prediction/CLOB strategy selection after observing real user choice paths; do not add chat duplication inside Deploy.
