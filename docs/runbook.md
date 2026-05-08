# Trading Blueprint Operator Runbook

Daily-ops handbook for operators running the trading blueprint fleet. Pairs
with `docs/disaster-recovery.md` (for state-loss / key-loss scenarios) and
`docs/incident-response.md` (for severity-driven response).

This runbook assumes the operator is responsible for:

- One or more `trading-blueprint` operator nodes (running the operator API on
  port `9200`).
- The per-bot trading HTTP API (`trading-http-api`) that ships in-process,
  exposed via the auth-gated bearer-token surface.
- Envelopes signed by the operator key (single-sig path) or by external
  signers (multi-sig path) that are persisted in
  `<state_dir>/trading-envelopes/<bot_id>.json`.
- Per-bot learning state in `<state_dir>/learning/<bot_id>.json`.

`<state_dir>` is the directory pointed at by `BLUEPRINT_STATE_DIR` (or the
default `sandbox_runtime::store::state_dir()` location, typically
`/var/lib/trading-blueprint/state` on production hosts).

> **Conventions.** All `curl` examples use `$OPERATOR_API` for the operator
> control surface (default `http://127.0.0.1:9200`) and `$TRADING_API` for the
> per-bot trading API (default `http://127.0.0.1:9100`). `$BOT_TOKEN` is the
> per-bot bearer token issued at create time and stored in the bot record.

---

## 1. Provisioning a new bot

### 1.1 Required environment

The operator process must be started with at least:

```bash
# Identity / chain
SERVICE_ID=42
BLUEPRINT_ID=7
CHAIN_ID=8453                        # 1=mainnet, 8453=base, 84532=base-sepolia
HTTP_RPC_URL=https://...             # operator-funded RPC
WS_RPC_URL=wss://...
BLUEPRINT_STATE_DIR=/var/lib/trading-blueprint/state

# Operator signer (single-sig envelope path)
OPERATOR_PRIVATE_KEY=0x...           # 32-byte hex, NO 0x is also accepted

# Vault factory + on-chain addresses (from deployments/{chainId}/v3.json)
VAULT_FACTORY=0x...
TRADE_VALIDATOR=0x...
POLICY_ENGINE=0x...
FEE_DISTRIBUTOR=0x...
ASSET_TOKEN_ADDRESS=0x...            # canonical USDC unless asset is overridden

# Alerting (production)
TRADING_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TRADING_PAGERDUTY_ROUTING_KEY=...

# Optional but recommended for envelope-mode fleets
TRADING_ENVELOPE_TRUSTED_SIGNERS=0xSigner1,0xSigner2
```

The full env contract lives in `settings.env.example` — copy that to
`settings.env` and fill in real values.

### 1.2 Create the bot

The operator API exposes `POST /api/bots`. Bot creation is a *bot-spec
intake* call — provisioning (vault deploy, secrets bootstrap, sidecar
warm-up) is async and tracked under `/api/provisions/{call_id}`.

```bash
curl -sS -X POST "$OPERATOR_API/api/bots" \
  -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Trade BTC/USDC on Base. Hold positions 1-7 days. Max 25% drawdown.",
    "strategy_type": "swing",
    "name": "btc-swing-v1"
  }'
```

The response includes:

- `bot_id` — used for all subsequent per-bot calls.
- `trading_api_token` — the `$BOT_TOKEN` you store in your secrets manager.
- `provision.call_id` — poll `/api/provisions/{call_id}` until status is
  `succeeded`.

### 1.3 Set `validation_trust = Envelope`

By default a freshly provisioned bot lands in `validation_trust=PerTrade`
(every trade requires a fresh validator-quorum signature). For the envelope
flow:

1. After provision succeeds, mark the bot as envelope-trust:

   ```bash
   curl -sS -X PATCH "$OPERATOR_API/api/bots/$BOT_ID/config" \
     -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"validation_trust": "envelope"}'
   ```

