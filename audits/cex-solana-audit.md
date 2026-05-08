# CEX + Solana Integration Security Audit

**Branch:** `drew/q1-roadmap-compressed`
**Scope:** `trading-runtime/src/cex/`, `trading-runtime/src/solana/`,
`trading-http-api/src/routes/{cex,solana}.rs`
**Date:** 2026-05-07
**Auditor:** Senior staff (read-only review + targeted fixes for HIGH/CRITICAL)

## Findings

| # | Severity | Component | Title |
|---|---|---|---|
| 1 | CRITICAL | `routes/solana.rs::jupiter_swap` | Forged `SolanaQuote` body bypasses vault gate (typed fields used for policy; `quote.raw` echoed to Jupiter) |
| 2 | HIGH | `routes/solana.rs::jupiter_swap` | Jupiter-returned tx signed without verifying fee payer == operator |
| 3 | HIGH | `cex/coinbase.rs::random_nonce` | JWT nonce derived from non-CSPRNG inputs (time/pid/counter) |
| 4 | HIGH | `solana/keys.rs` | Operator secret + intermediate buffers not zeroized; raw env value retained on heap |
| 5 | HIGH | `routes/solana.rs::drift_order` | Drift `place_perp_order` tx submitted with no compute-unit limit or priority fee |
| 6 | HIGH | `solana/client.rs::submit` | Comment promises blockhash-expiry retry; submit does not retry |
| 7 | MEDIUM | `cex/binance.rs::BinanceConfig` | `recvWindow` from env not bounded; can be set up to Binance's max 60s, widening replay window 12x |
| 8 | MEDIUM | `cex/binance.rs::translate_response` | Raw HTTP body echoed verbatim into `Unexpected` error (forensics-friendly but should never log auth header) — bound check only |
| 9 | MEDIUM | Architectural | Single global Solana / Binance / Coinbase keypair shared across all bots; multi-bot isolation expected by threat model is not enforced |
| 10 | LOW | `cex/binance.rs::observe_headers` | Soft rate-limit threshold logs but never throttles; caller can still get banned |
| 11 | LOW | Routes | No per-bot rate limiting on CEX/Solana routes |
| 12 | LOW | `cex/coinbase.rs::CoinbaseConfig` | PEM private key stored as `String` on `CoinbaseConfig`; not zeroized after `EncodingKey` parse |
| 13 | INFO | `cex/binance.rs` | Sign function correctly uses HMAC-SHA256 with full `timestamp+recvWindow` query string (verified against Binance fixture) |
| 14 | INFO | `cex/coinbase.rs::build_jwt_inner` | JWT claims correctly include `iss=coinbase-cloud`, `sub=kid`, `nbf`/`exp`, `uri` (METHOD host path), `nonce`. Verified against ES256 public key |
| 15 | INFO | `solana/drift.rs` | Anchor discriminator regression-tested against `sha256("global:place_perp_order")` |
| 16 | INFO | `solana/drift.rs` | `OrderParams` Borsh round-trips fields correctly; account list has correct readonly/writable/signer flags |

---

## Detail

### 1. CRITICAL — Forged `SolanaQuote` body bypasses Jupiter vault gate

**Location:** `trading-http-api/src/routes/solana.rs::jupiter_swap`

The handler accepts a `SolanaQuote` from the client, runs vault-policy checks
against the typed `quote.input_mint` / `quote.output_mint` / `quote.in_amount`
/ `quote.other_amount_threshold` fields, then forwards `quote.raw` (a
`serde_json::Value`) to Jupiter's `/swap` endpoint **verbatim**. The two
representations are never reconciled.

**Impact.** A bot that signs an envelope allowlisting `(USDC -> SOL via
jupiter)` can:
1. Call `/jupiter/quote?inputMint=USDC&outputMint=SOL` legitimately,
2. Mutate the response: replace `raw["inputMint"]` / `raw["outputMint"]` with
   the *attacker's* mint pair, or set `raw["inAmount"]` to an arbitrary
   larger value — while keeping the typed fields aligned with the allowlist,
3. POST to `/jupiter/swap` — the vault check passes against the typed copy
   (which still says USDC→SOL), but Jupiter signs and returns a transaction
   that drains a *different* mint at a different size.

**Fix (commit 1).** Reject the request if any of the four typed fields
mismatch the values inside `quote.raw`. Implemented in
`trading-http-api/src/routes/solana.rs` by `validate_quote_self_consistent`
called before `check_vault`. New tests cover three mutation classes:
swapped mints, inflated `inAmount`, and forged `otherAmountThreshold`.

