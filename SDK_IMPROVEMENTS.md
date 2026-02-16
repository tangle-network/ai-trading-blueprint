# Blueprint SDK Improvement Proposals

Gaps discovered while building end-to-end tests for the AI trading + validator multi-blueprint system.

## 1. State directory isolation

**Problem:** `PersistentStore` reads `BLUEPRINT_STATE_DIR` at first access via `OnceCell`, but `BlueprintHarness` doesn't set it. Parallel test processes that share the same default path race on the JSON files.

**Proposal:** `BlueprintHarnessBuilder::with_state_dir(path)` — sets `BLUEPRINT_STATE_DIR` to a harness-managed temp directory before spawning. Resets on `shutdown()`.

## 2. Environment variable management

**Problem:** Tests scatter `unsafe { std::env::set_var(...) }` calls everywhere. Env vars are process-global so parallel tests can interfere.

**Proposal:** `BlueprintHarnessBuilder::with_env_vars(HashMap<String, String>)` — sets env vars atomically on spawn, restores originals on shutdown. This also documents which env vars a blueprint depends on.

## 3. Pre-spawn hook

**Problem:** Integration tests need to pre-seed `PersistentStore` entries (bot records, workflows) before the blueprint runner starts processing jobs. Currently there's no hook point.

**Proposal:** `BlueprintHarnessBuilder::with_pre_spawn_hook(async fn(&BlueprintEnvironment))` — called after Anvil is up but before the router starts consuming jobs.

## 4. Cron job triggering

**Problem:** `CronJob` / `workflow_tick` fires on real wall-clock time. Tests can't force-fire a cron workflow iteration without waiting for the next cron tick.

**Proposal:** `harness.trigger_cron_job(job_id)` — directly invokes the cron handler, bypassing the schedule. Also useful for debugging.

## 5. Multi-blueprint harness

**Problem:** Testing interactions between two blueprints (e.g. trading + validator) requires manually starting HTTP servers alongside the harness. There's no first-class way to co-deploy multiple blueprints on the same Anvil instance.

**Proposal:** `MultiHarness::builder().add_blueprint("trading", trading_router()).add_blueprint("validator", validator_router()).spawn()` — deploys multiple blueprints sharing one Anvil node, with separate service IDs.

## 6. TNT artifact error messages

**Problem:** When TNT core artifacts are missing, the error message is opaque. Developers don't know which `forge script` command to run or where the artifacts should be.

**Proposal:** Include the exact `forge script` command and expected artifact path in the error message. For example: `TNT core artifacts not found at ~/.tnt/core/. Run: forge script script/Deploy.s.sol --rpc-url ...`

## 7. Background service lifecycle

**Problem:** The trading blueprint binary spawns background services (HTTP API, resource reaper, GC) alongside the Tangle job consumer. The harness doesn't know about these services, so they can't be cleanly started/stopped in tests.

**Proposal:** `BlueprintHarnessBuilder::with_background_service(name, async fn(CancellationToken))` — spawns the service alongside the runner, cancels it on shutdown. Logs are captured per-service.
