# trading-http-api — concurrency / input-validation audit

Audit scope, threat model, and methodology are owned by the request brief.
This document captures the findings discovered during the read-through of
`trading-http-api/src/{routes,lib.rs,alerts.rs,envelope_renewal.rs,envelope_watcher.rs,learning_store.rs}`
on branch `drew/q1-roadmap-compressed`.

Conventions:

- Severity follows OWASP-ish risk (impact × exploitability).
- "Fix landed" rows reference the commits in this branch.
- "Triage" rows are flagged for the team to schedule; not fixed in-band because
  they require either product decisions or larger refactors than this audit
  ought to take on.

## Findings table

| # | Severity | Location | Title | Fix |
|---|----------|----------|-------|-----|
| 1 | **HIGH** | `envelope_renewal.rs::handle_single_sig` ↔ `routes/envelope.rs::put_envelope_handler` | Cron rotation can clobber a higher-nonce PUT that lands mid-tick | Landed: `set_signed_envelope` is now monotonic by default; cron and PUT both go through it |
| 2 | **HIGH** | `routes/envelope.rs::set_signed_envelope`, `learning_store.rs::save` | Non-atomic file write — crash mid-write leaves truncated JSON on disk that subsequent reads silently treat as "no envelope" / "empty learning state" | Landed: tmp-write + rename (`atomic_write_json`) |
| 3 | **HIGH** | `lib.rs::build_multi_bot_router` | No explicit request-body limit on the multi-bot router. Axum's 2MB default applies but is implicit and per-extractor | Landed: `DefaultBodyLimit::max(MAX_BODY_BYTES)` on the multi-bot router, 256 KiB |
| 4 | **HIGH** | `routes/learning.rs::post_strategy_outcome` | `reward` is bounded only by `is_finite()`. A malicious agent can submit `reward=1e308` to poison the bandit's running mean (`mean_reward * pulls + reward / (pulls + 1)`). `is_finite()` allows arbitrarily large finite values | Landed: clamp absolute value to `MAX_BANDIT_REWARD` (1e6) and reject NaN/inf with 400 |
| 5 | **MEDIUM** | `alerts.rs::build_slack_payload` | `bot_id` is wrapped in backticks but never escaped. An attacker-controlled `bot_id` containing a backtick or `*` breaks out of the code-span and injects mrkdwn that ops staff might mis-read in Slack (e.g. `bot_id="x*evil*"`) | Landed: escape backticks + ZWSP between sensitive chars before Slack interpolation |
| 6 | **MEDIUM** | `routes/envelope.rs::envelope_consumed_amount` | RPC URL is reflected in the user-facing error string `format!("invalid bot rpc_url '{}': {e}", bot.rpc_url)` — operator RPC endpoints often embed an API key in the path or query | Landed: scrub rpc_url; log the failure on the server side, return a generic "RPC unavailable" |
| 7 | **MEDIUM** | `envelope_renewal.rs::spawn_renewal_cron`, `envelope_watcher.rs::spawn_envelope_watcher` | `tokio::time::interval` defaults to `MissedTickBehavior::Burst`. If a single tick stalls (slow RPC, many bots) the runtime will queue missed ticks and fire them back-to-back when the slow tick finishes — alert storm + duplicated rotation work | Landed: explicit `MissedTickBehavior::Delay` |
| 8 | **MEDIUM** | `routes/learning.rs::post_strategy_outcome` | No replay protection — the same `(variant_id, reward)` pair can be POSTed N times, double-counting an arm pull | Documented in code; PR-grade fix is a request idempotency-key. Triage |
| 9 | **LOW** | `routes/envelope.rs::envelope_status_handler` | `consumed.to_string().parse::<f64>()` is silently lossy for U256 > 2^53. The `consumed_pct` field is human-facing only, so the imprecision is acceptable, but undocumented | Landed: doc-comment names the precision floor and suggests bigdecimal at the call site |
| 10 | **LOW** | `routes/prometheus.rs` | `bot_id` and `protocol` are unbounded labels — adversarial values create high-cardinality Prometheus series. Mitigated by `bot_id` provenance (operator-controlled) but worth a guardrail | Documented in code. Triage |
| 11 | **INFO** | `routes/envelope_quote.rs::quote_*` | The protocol name lives in the URL path; each handler is registered for a specific allowlisted protocol so there is no path-injection surface | No-op |
| 12 | **INFO** | `lib.rs::build_multi_bot_router` (Prometheus mount) | Prometheus is intentionally outside the auth layer (verified). Standard and documented | No-op |
| 13 | **INFO** | `routes/envelope.rs::envelope_path` ↔ `learning_store.rs::sanitize_bot_id` | Bot id sanitization is consistent across both persistence callers | No-op |
| 14 | **INFO** | `alerts.rs::AlertSink::fire` | Always async; no `Handle::try_current().spawn`-from-sync surface in tree | No-op |

## Pre-existing breakage outside this audit's scope

A parallel agent landed Solana-key handling changes in
`trading-runtime/src/solana/keys.rs` (memory-zeroization hardening) on this
branch concurrently with this audit. That commit introduced a lint
(`clippy::explicit_auto_deref` at line 79: `&*seed_arr` → `&seed_arr`).

Because the audit brief forbids editing CEX/Solana auth+key code in this
audit, the lint is left in place. It causes
`cargo clippy -p trading-http-api -- -D warnings` to fail at the dep-graph
level even though `cargo clippy -p trading-http-api --no-deps` is clean.
Surfaced for the Solana-key audit owner to fix.

## Items for team triage

- **Per-bot rate limiting** for `/learning/*` and the envelope routes. With
  thousands of bots and an open file-descriptor budget, an agent that spams
  `POST /learning/strategy-outcome` will hammer the file-system and the
  read-modify-write cycle. Recommend a simple `governor`-style middleware
  keyed on `BotContext.bot_id`.
- **Strategy-outcome idempotency**: today the agent can replay an outcome
  to double-count an arm pull. A `request_id` field on `StrategyOutcomeRequest`
  + last-seen ID per bot solves it cheaply. Out of scope for this audit.
- **Learning store concurrency at scale**: a single global `WRITE_LOCK`
  serializes all bot writes. Per-bot `dashmap<bot_id, Mutex<()>>` would
  parallelize without changing the on-disk layout. Land before $$10^4$$ bots.
- **Tokio task leak from alerts**: `AlertSink::fire` is itself an `async fn`,
  no unbounded spawn — but the renewal cron / watcher both `await` the fire
  inside their loop. If Slack/PagerDuty stalls past the 5s client timeout the
  cron tick blocks. Confirmed acceptable today; revisit if alerts go bursty.
- **Unbounded Prometheus label cardinality**: `bot_id` and `protocol` labels
  on the envelope and learning gauges. Operator-controlled today; revisit
  when self-serve onboarding lands.

## Architectural concerns

- The on-disk envelope/learning layout is reasonable for the current scale
  (a few hundred bots) but brittle. Two structural improvements would pay
  back when fleet size grows:
  1. **Sled or SQLite** for envelope and learning stores. Atomic writes
     come for free and per-bot locking falls out of the storage layer.
  2. **Per-bot in-memory cache** for the envelope, with file as the
     persistence backstop. The cron and watcher both re-read from disk on
     every tick, which keeps file descriptors hot for every bot every
     minute.
- The renewal cron and envelope watcher are independent loops that read the
  same on-disk envelope and call the same RPC. With 10k bots and a 60s
  watcher tick, the watcher alone issues 10k `eth_call`s/min just for
  consumption. Consider batching by chain (one provider per chain, multicall
  the consumed amounts) before scaling out further.
