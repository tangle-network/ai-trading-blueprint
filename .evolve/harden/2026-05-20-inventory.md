# Harden Inventory - Hyperliquid Safety + Autonomy

## Test Infra
- Foundry contract tests under `contracts/test`, including fork tests under `contracts/test/fork`.
- Rust HTTP/API integration tests under `trading-http-api/tests`.
- Runtime/backtest tests under `trading-runtime/tests`.
- Operator and blueprint e2e tests under `trading-blueprint-lib/tests` and `trading-blueprint-bin/tests`.

## Real Vs Mocked
- Hyperliquid unit tests still use `vm.mockCall` for deterministic precompile accounting branches.
- Added a real HyperEVM testnet fork smoke path for deployment plus CoreWriter calldata assumptions.
- HTTP live execution tests still mock external RPC/Hyperliquid boundaries where CI cannot safely submit venue orders.

## Eval / Evolution
- Existing candle store, backtest engine, walk-forward comparison, `/evolution/run`, and learning bandit routes.
- No previous mandatory promotion gate tying walk-forward results to paper-trading evidence.

## Benchmark Infra
- No benchmark regression harness found.

## Observability
- Existing HTTP responses and workflow run history; no dedicated promotion audit log yet.
