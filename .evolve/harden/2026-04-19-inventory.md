# Inventory — Harden Round 3
Date: 2026-04-19

## Test infra
- Runner: Forge (Solidity), cargo test (Rust)
- Location: contracts/test/ (Forge), */tests/ + */src/*.rs #[cfg(test)] (Rust)
- Real-vs-mocked: ~80% real. Mocks only for sandbox/sidecar containers in unit tests.
- Coverage: 428 Forge, 455 Rust lib tests (pre-harden baseline: 413 Forge, 389 Rust)

## Eval infra
- Suite: .evolve/ (harden reports, pursuit tracking, experiments)
- No automated eval scoring

## Benchmark infra
- No CI benchmark regression gate
- Backtest engine has performance assertions (latency bounds not enforced)

## Observability
- Logs: tracing crate → stdout
- No distributed tracing or metrics export

## Mocks-as-coverage
- Real-vs-mocked ratio acceptable (< 30% mock on integration paths)
- Forge tests use real EVM execution
- Rust HTTP API tests use real axum routers with mock state