2. Mint the first envelope. The agent runtime usually does this from its
   first chat session via the Envelope tab in the UI; if you need to do it
   manually, see [§6 Manual envelope construction](#6-manual-envelope-construction).

3. Confirm the envelope is staged on-disk:

   ```bash
   ls $BLUEPRINT_STATE_DIR/trading-envelopes/
   # btc-swing-v1.json
   ```

4. Hit the envelope status endpoint to confirm the runtime sees it:

   ```bash
   curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
        "$TRADING_API/envelope/status" | jq
   ```

   Expected: `{"present": true, "expires_at": <future>, "consumed_pct": 0, ...}`.

### 1.4 First-trade checklist

Before the bot fires its first live trade, walk through:

- [ ] `validation_trust` is `envelope` (or `per_trade` if intentional).
- [ ] Envelope is present and `expires_at` is at least 7 days in the future.
- [ ] Operator key derived address matches one of the envelope's
      `approval_signers` (single-sig auto-rotate path needs this).
- [ ] `paper_trade` flag is `false` if you want real execution
      (default behavior on `chain_id != 31338,31339`).
- [ ] Vault holds at least 1 USDC of float so the policy engine doesn't
      reject the first request for "zero NAV".
- [ ] Slack/PagerDuty webhooks have received a startup heartbeat (the
      `EnvelopeNearExpiry` info-level alert is a useful smoke signal).
- [ ] Prometheus scrape against `$TRADING_API/metrics/prometheus` returns
      200 and includes `envelope_renewal_action_total` series.

---

## 2. Rotating an envelope

### 2.1 When

Renewal triggers (constants in `trading-http-api/src/envelope_renewal.rs`):

| Trigger | Threshold |
|---|---|
| Time-to-expiry | < `RENEWAL_EXPIRY_WINDOW_SECS` (24 h) |
| Consumption | ≥ `RENEWAL_CONSUMED_PCT_THRESHOLD` (80 %) |
| Cron cadence | `RENEWAL_CRON_INTERVAL` (5 min) |
| Watcher cadence | `ENVELOPE_WATCHER_INTERVAL` (60 s) |

The watcher only fires *alerts* (`EnvelopeNearExpiry`,
`EnvelopeNearlyExhausted`); the cron is what actually rotates.

### 2.2 Single-sig auto-rotate (default)

If the operator key (`OPERATOR_PRIVATE_KEY`) matches one of the envelope's
`approval_signers` AND `min_signatures == 1`, the cron rotates in-place:

1. Builds a new envelope with `nonce = current.nonce + 1`,
   `expires_at = now + RENEWAL_DEFAULT_DURATION_SECS` (7 d).
2. Signs with the operator key.
3. Atomically writes `<state_dir>/trading-envelopes/<bot_id>.json.tmp.<pid>`
   and `rename`s it into place (crash-safe).
4. Records `envelope_renewal_action_total{action="auto_renewed"}`.

Operator action: **none required**. Confirm the rotation in logs:

```bash
journalctl -u trading-blueprint -f | grep "envelope renewal action"
```

### 2.3 Multi-sig webhook path

If `min_signatures > 1` or the operator key is NOT a signer, the cron fires
the configured `renewal_webhook_url` and records
`action="webhook_fired"` (or
`action="multisig_needs_renewal_no_webhook"` if the bot has none).

The webhook receives a `RenewalWebhookPayload`:

```json
{
  "event": "envelope_renewal_required",
  "bot_id": "...",
  "vault_address": "0x...",
  "chain_id": 8453,
  "protocol": "uniswap_v3",
  "nonce": 42,
  "expires_at": 1762000000,
  "consumed_amount": "750000000000",
  "max_total_amount": "1000000000000",
  "consumed_pct": 75.0,
  "reason": "consumption_threshold_breached",
  "min_signatures": 2,
  "approval_signers": ["0xSigner1", "0xSigner2"]
}
```

Human signing flow (run for each signer in turn):

```bash
# 1. Pull the staged unsigned envelope from the webhook receiver.
# 2. Each signer runs:
scripts/rotate-envelope.sh \
  --bot-id $BOT_ID \
  --signer-key-file ~/.trading/signer1.key \
  --rpc-url $HTTP_RPC_URL \
  --staging-url https://signing.example.com/staged/$BOT_ID

# 3. Once quorum is reached, the staging service PUTs the signed envelope:
curl -sS -X PUT "$TRADING_API/envelope" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d @signed_envelope.json
```

The `PUT /envelope` route enforces `nonce > current.nonce` (see
`SetEnvelopeError::NonceConflict`), so a stale stage that arrives after a
fresher rotation will be rejected with `409`.

### 2.4 Post-rotation verification

```bash
# Confirm new nonce + expiry on-disk:
jq '.nonce, .envelope.expiresAt' \
  $BLUEPRINT_STATE_DIR/trading-envelopes/$BOT_ID.json

# Confirm the runtime re-read it:
curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  "$TRADING_API/envelope/status" | jq '.nonce, .expires_at, .consumed_pct'

# Confirm Prometheus saw the rotation:
curl -sS "$TRADING_API/metrics/prometheus" \
  | grep 'envelope_renewal_action_total{.*auto_renewed'
```

---

## 3. Responding to alerts

Each `Alert` variant in `trading-http-api/src/alerts.rs` maps to a fixed
response procedure. **Never silence an alert without filing a corresponding
ticket.**

### 3.1 `EnvelopeRenewalFailed` — error/PagerDuty

The renewal cron surfaced a failure variant for this bot. Branches:

| `RenewalAction` | Cause | First action |
|---|---|---|
| `SingleSigOperatorKeyMismatch` | `OPERATOR_PRIVATE_KEY` doesn't derive any of the envelope's `approval_signers`. | Verify env, rotate key (§7) or PUT a re-signed envelope. |
| `ChainConsumptionUnavailable` | RPC down or wrong endpoint. | `curl $HTTP_RPC_URL` smoke; failover to backup RPC; the cron will retry next tick. |
| `MultisigNeedsRenewalNoWebhook` | Multi-sig envelope but `renewal_webhook_url` is unset. | Set the webhook URL on the bot record and back-fill the rotation manually. |
| Webhook 5xx | Receiver down. | Page the multi-sig signing infra owner; manually run §2.3 once recovered. |

Manual retry (after fixing the root cause):

```bash
curl -sS -X POST "$OPERATOR_API/api/bots/$BOT_ID/run-now" \
  -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN" \
  -d '{"workflow": "envelope_renewal"}'
```

### 3.2 `EnvelopeNearlyExhausted` — warning

`consumed_pct >= 90%` (the watcher threshold; cron fires earlier at 80 %).

1. Confirm the cron has actually fired:

   ```bash
   curl -sS "$TRADING_API/metrics/prometheus" \
     | grep "envelope_renewal_action_total.*$BOT_ID"
   ```

2. If a renewal is already staged (multi-sig), schedule signing within the
   next 24 h and notify the depositor cohort that the bot may pause if the
   envelope is fully consumed before quorum.

3. If the bot is in single-sig mode and the cron didn't rotate, treat as
   `EnvelopeRenewalFailed` (§3.1).

### 3.3 `EnvelopeNearExpiry` — info

`expires_at` is within 6 h. Single-sig: typically resolves itself on the
next cron tick. Multi-sig: confirm the webhook fired and quorum is in
progress.

Manual nudge:

```bash
# Force a renewal cron tick out-of-band (operator container).
docker exec -ti trading-blueprint \
  /usr/local/bin/trading-blueprint admin envelope renew --bot-id $BOT_ID
```

### 3.4 `TradeReverted` — warning

A live trade reverted on-chain (or the trading API returned 4xx/5xx). The
alert payload includes `bot_id`, `protocol`, `reason`. Classify:

1. **`reason` mentions an RPC error string** (`timeout`, `connection refused`,
   gateway 5xx) → infrastructure issue, fail over RPC. The runtime should
   pick up the new `HTTP_RPC_URL` on next request without a restart;
   otherwise restart the operator process.

2. **`reason` is a validation revert** (envelope/policy/trade-validator) →
   inspect the on-chain tx (link is in the alert's Slack block):

   ```bash
   cast tx $TX_HASH --rpc-url $HTTP_RPC_URL
   cast receipt $TX_HASH --rpc-url $HTTP_RPC_URL
   ```

   Common reverts:
   - `EnvelopeExceeded` → envelope budget consumed; trigger renewal.
   - `EnvelopeExpired` → renewal lagged; trigger renewal + investigate cron.
   - `PolicyEngine_*` → bot tried to violate policy; usually a strategy
     bug. File a P2 and let the agent see the reverted-trade outcome.

3. **`reason` is a market condition** (slippage, deadline, price-impact) →
   no operator action needed; the strategy will adapt.

### 3.5 `LearningStoreCorruption` — error/PagerDuty

`<state_dir>/learning/<bot_id>.json` is unreadable. The store fails *open*
(`load()` returns the default empty state on parse error and logs), so the
bot is not down — but the bandit and slippage-learner have lost history.

1. Snapshot the corrupt file for forensics:

   ```bash
   cp $BLUEPRINT_STATE_DIR/learning/$BOT_ID.json \
      /tmp/learning-corrupt-$BOT_ID-$(date +%s).json
   ```

2. Restore from the latest backup:

   ```bash
   scripts/restore-state.sh \
     --bot-id $BOT_ID \
     --kind learning \
     --from s3://my-trading-backups/learning/
   ```

3. Replay outcomes since the backup timestamp from the trade history (which
   is durable in Hasura/Postgres — see DR plan §3.3):

   ```sql
   SELECT bot_id, trade_id, variant_id, reward, executed_at
   FROM trade_outcomes
   WHERE bot_id = '<BOT_ID>' AND executed_at > '<backup_ts>'
   ORDER BY executed_at;
   ```

   Re-feed each outcome through `POST /learning/strategy-outcome`.

---

## 4. Emergency wind-down

### 4.1 Pause one bot (logical)

Stops the bot's scheduler and rejects new trade submissions, but does NOT
touch on-chain state. Reversible.

```bash
curl -sS -X POST "$OPERATOR_API/api/bots/$BOT_ID/stop" \
  -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN"
```

### 4.2 Pause one bot (on-chain)

Calls `TradingVault.pause()` (admin role required). Blocks new deposits and
trades; existing positions remain.

```bash
cast send $VAULT_ADDRESS "pause()" \
  --rpc-url $HTTP_RPC_URL \
  --private-key $OPERATOR_PRIVATE_KEY
```

To resume: `cast send $VAULT "unpause()" ...`.

### 4.3 Activate wind-down (`windDownActive`)

Wind-down is the **stronger** primitive: it blocks `execute()` *and* allows
permissionless `unwind()` so anyone can close positions back to the deposit
asset.

```bash
cast send $VAULT_ADDRESS "activateWindDown()" \
  --rpc-url $HTTP_RPC_URL \
  --private-key $OPERATOR_PRIVATE_KEY
```

Reversible via `deactivateWindDown()` (same caller).

The convenience wrapper:

```bash
scripts/wind-down-bot.sh \
  --vault $VAULT_ADDRESS \
  --rpc-url $HTTP_RPC_URL \
  --reason "operator-key-rotation"
```

### 4.4 Pause the whole fleet

There is no on-chain global pause. Fleet-wide pause is achieved by:

1. Stopping the operator process (`systemctl stop trading-blueprint`) — this
   kills new submissions immediately.
2. For belt-and-suspenders, iterating `activateWindDown()` over every vault
   in `<state_dir>/trading-bots.json`:

   ```bash
   jq -r '.bots[].vault_address' $BLUEPRINT_STATE_DIR/trading-bots.json \
     | xargs -I{} scripts/wind-down-bot.sh --vault {} \
                  --rpc-url $HTTP_RPC_URL --reason fleet-pause
   ```

This is a P0 action — page the on-call and notify depositors before doing
it (§incident-response.md).

---

## 6. Manual envelope construction

Use this when the agent runtime can't produce an envelope (e.g. the agent
is down, or you need to bootstrap before the first chat session).

The trading API exposes per-protocol quote endpoints that *return an
unsigned envelope* shaped for that protocol:

```bash
# Uniswap v3 example
curl -sS -X POST "$TRADING_API/envelope/quote/uniswap_v3" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "token_in": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "token_out": "0x4200000000000000000000000000000000000006",
    "fee_tier": 500,
    "max_total_amount_in": "1000000000",
    "max_value_usd": "1000",
    "duration_secs": 604800
  }' > unsigned_envelope.json
```

Sign it with the operator key:

```bash
cast wallet sign \
  --private-key $OPERATOR_PRIVATE_KEY \
  $(jq -r '.digest' unsigned_envelope.json) \
  > sig.hex

jq --arg sig "$(cat sig.hex)" \
   '.signatures = [{"signer": env.OPERATOR_ADDRESS, "signature": $sig}]' \
   unsigned_envelope.json > signed_envelope.json
```

Submit it:

```bash
curl -sS -X PUT "$TRADING_API/envelope" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d @signed_envelope.json
```

Other protocols use the same pattern with different paths
(`/envelope/quote/{uniswap_v4,aerodrome,aave_v3,morpho}`).

---

## 7. Adding a new chain

For each new EVM chain we want to support:

1. **Pick a chain ID.** Confirm it's not already in
   `arena/src/lib/contracts/chains.ts`.

2. **Set deploy env:**

   ```bash
   export CHAIN_ID=<id>
   export RPC_URL=<chain rpc>
   export PRIVATE_KEY=<deployer key>
   export ASSET_TOKEN=<canonical USDC for chain>
   export ADMIN=<admin multisig>
   export SIGNERS=<addr1>,<addr2>,<addr3>          # >= 3 distinct addresses
   export REQUIRED_SIGS=2                          # >= ceil(2*n/3)
   export ETHERSCAN_KEY=<chain explorer api key>
   # Optional but recommended: deploys UniswapV3TwapValuator alongside the
   # rest of the stack so the bot can price custom assets that lack a
   # Chainlink feed. Skip on chains without a Uniswap V3 deployment.
   export UNISWAP_V3_FACTORY=<v3 factory addr>     # 0x1F98...984 on most chains
   ```

3. **Deploy:**

   ```bash
   forge script contracts/script/DeployEnvelopeV3.s.sol \
     --rpc-url $RPC_URL --broadcast --slow \
     --verify --etherscan-api-key $ETHERSCAN_KEY
   ```

   This writes `deployments/$CHAIN_ID/v3.json` (consumed by the arena and
   the operator runtime).

4. **Verify post-deploy:**

   ```bash
   TRADE_VALIDATOR=$(jq -r '.tradeValidator' deployments/$CHAIN_ID/v3.json) \
   SAMPLE_VAULT=$(jq -r '.sampleVault' deployments/$CHAIN_ID/v3.json) \
     forge script contracts/script/VerifyEnvelopeV3.s.sol --rpc-url $RPC_URL
   ```

   Must print `VERIFICATION PASSED`.

5. **Seed Chainlink feeds.** `ChainlinkUsdValuator` deploys empty — every
   token a bot will hold needs a `setFeed(token, feed, maxStaleness)` call
   from the admin (per `cfg.admin`). At minimum: the deposit asset + every
   token in the default arena asset list for this chain.

   ```bash
   CHAINLINK_VALUATOR=$(jq -r '.chainlinkUsdValuator' deployments/$CHAIN_ID/v3.json)
   cast send $CHAINLINK_VALUATOR \
     "setFeed(address,address,uint48)" \
     <token> <chainlink_usd_feed> <max_staleness_secs> \
     --rpc-url $RPC_URL --private-key $ADMIN_KEY
   ```

   Repeat for each (token, feed) pair. `max_staleness_secs` should match
   the feed's actual heartbeat (e.g., 86400 for Chainlink USD feeds on most
   chains).