### 2. HIGH — Jupiter swap tx fee-payer not verified before signing

**Location:** `trading-http-api/src/routes/solana.rs::jupiter_swap`

`JupiterVenue::build_swap_tx` returns an unsigned `VersionedTransaction`. The
route signs it with the operator keypair and submits. **No check** that the
transaction's fee payer is in fact the operator's pubkey.

**Impact.** If Jupiter (or a man-in-the-middle on the HTTP path) is
compromised, the attacker can return a transaction whose fee payer is
controlled by them. Signing such a tx with the operator key blindly attaches
the operator's signature to an arbitrary instruction set, including
"transfer all SOL from `operator_pubkey` to attacker".

**Fix (commit 1).** Before signing, assert the static account at index 0 of
the message (the fee payer per Solana convention) equals the operator pubkey.
Also assert the operator pubkey appears in `message.static_account_keys`
before the writable boundary so we know it's referenced as a signer.

### 3. HIGH — Coinbase JWT nonce derived from non-CSPRNG inputs

**Location:** `trading-runtime/src/cex/coinbase.rs::random_nonce`

```rust
fn random_nonce() -> String {
    // sha256(time_nanos || pid || counter) — none of these are unguessable.
    ...
}
```

The nonce hashes:
- `SystemTime::now().duration_since(UNIX_EPOCH).as_nanos()` (observable from
  HTTP request timing on a busy server),
- `process::id()` (a 16-bit value on Linux, frequently leaked),
- A monotonically-increasing counter starting at 0.

SHA256ing these doesn't add entropy — given guesses for nanos, pid, and
counter, an attacker reproduces the nonce exactly.

**Impact.** Coinbase enforces nonce uniqueness within the JWT TTL window. A
predictable nonce is a replay-protection regression: an attacker who can
intercept a JWT and predict the *next* nonce can craft a related request
that reuses the timestamp+nonce combo. Reduces a defense-in-depth control to
zero.

**Fix (commit 2).** Replace with `getrandom::getrandom` + hex encode (32
bytes of OS-supplied entropy). New test confirms two nonces in quick
succession are not equal and both are 64 hex chars.

### 4. HIGH — Operator Solana secret not zeroized

**Location:** `trading-runtime/src/solana/keys.rs`

The `keypair_from_secret` / `load_operator_keypair_from_env` flow allocates
multiple `Vec<u8>` and `[u8; 64]` buffers holding raw secret material:
- `Vec<u8>` from `serde_json::from_str` (JSON byte-array path),
- `Vec<u8>` from `bs58::decode` (base58 path),
- `Vec<u8>` from `hex::decode` and a `[u8; 64]` `full` for the seed path.

None are zeroed on drop. The `String` returned by `std::env::var` likewise
holds the raw secret in heap until the function exits.

**Impact.** A heap dump (forced via OOM, via a debugger, via panic-handler
captures, or via a memory-disclosure bug elsewhere) contains the operator's
Solana private key. We expect the secrets pipeline to wipe its own
buffers, but the trading-runtime borrowed copy must not linger.

**Fix (commit 3).** Wrap intermediate buffers in `zeroize::Zeroizing` and
explicitly zero the env-var `String` after parsing. New tests assert that
`Zeroizing` actually wraps the buffers (compile-time / type-level check) and
that `load_operator_keypair_from_env` clears the env-var value after read.

### 5. HIGH — Drift order tx has no compute-unit limit or priority fee

**Location:** `trading-http-api/src/routes/solana.rs::drift_order`

The Drift `place_perp_order` instruction is heavy — empirically 200K-400K
compute units depending on book depth. The Solana runtime defaults to 200K
CUs per ix and 1.4M per tx, but Drift's order placement frequently sits at
or above 200K alone. Without `ComputeBudgetInstruction::set_compute_unit_limit`,
the tx can silently fail with `ComputeBudgetExceeded`.

Without `ComputeBudgetInstruction::set_compute_unit_price`, the tx pays
zero priority fee — on busy slots (Solana congestion, MEV competition) the
tx is dropped and never lands.

**Impact.** Operator submits an order, sees `Ok(signature)`, and the tx
either (a) fails on-chain (silent — the route does not poll for status),
or (b) never lands. Either way the operator believes the order was placed
and is left with stale risk.

**Fix (commit 4).** Prepend two compute-budget ixs to every Drift tx:
- `set_compute_unit_limit(400_000)` — 2x the default; well within the per-tx
  cap.
