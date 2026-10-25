# Trading Blueprint

For system design, read [ARCHITECTURE.md](ARCHITECTURE.md).
For operations, read [runbook.md](docs/runbook.md), [incident-response.md](docs/incident-response.md), and [disaster-recovery.md](docs/disaster-recovery.md) as needed.
For deployment, use [go-live.sh](deploy/go-live.sh) and the selected deployment manifest.
Check actual chain, process, image, and artifact state before production claims; historical notes are not deployment evidence.

## Lifecycle and execution

Cloud blueprints expose provision and deprovision jobs.
Instance and TEE instance routers use service initialization and the operator API for singleton lifecycle instead.
Check the relevant router when changing this boundary.
Production lifecycle uses the Blueprint Manager; do not replace it with a manually launched service instance.

Before manager integration tests, rebuild release binaries affected by the change.
The manager can reuse an existing release binary, including old embedded tools.
For manager failures, trace service discovery, source resolution, binary selection, and inherited configuration.
Order test infrastructure so signing and runtime configuration use the contracts actually deployed for that test.

When a function already holds an authoritative record, return the needed result instead of making callers reload it.
Preserve bot ownership and session authorization across operator-to-sandbox calls.
Read current execution adapters for request, response, and shell contracts; an empty successful command response is not proof of its intended effect.
Keep sidecar credentials in the supported secret path and use authenticated operator APIs for inspection.

## Trading evidence and risk

A chat reply does not prove a scheduled trading tick ran.
Verify decisions, fills, metrics, and strategy artifacts from the actual bot when measuring trading behavior.
Use [evals/src/analysis](evals/src/analysis) for trace analysis and confirm records were parsed before reporting conclusions.
Read selected SDK sources for trace formats and model routing rather than copying API catalogs here.

Preserve server-authoritative drawdown, realistic paper-trading costs, and consistent exit rules between simulation and execution.
Check [TradeValidator.sol](contracts/src/TradeValidator.sol) for signed fields, signer rules, and score enforcement.
It enforces score thresholds; do not treat signatures alone as approval.
Test contract changes against real deployments, including rejection paths.
Distinguish paper fills from executed transactions and healthy no-signal behavior from failures.

## UI ownership and verification

Use dependencies and exports selected by [arena/package.json](arena/package.json) for shared chain, agent-session, and design components.
Keep trading workflows, copy, routes, and bot/vault logic in Arena.
Extract shared behavior only when it has a coherent consumer-independent contract.
Verify affected consumer builds after changing shared APIs.

Configure browser RPC and API endpoints explicitly for remote access.
Test the actual non-loopback browser route when changing development proxies.
Expose asynchronous failures, bind labels to controls, preserve readable theme contrast, and respect reduced-motion preferences.
Destructive controls need confirmation or undo.

## Qualification

Merge `origin/main` before code qualification. Run the commands for the touched surface below through `beelink-gate auto https://github.com/tangle-network/ai-trading-blueprint.git <full-sha> -- bash -lc '<commands>'`, using the existing toolchains and frozen package installs. Workflow and documentation changes use YAML and content checks.

- Rust: `cargo fmt --all -- --check`, then `cargo check -p <affected-crate>`, `cargo clippy -p <affected-crate> -- -D warnings`, and the affected integration tests with `cargo test -p <affected-crate> --test <integration-target>`.
- Arena: `cd arena && pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm test && pnpm smoke:agent-workspace -- --fixture`.
- Evals: `npm ci --prefix evals && npm --prefix evals run typecheck && npm --prefix evals run build`.
- Contracts: `git submodule update --init --recursive && forge soldeer install && forge build && forge test -vvv && forge test --match-path "contracts/test/fuzz/*" -vvv`.

Build affected binaries before integration tests. [Dependency qualification](docs/dependency-policy.md#local-security-qualification) owns the retained static-analysis commands. Generic PR/main-push CI is retired; the existing deployment workflow still calls the full nine-job qualification graph before either target can broadcast. Signing secrets, environment approvals and post-deploy verification remain in that deployment workflow.
[run-devnet.sh](scripts/run-devnet.sh) and the existing integration tests own local prerequisites and startup behavior.
Report skipped infrastructure and substituted providers with the result.