6. **Wire operator env vars** before starting the trading-blueprint
   binary. The provision flow reads valuator addresses from env; without
   these, custom assets fail provisioning with `"... is supported but
   missing vault valuation adapter for ..."` or `"... requires Uniswap V3
   TWAP valuation, but no TWAP valuator address is configured"`.

   ```bash
   export CHAINLINK_USD_VALUATOR_ADDRESS=$(jq -r '.chainlinkUsdValuator' deployments/$CHAIN_ID/v3.json)
   export UNISWAP_V3_TWAP_VALUATOR_ADDRESS=$(jq -r '.uniswapV3TwapValuator' deployments/$CHAIN_ID/v3.json)
   ```

   Empty `UNISWAP_V3_TWAP_VALUATOR_ADDRESS` is OK — bots that don't use
   the TWAP-fallback adapter mode won't notice. Bots that do (any custom
   asset without a Chainlink feed) will fail provision with the message
   above.

7. **Wire arena chains.ts:** add the entry referencing the new
   `deployments/$CHAIN_ID/v3.json`. Keep the JSON path canonical — the
   arena build reads from there at compile time.

8. **Add to operator env templates:** update `settings.env.example` and
   your secrets manager templates to include the new chain's RPC URLs,
   asset addresses, and the two `*_VALUATOR_ADDRESS` env vars from step 6.

