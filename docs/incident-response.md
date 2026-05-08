# Trading Blueprint Incident Response Playbook

This playbook defines severity levels, detection criteria, response steps,
escalation paths, and communication templates for the trading-blueprint
operator stack. It pairs with `docs/runbook.md` (procedural how-to) and
`docs/disaster-recovery.md` (state recovery).

## Severity matrix

| Sev | Definition | Examples | Response time | Escalation |
|---|---|---|---|---|
| **P0** | Funds at immediate risk OR fleet-wide outage | Contract exploit draining funds; operator key compromise; multi-bot fleet down | **Acknowledge < 5 min, on-call live within 15 min** | Page on-call + security + engineering lead immediately |
| **P1** | Single-bot outage OR repeated infra failure with customer-visible impact | One bot's envelope renewal failing repeatedly; chain congestion blocking trades for >30 min; one host down | **Ack < 15 min, mitigation in progress < 1 h** | Page on-call; loop in eng lead if not resolved in 2 h |
| **P2** | Degraded performance, monitoring gap, transient errors | Elevated latency; intermittent 5xx on a non-critical endpoint; alert noise; metric scrape gap | Ack < 1 h business-day, < 4 h overnight | On-call handles in working hours |
| **P3** | Cosmetic / documentation / non-customer-facing | Doc typo; minor log noise; non-blocking lint failure | Next business day | None |

> **When in doubt, escalate up.** It is cheaper to downgrade a P1 to P2
> than to discover a P2 was actually a P1 four hours later.

---

## P0 — Critical

### P0.1 Contract exploit draining funds

**Detection.**

- Prometheus alert `vault_total_assets_decreased_unexpectedly` (TVL drops
  by > 10 % in a 5-min window outside a known unwind).
- On-chain monitoring (Tenderly / Forta) flagging a known exploit
  signature against the deployed `TradingVault` / `TradeValidator`.
- External report (security researcher, depositor).

**Initial response — first 15 minutes.**

1. Confirm the loss is real (not a metric glitch): query the vault's
   `totalAssets()` directly:
   ```bash
   cast call $VAULT 'totalAssets()(uint256)' --rpc-url $RPC
   ```
2. **Activate wind-down on every vault on the affected chain** — this
   blocks `execute()` (no further drain via the operator) and lets
   depositors `unwind()` permissionlessly:
   ```bash
   jq -r '.bots[] | select(.chain_id==<id>) | .vault_address' \
     $BLUEPRINT_STATE_DIR/trading-bots.json \
     | xargs -I{} cast send {} 'activateWindDown()' \
       --rpc-url $RPC --private-key $BREAKGLASS_ADMIN_KEY
   ```
   This is run by whoever holds the admin multisig.
3. Stop the operator process on every host:
   `ansible operators -a 'systemctl stop trading-blueprint'`.
4. Open a war-room Slack channel `#incident-<YYYYMMDD>-<short-name>`.
5. Page legal (depositor notification SLA: < 1 h).

**Escalation.**

- On-call → engineering lead → security lead → CEO (in that order, in
  parallel — every minute counts).
- Notify auditors of the affected contract version.

