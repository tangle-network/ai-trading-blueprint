# Product UI Pass

Status: implemented locally, browser-smoked, pending full build/release.
Product: AI Trading Arena.
Primary users: trading-agent operators and crypto traders inspecting live/paper execution.
Product brief: `PRODUCT_BRIEF.md`.

## Inventory
- `/arena/bot/:id/runs`: run history sidebar, run summary, transcript replay, structured evidence fallback, decision inspector, resize handles, light/dark empty transcript state.
- `/arena/bot/:id/chat`: session sidebar, empty owner-conversation state, transcript surface, auth command, Runs handoff.
- `/provision`: connected Activate configure step, adapter selector, prediction subtype selector, activation summary rail, resize handle.
- `/activity`: fill explorer, row selection, fill inspector, explicit agent navigation.
- `/`: volume chart, top agent table, fills rail.

## Page Evaluations

### Runs
Purpose: show why an autonomous run traded, skipped, failed, or produced evidence.
Current score: 8.8/10.
Target score: 9/10.
Findings:
- Empty `transcript_available` runs were rendering a dead transcript panel.
- The first fix exposed duplicated decision evidence in the right inspector.
Alternatives:
- Always show transcript when `transcript_available`: 3/10, repeats the bug.
- Convert every run result into fake chat messages: 5/10, blurs Runs and Chat again.
- Show live transcript only when visible messages exist, otherwise show structured evidence: 9/10.
Decision: structured evidence is the fallback source of truth; decision inspector only appears beside renderable transcript replay.
Changes shipped:
- Added renderable transcript-content gate.
- Rebuilt no-transcript fallback as Decision Path, Result/Parsed Output, Evidence Record, Quick Read.
- Added empty transcript fixture coverage to the workspace smoke harness.
Verification:
- `pnpm --dir arena exec vitest run src/components/bot-detail/__tests__/RunsTab.test.tsx src/components/bot-detail/__tests__/ChatTab.test.tsx`
- `pnpm --dir arena typecheck`
- `pnpm --dir arena smoke:agent-workspace -- --fixture --fixture-empty-run-transcript --theme-matrix --screenshot-dir ../.evolve/arena-ui-pass-2026-06-05-activation-v1/screenshots`
- Screenshots inspected: `1440x900-runs-light.png`, `1440x900-runs-dark.png`.
Remaining risk:
- Sparse single-run state leaves empty vertical space. Do not fill with decoration; solve with richer run data or persisted layout options.

### Chat
Purpose: owner-directed conversations with the agent, distinct from autonomous run traces.
Current score: 8.7/10.
Target score: 9/10.
Findings:
- Empty Chat looked like another Runs trace surface.
Alternatives:
- Keep passive empty transcript: 4/10.
- Show recent Runs inside Chat: 3/10, creates the duplication the user called out.
- Show a compact command state with owner sign-in and Runs handoff: 8.7/10.
Decision: Chat empty state names owner conversations and routes autonomous evidence to Runs.
Changes shipped:
- Replaced passive empty state with terminal-styled action panel.
- Hid duplicated footer sign-in row while the empty state is visible.
- Renamed sidebar title from History to Conversations.
Verification:
- Same focused tests and browser smoke as Runs.
- Screenshots inspected: `1440x900-chat-light.png`, `1440x900-chat-dark.png`.
Remaining risk:
- No real owner chat fixture in the smoke matrix yet.

### Activate
Purpose: bind an AgentProfile to wallet-backed runtime/service constraints.
Current score: 8.2/10.
Target score: 9/10.
Findings:
- Prediction-market subtype controls were visible under Hyperliquid activation, reviving the old strategy-pack confusion.
Alternatives:
- Keep all strategy choices visible: 5/10, noisy and misleading.
- Remove prediction subtypes entirely: 6/10, loses useful Polymarket configuration.
- Render prediction subtypes only for prediction-capable adapters: 8.5/10.
Decision: adapter controls are contextual projections; the AgentProfile remains broader than the selected runtime adapter.
Changes shipped:
- Hidden prediction subtype selector unless the selected adapter is prediction-capable.
- Renamed remaining deploy resize affordance to activation language.
Verification:
- `pnpm --dir arena exec vitest run src/components/provision/__tests__/ConfigureStep.test.tsx src/routes/__tests__/create.test.tsx src/routes/__tests__/provision.integration.test.tsx`
- `pnpm --dir arena typecheck`
- Browser smoke above.
- Screenshot inspected: `1440x900-provision-connected-light.png`.
Remaining risk:
- Connected Activate still has heavy wizard chrome. Best next move is a single profile-to-activation review screen once wallet fixture automation is stable.

### Activity
Purpose: inspect recent fills and decide whether to open the source agent.
Current score: 9/10.
Findings:
- Source confirms row click updates fill selection only; explicit Agent link owns navigation.
Decision: no code change in this pass.
Verification:
- Screenshot inspected: `1440x900-activity-light.png`.

### Home
Purpose: first scan of platform flow, latest fill, top agent, and fill tape.
Current score: 8.6/10.
Findings:
- Top agents are visible below the volume chart in the current 1440x900 fixture and Fills has an independent rail.
Decision: no local tweak. A broader persisted Home workspace layout is the correct next change if user-controlled chart/top-agent/fills sizing becomes the priority.
Verification:
- Screenshot inspected: `1440x900-home-light.png`.

## Cross-Cutting Findings
- Navigation: Runs and Chat now have distinct jobs.
- Theme: inspected light/dark for Runs and Chat; Activate connected light inspected.
- Tables/charts: Activity row selection is correct; no table corner regression touched.
- Interactions: Run inspector, activation summary, and fill inspector remain resizable/minimizable where already modeled.
- Data truth: empty transcripts no longer masquerade as readable chat traces.

## Next Pass
- Add a real owner chat fixture to prove Chat with actual conversation data.
- Add wallet-auth screenshot fixture for connected Activate dark mode and later wizard steps.
- Consider a persisted Home layout model if volume/top agents/fills need user-controlled ratios.