9. **Smoke test** with a paper-trade bot before opening to depositors.
   Provision a bot that includes a custom (non-Chainlink) asset in its
   universe — exercises the TWAP-fallback resolution end-to-end.

---

## 8. Adding a new venue

When adding a new protocol/venue (e.g. a new DEX or lending market), follow
the 11-checklist mirroring the v3 audit pattern:

- [ ] **Typehash** added to `TradeValidator.sol` — pinned to the canonical
      EIP-712 string. Match the on-chain assertion in
      `VerifyEnvelopeV3._checkAllTypehashes`.
- [ ] **Hash function** for the new enforcement struct is implemented (and
      its EIP-712 encoding matches the typehash exactly).
- [ ] **`validate()` branch** in `TradeValidator` covers the new
      enforcement variant.
- [ ] **Executor branch** in `TradingVault.execute*Envelope` decodes the
      new variant and dispatches to the protocol adapter.
- [ ] **ABI bridge** in `trading-runtime` (the Rust side) adds the new
      enforcement struct, its hash, and its policy decoding.
- [ ] **Unit tests** under `contracts/test/` for typehash + hash +
      validate.
- [ ] **Fork test** under `contracts/test/fork/` exercising a real swap.
- [ ] **Gas budget** measured (`forge test --gas-report`) and entered in
      `audits/envelope-v3-solidity-audit.md`.
