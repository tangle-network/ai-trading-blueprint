## Test infra
- Runner: Forge (Solidity), cargo test (Rust)
- Forge: 400/400 tests passing across 23 suites
- Rust: 5 modified library crates compile clean on 1.91
- Adversarial harness: `contracts/test/Adversarial.t.sol` (11 tests)
- Real vs mocked: majority real (Anvil, Forge EVM, docker testcontainer); wiremock for HTTP

## Eval infra
- Suite: `.evolve/` populated with harden/pursue/evolve artifacts from prior runs
- Scorecard: `.evolve/scorecard.json` (aggregate 1.0)
- Experiments log: `.evolve/experiments.jsonl` (7 experiments)

## Benchmark infra
- None (flagged for /pursue in prior report)

## Observability
- Logs: `tracing` structured JSON
- No traces/metrics sinks

## Recent changes (post-first-harden)
- Gen 1: returnCollateral operator param, positionsValue decimals, adminUnwind default, SSRF, IDOR
- Gen 2: EIP-712 target+calldataHash binding, lifecycle mutex, off-chain sig verify (regression — see C-2)
- Evolve R3: auth rate limit, validator shared-secret, token revoke, Secret wrapper, CLOB dedup, SSE cap
- Evolve R4: virtual offset 1e6, getBrokenVaults, deadline cap, OWNER_MESSAGES cap, error redaction, test redaction
