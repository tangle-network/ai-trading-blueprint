# Product Design Audit

Status: implemented locally, verified by tests/build/browser token capture.
Product: AI Trading Arena.
Primary users: traders and operators creating, paper-running, activating, and auditing AI trading agents.
Reference surfaces: `PRODUCT_BRIEF.md`, `/create`, `/provision`, `/dashboard`, app shell nav.
Product brief: `PRODUCT_BRIEF.md`.

## Inventory
- Route/page: `/create`.
- Components: page header, mandate textarea, launch ticket, capability focus toggles, risk checks, route chips, mandate seed rail, execution rail.
- States: default Hyperliquid paper mandate, manual prompt edit, capability toggle, submit, error, activation handoff, collapsed/resized rail.
- Data dependencies: operator API URL/auth, create draft localStorage, protocol capability model.
- Known complaints: Create/Deploy split, strategy-pack concept feels wrong, no multi-capability selection, heavy chrome, unclear paper-first flow.

- Route/page: `/provision`.
- Components: wallet gate, activation header, wizard steps, configure step, runtime modal, deploy/provision step, secrets step.
- States: disconnected wallet gate, draft handoff, connected configure, provision progress, awaiting secrets, active/failed.
- Data dependencies: wallet, Tangle service/blueprint, operator auth, draft protocol intent, strategy config.
- Known complaints: Deploy appears as separate product, single pack collapses agent intent, form is busy, old labels persist.

## Page Evaluations
### New Agent
Purpose: create a real paper agent from a mandate.
Primary user decision: what should this agent pay attention to first, with which risk limits, before it starts paper running?
Current score: 8/10.
Target score: 9/10.
Findings:
- Previous flow treated templates as strategy packs; this implied venue lock-in.
- The right model is broad venue access plus mandate-derived preferred protocols.
- Capability selection must be multi-select and must affect the API payload, not only the UI.
Complaint ledger:
- Fixed: duplicate Create/Deploy primary nav.
- Fixed: strategy pack copy on Create.
- Fixed: no multi-capability selection on paper creation.
- Fixed: draft handoff now carries protocol intent.
Alternatives:
- Keep packs and add multi-select: 4/10, preserves wrong primitive.
- Delete templates entirely and use only text: 6/10, cleaner but slower for first-run users.
- Keep templates as mandate seeds and add capability focus over broad venue access: 9/10, matches backend config and user mental model.
Decision: mandate seeds + capability focus + all wired protocols in create payload.
Changes shipped:
- `/create` renamed to New Agent.
- Added capability toggles: Hyperliquid, DEX Spot, DeFi Yield, Prediction Markets, EVM Perps.
- Create payload includes `available_protocols`, `preferred_protocols`, `protocol_chain_ids`, and `capability_focus`.
- Header/mobile metric compacted to avoid truncation.
Verification:
- `pnpm --dir arena exec vitest run src/routes/__tests__/create.test.tsx`
- `pnpm --dir arena typecheck`
- `pnpm --dir arena build`
- Browser capture: `.evolve/arena-create-activate-audit-20260604/create-after-header/screenshots/{mobile,tablet,desktop}.png`
Remaining risk:
- Connected wallet activation cannot be fully screenshot-verified without a browser wallet fixture.

### Activate
Purpose: bind an agent mandate to wallet-backed runtime/service ownership.
Primary user decision: is this paper mandate ready to become an operator-managed instance?
Current score: 7.5/10.
Target score: 9/10.
Findings:
- Previous route title "Deploy" made this feel like a second creation product.
- Activation still has necessary complexity because service, wallet, vault, validators, and secrets are real constraints.
- The disconnected state is now coherent, but the connected form still deserves a deeper IA pass after wallet fixture automation.
Complaint ledger:
- Fixed: product surface renamed from Deploy to Activate.
- Fixed: nav no longer exposes Create and Deploy as equal primary routes.
- Fixed: ConfigureStep now says Capability Focus, Activation Review, Runtime.
- Fixed: draft protocol intent threads into operator/on-chain/instance strategy config.
Alternatives:
- Redirect `/provision` to `/create`: 3/10, breaks real wallet-backed activation.
- Keep `/provision` as separate Deploy: 4/10, repeats the product split.
- Keep route internally but present it as activation from paper agent: 8/10, preserves contracts while fixing product story.
Decision: `/provision` remains the technical route; visible surface is Activate.
Changes shipped:
- Wallet gate title/copy/path updated.
- App shell and dashboard primary CTAs use New Agent/Activate.
- DeployStep summaries use Focus/Provision Runtime and squared panels.
- Metadata visible label changed from Strategy pack to Capability focus.
Verification:
- `pnpm --dir arena exec vitest run src/components/provision/__tests__/ConfigureStep.test.tsx src/routes/__tests__/provision.integration.test.tsx src/components/layout/__tests__/ConnectWalletPanel.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx`
- `pnpm --dir arena test` (458 passed).
- Browser capture: `.evolve/arena-create-activate-audit-20260604/provision/screenshots/{mobile,tablet,desktop}.png`
Remaining risk:
- Connected `/provision` form still contains underlying single-focus strategy type because live execution targets have real chain/vault constraints.

## Cross-Cutting System Findings
- Navigation: fixed the duplicate Create/Deploy primary-nav model; New Agent is the canonical entry.
- Theme: browser token pass covered current light default; no dark-specific regression observed in source, but dark recapture should be part of the next full-site smoke.
- Tables/charts: not touched in this pass.
- Density: Create is denser and clearer; Activate disconnected state is cleaner.
- Copy/labels: user-facing "strategy pack" removed from changed surfaces; internal types remain where they map to existing code.
- Interactions: capability toggles are stable multi-select; rail resize/collapse preserved.
- Responsiveness: mobile New Agent header no longer truncates the focus metric.
- Data truth: create and activation configs now preserve available/preferred protocol intent.
- Production/deploy: not deployed in this pass.

## Verification
- Commands:
  - `pnpm --dir arena exec vitest run src/routes/__tests__/create.test.tsx src/components/provision/__tests__/ConfigureStep.test.tsx src/components/layout/__tests__/ConnectWalletPanel.test.tsx src/components/layout/__tests__/ArenaAppShell.test.tsx src/routes/__tests__/provision.integration.test.tsx`
  - `pnpm --dir arena test`
  - `pnpm --dir arena typecheck`
  - `pnpm --dir arena build`
  - `git diff --check`
- Browser checks:
  - `bad design-audit --url http://localhost:1337/create --extract-tokens --sink .evolve/arena-create-activate-audit-20260604/create-after-header --headless`
  - `bad design-audit --url http://localhost:1337/provision --extract-tokens --sink .evolve/arena-create-activate-audit-20260604/provision --headless`
- Screenshots:
  - `.evolve/arena-create-activate-audit-20260604/create-after-header/screenshots/desktop.png`
  - `.evolve/arena-create-activate-audit-20260604/create-after-header/screenshots/mobile.png`
  - `.evolve/arena-create-activate-audit-20260604/provision/screenshots/desktop.png`
- Deployment: not run.
- Live proof: not run.

## Next Pass
- Build a wallet-auth browser fixture for connected `/provision` so the live activation form can be screenshot-audited.
- Consider moving "Activate" from a global action into agent workspace context once paper agents have a clear graduate/activate CTA.
- Continue reducing rounded blueprint-ui cards in provision dialogs that are still inherited from shared components.