- [ ] **Monitoring labels** — add the new `protocol` label to
      `record_renewal_action`, `record_trade_outcome`, and any Slack/PD
      summaries that key off `protocol`.
- [ ] **Audit doc** entry added to
      `audits/envelope-v3-solidity-audit.md` with the typehash + a one-line
      threat model.
- [ ] **Runbook entry** here under §3 if the venue surfaces new revert
      reasons operators need to know about.

---

## 9. Operator key rotation

Operator key rotation is intrusive — it invalidates every single-sig
envelope signed by the old key. Plan a maintenance window.

### 9.1 Pre-rotation envelope freeze

1. **Stop the renewal cron** by setting `validation_trust = per_trade` on
   every envelope-mode bot temporarily. This prevents a half-rotated state
   where the cron re-signs with the new key while the runtime still holds
   the old envelope.

   ```bash
   for bot in $(jq -r '.bots[] | select(.validation_trust=="envelope") | .bot_id' \
                $BLUEPRINT_STATE_DIR/trading-bots.json); do
     curl -sS -X PATCH "$OPERATOR_API/api/bots/$bot/config" \
       -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN" \
       -d '{"validation_trust": "per_trade"}'
   done
   ```

2. **Snapshot state** (also done by the systemd timer; do it manually here
   to be sure):

   ```bash
   scripts/backup-state.sh --tag pre-rotation
   ```