**Comms templates.** See [§Comms templates](#comms-templates).

**Post-incident review.** Mandatory within 7 days. Root-cause + remediation
+ disclosure timeline.

### P0.2 Operator key compromise

**Detection.**

- Secrets-manager finding (AWS GuardDuty, IAM access anomaly).
- Unauthorized signed transaction from the operator address (matched
  against the cron's audit log).
- External report.

**Initial response — first 15 minutes.**

Follow `docs/disaster-recovery.md §3.4`.

1. Stop the operator process fleet-wide.
2. Activate wind-down on every vault.
3. Page legal.

**Escalation.**

- Same as P0.1.
- Additionally: the secrets team to invalidate the compromised key in the
  KMS / HSM.

### P0.3 Multi-bot fleet down

**Detection.**

- `up{job="trading-blueprint"} == 0` across multiple hosts in
  Prometheus.
- All `/health` endpoints returning 5xx for > 5 min.
- All Slack alerts going silent for > 10 min during expected business
  hours (suspicious — sometimes the alert sink itself is down).

**Initial response.**

1. Triage: is it the operator process, the network, or upstream
   (RPC, Hasura, S3)?
   - `curl https://hooks.slack.com` from one host — is outbound network
     working?
   - `cast block-number --rpc-url $RPC` — is the RPC up?
   - `psql $HASURA_DSN -c 'SELECT 1'` — is the DB up?
2. If it's the operator process: identify a common cause (recent deploy?
   bad env var? expired cert?). If recent deploy → **rollback first, ask
   questions later** via `gh workflow run rollback.yml -f
   to=<previous-tag>`.
3. If it's upstream: failover to backup RPC / DB / S3 endpoint and
   restart the fleet.

**Escalation.**

- On-call → eng lead → infra lead.

---

## P1 — High

### P1.1 Single bot stuck

**Detection.**

- One bot's `EnvelopeRenewalFailed` alerts repeating > 3 times in 30 min.
- One bot's `/health` returning 5xx for > 10 min while others are healthy.
- Customer report.

**Initial response — first 30 minutes.**

1. Pull the recent logs for the bot:
   ```bash
   journalctl -u trading-blueprint --since '30 minutes ago' \
     | grep "bot_id=$BOT_ID"
   ```
2. Determine the failure variant from the logged `RenewalAction`. Apply
   the matching response from `docs/runbook.md §3`.
3. If the issue persists after one rotation cycle, stop the bot:
   ```bash
   curl -sS -X POST "$OPERATOR_API/api/bots/$BOT_ID/stop" \
     -H "Authorization: Bearer $OPERATOR_SESSION_TOKEN"
   ```
   and notify the depositor cohort.

**Escalation.** On-call → eng lead if not resolved in 2 h.

### P1.2 Envelope renewal failures repeating

**Detection.** PromQL:

```promql
sum by (action) (
  rate(envelope_renewal_action_total{
    action!~"healthy|auto_renewed|webhook_fired|no_envelope"
  }[15m])
) > 0
```

(Any non-healthy action class > 0 sustained over 15 min.)

**Initial response.**

1. Identify which bots are affected:
   ```bash
   curl -sS "$TRADING_API/metrics/prometheus" \
     | grep -E 'envelope_renewal_action_total\{.*action="(single_sig_operator_key_mismatch|chain_consumption_unavailable|multisig_needs_renewal_no_webhook)"\}.* [^0]$'
   ```
2. If the same `action` shows up across many bots, the root cause is
   shared (bad RPC, missing trusted-signer config, secrets-manager
   misconfiguration). Fix once, all bots recover.
3. If different `action`s across many bots, treat as P0.3.

### P1.3 Chain congestion blocking trades

**Detection.** `TradeReverted` with reason matching `gas_price_too_low`,
`replacement_underpriced`, `transaction underpriced` for > 30 min.

**Initial response.**

1. Check chain mempool depth (e.g. https://etherscan.io/gastracker).
2. If congestion is real, raise the operator's `MAX_PRIORITY_FEE_GWEI`
   env and restart. The runtime re-reads it on next request.
3. If trades are still rejected after a fee bump, set `paper_trade = true`
   on every bot until the chain recovers. Notify depositors.

### P1.4 Single host down

**Detection.** `up{job="trading-blueprint",instance="host-X"} == 0`.

**Initial response.**

1. Confirm host is unreachable (not just the metrics endpoint).
2. If disk is intact, restart per `docs/disaster-recovery.md §3.1`.
3. If disk is gone, rehydrate per `docs/disaster-recovery.md §3.2`.
4. While rehydrating, traffic should be drained — if the host is part of a
   load-balanced set, depool it.

---

## P2 — Medium

### P2.1 Monitoring gap

**Detection.** Prometheus scrape gap > 10 min for one or more hosts; or
a metric we expect to exist (`envelope_renewal_action_total`) is missing.

**Initial response.**

1. Check if the operator process is actually serving `/metrics/prometheus`:
   ```bash
   curl -sS "$TRADING_API/metrics/prometheus" | head -20
   ```
2. If yes, check the scrape config on the Prometheus server.
3. File a P2 ticket with the gap window and resolution.

### P2.2 Degraded performance

**Detection.** p99 latency on `/execute` > 5 s for > 30 min; or trade
success rate drops by > 10 % over baseline.

**Initial response.**

1. Identify the slow path: RPC? validator? policy engine? Use
   per-route latency histograms.
2. If it's the RPC, failover.
3. If it's the validator quorum, check validator availability and the
   `min_validator_score` setting.

### P2.3 Transient API errors

**Detection.** 5xx rate on `/execute` > 1 % for < 30 min, then recovers.

**Initial response.**

1. Capture the error sample (request id from logs).
2. Confirm recovery; file a P2 to investigate.

---

## P3 — Low

Cosmetic bugs, docs gaps, minor log noise. File a ticket; address in the
next sprint. No paging.

---

## Comms templates

### Status page (P0 / P1)

```
[INVESTIGATING] <short title>
We are investigating an issue affecting <scope>. Trades for affected bots
are paused while we restore service. Depositor funds are not at risk —
the vault contracts are non-custodial and depositors retain the ability to
withdraw via the permissionless unwind() path. Next update in 30 min.
```

### Slack — internal (P0)

```
@here :rotating_light: P0 incident — <one-line summary>
Detection: <signal>
Impact: <scope: chains, bots, depositors>
Containment: <wind-down active? operator stopped? RPC failed over?>
Owner: <name> | War room: #incident-<id>
Next checkpoint: <ts> (every 30 min until resolved)
```

### Customer email (P0 with depositor impact)

```
Subject: Service incident affecting <bot name / chain> — action may be required

Hello,

At <time UTC> we detected <one-line description>. As a precaution we have
activated the on-chain wind-down for the affected vaults. Your deposit is
not at risk and remains under your control: you can withdraw at any time
using the permissionless unwind path described at <docs link>.

We will provide a follow-up update by <time UTC> with the root cause and
expected restoration timeline. The full post-incident review will be
published within 7 days at <url>.

If you have urgent questions, reach us at <email> or in <community
channel>.

— The Trading Blueprint team
```

### PagerDuty acknowledgment

```
Ack — investigating <signal>. War room: <slack link>. Next update in 15.
```

---

## Post-incident review checklist

Mandatory for P0 (within 7 days) and P1 (within 14 days). Recommended for
P2 (within 30 days).

- [ ] **Timeline** — minute-by-minute log from first detection to
      resolution, with timestamps in UTC.
- [ ] **Root cause** — the *one* technical or procedural fault that, if
      removed, would have prevented the incident. Resist multiple-cause
      framing; pick the proximate trigger.
- [ ] **Contributing factors** — everything else that made the incident
      worse or harder to detect.
- [ ] **Detection delay** — time from incident-actually-began to
      first-alert-fired. If > 5 min for a P0, file a monitoring-gap
      action item.
- [ ] **Response delay** — time from first-alert to first-human-action.
      If > 15 min, review on-call rotation health.
- [ ] **Mitigation effectiveness** — did the playbook step actually
      stop the bleed? If no, the playbook needs an update.
- [ ] **Customer impact** — number of affected bots, dollar value at
      risk (if any), worst-case loss avoided.
- [ ] **Action items** — each tagged as P0/P1/P2 with an owner and ETA.
      P0 action items must be completed before any further deploy on the
      affected component.
- [ ] **Disclosure** — public post-mortem published per the disclosure
      policy (P0 → public within 14 days unless legal holds; P1 →
      summary in monthly newsletter).
- [ ] **Sign-off** — eng lead + on-call who handled the incident +
      security lead (if P0).