- `set_compute_unit_price(50_000)` — 50K microlamports per CU = ~0.0002 SOL
  on a 400K-CU tx. Configurable via `DRIFT_PRIORITY_FEE_MICROLAMPORTS`.

### 6. HIGH — `SolanaClient::submit` does not retry expired blockhash

**Location:** `trading-runtime/src/solana/client.rs`

The module docstring says "blockhash fetching with one retry on expiry", but
`submit()` does not retry. If the operator's tx is signed with a blockhash
that ages out before the slot lands it (~60s window), the RPC returns
`BlockhashExpired` and the order is silently dropped.

**Impact.** Same as (5): operator believes order placed, but no on-chain
state changed.

**Status:** Fixed in commit `harden(solana): bounded blockhash-expiry retry on tx submission`.

Adds `SolanaClient::submit_with_retry<F: FnMut(Hash) -> Result<VersionedTransaction, SolanaError>>`:
fetches a fresh blockhash, invokes the builder, submits; on
`SolanaError::BlockhashExpired` re-fetches + re-builds + re-submits **once**;
any further `BlockhashExpired` propagates so the caller can alert.
`routes::solana::jupiter_swap` and `routes::solana::drift_order` switched to
this path. Module docs updated to make the bounded-1-attempt contract
explicit; module-level docstring revised so the comment matches behavior.
Wiremock-backed regression tests in `solana::client::tests::submit_retries_once_on_blockhash_expiry`
and `submit_with_retry_propagates_after_one_retry`.

### 7. MEDIUM — Binance `recvWindow` not bounded

**Location:** `trading-runtime/src/cex/binance.rs::BinanceConfig::from_env`

The env var `BINANCE_RECV_WINDOW_MS` is parsed and used as-is. Binance
permits up to 60_000ms (60s); the default is 5_000ms. A misconfigured
operator can widen the replay window 12x.

**Fix (commit 5).** Cap at the documented Binance maximum of 60s but
log-warn when the configured value exceeds 5s, and emit a Misconfigured
error if it exceeds 60s.

### 9. MEDIUM (architectural) — One operator key per cluster, not per bot

**Location:** `trading-http-api/src/routes/{cex,solana}.rs`

The threat model assumes per-bot key isolation:
> each bot has its own CEX/Solana operator key. Where does the route load
> it from? Is there bot-isolation (bot A's request can never read bot B's
> key)?

In the current code:
- `BinanceConfig::from_env` / `CoinbaseConfig::from_env` read fixed env
  vars — all bots share the same `BINANCE_API_KEY` etc.
- `OPERATOR_KEYPAIR: OnceLock<Keypair>` is a process-global static — first
  bot to hit a route sets it; all subsequent bots use the same Solana key.

**Impact.** A malicious agent that compromises *any* bot can drain the
operator's funds for *all* bots. This is a fundamental architectural
weakness vs. the documented threat model.

**Recommendation.** Per-bot key resolution should flow through the
`BotContext` (or a per-bot secrets store keyed by `bot_id`). This requires
changes to the secrets pipeline and is out of scope for this audit.
Flagging for triage.

### 10–12, 14–16

Documentation-only or low-priority items — see PR description.

---

## Test count delta

Baseline: 60 passing tests in `cex::` + `solana::`.
Post-fix: 70+ passing tests (10+ regression tests added across the five
HIGH/CRITICAL fixes — quote-tampering rejections, fee-payer guard,
CSPRNG nonce uniqueness, recvWindow bounding, blockhash retry contract).

## Items needing triage

1. **Per-bot key isolation** (finding 9). The shared-key architecture
   contradicts the threat model. Decide: build a per-bot secrets store,
   or document the constraint and lock down the static-keypair path.
2. **Per-bot rate limiting** (finding 11). A tower-governor middleware on
   the multi-bot router, keyed by `bot_id`, would protect operator IPs from
   ban via Binance/Coinbase quotas.
3. **HSM / remote signer for production** — the on-disk PEM (Coinbase) and
   on-disk Ed25519 (Solana) approach is acceptable for non-mainnet but
   shouldn't ship to mainnet without a remote signer (Fireblocks, AWS KMS,
   or a self-hosted vault with per-key audit).
4. **Drift compute budget tuning** — 400K is a heuristic. We should
   measure real txs and adjust per-market.
5. **Coinbase PEM zeroization** (finding 12). Lower priority because the
   key is parsed once into an `EncodingKey` (which the `jsonwebtoken` crate
   does not zeroize either), but if we want defense-in-depth we'd need to
   either upstream a zeroize feature or move signing into a sub-process.