### 9.2 Key swap

1. Stop the operator process: `systemctl stop trading-blueprint`.
2. Update the secret in your secrets manager:
   `OPERATOR_PRIVATE_KEY=<new key>`. The new key's address must match a
   `approval_signer` on every envelope you intend to keep, OR every
   envelope must be re-signed (next step).
3. Restart: `systemctl start trading-blueprint`.

### 9.3 Re-sign envelopes (if signer set is changing)

For each bot, walk through §6 with the new key, then PUT the new envelope.
The nonce-monotonicity check ensures the runtime accepts the new envelope
and discards the old one.

### 9.4 Post-rotation smoke test

```bash
# 1. Confirm operator address derives from new key.
curl -sS "$OPERATOR_API/api/meta" | jq

# 2. Pick one bot, flip back to envelope mode, dry-run a trade.
BOT=<one bot id>
curl -sS -X PATCH "$OPERATOR_API/api/bots/$BOT/config" \
  -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN" \
  -d '{"validation_trust": "envelope"}'

curl -sS -X POST "$TRADING_API/validate" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"intent": { ... small test intent ... }, "dry_run": true}'

# 3. If validate passes, flip the rest of the fleet back.
```

If anything fails the smoke test, restore from the pre-rotation snapshot
(§disaster-recovery.md §3.2) and roll back to the old key.

---

## 10. Reference: where things live

| Concept | Location |
|---|---|
| Envelope on-disk | `<state_dir>/trading-envelopes/<bot_id>.json` |
| Learning state | `<state_dir>/learning/<bot_id>.json` |
| Trade history | `<state_dir>/trade-history.json` (per-bot under `<state_dir>/bot-trades/`) |
| Bot registry | `<state_dir>/trading-bots.json` |
| Activation progress | `<state_dir>/activation-progress.json` |
| Deployments | `deployments/<chainId>/v3.json` |
| Alert taxonomy | `trading-http-api/src/alerts.rs` |
| Renewal cron | `trading-http-api/src/envelope_renewal.rs` |
| Watcher | `trading-http-api/src/envelope_watcher.rs` |
| Operator API | `trading-blueprint-bin/src/operator_api.rs` |
| Trading API | `trading-http-api/src/lib.rs::build_multi_bot_router` |
| Prometheus | `trading-http-api/src/routes/prometheus.rs` |

