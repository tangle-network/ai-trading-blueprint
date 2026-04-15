## Test infra
- Runner: Forge (Solidity), cargo test (Rust), vitest (Frontend)
- Solidity: 20 test files + 3 fuzz + 1 integration in `contracts/test/`
- Rust: ~300+ tests across 6 crates
- Frontend: 15 vitest files in `arena/src/`
- Real-vs-mocked ratio: Majority of Solidity uses real EVM, Rust uses mix of Anvil (real) and wiremock (mocked)
- Coverage: Not measured (no coverage report in CI)

## Eval infra
- Suite: None (`.evolve/` created by this harden run)
- No eval harness, no scorecard, no baselines

## Benchmark infra
- Runner: None
- No `.bench` files, no CI benchmark gate
- No regression thresholds

## Observability
- Logs: `tracing` crate, structured (json-compatible)
- Traces: None (no OpenTelemetry/Sentry)
- Metrics: In-memory `MetricsStore` via trading-http-api, no external sink
- Where findings should land: Existing Forge test suite + cargo test suites
