# Trading Blueprint Disaster Recovery Plan

This document codifies recovery objectives, backup strategy, and recovery
procedures for the trading-blueprint operator stack. It sits alongside the
operator runbook (`docs/runbook.md`) and the incident response playbook
(`docs/incident-response.md`).

## 1. Recovery objectives

| Objective | Target | Notes |
|---|---|---|
| **RTO** (partial outage — single bot or single host) | 1 hour | Driven by S3 snapshot restore + operator process restart. |
| **RTO** (full datacenter / multi-host) | 4 hours | Includes secret rehydration in a fresh region. |
| **RPO** (envelope state) | 10 minutes | Snapshot cadence of `<state_dir>/trading-envelopes/`. |
| **RPO** (learning state) | 10 minutes | Same systemd timer as envelopes. |
| **RPO** (trade history) | 5 minutes | Trade history is durably persisted in Hasura/Postgres; replay window is the longer of (postgres replication lag, last successful snapshot). |
| **RPO** (operator key) | 0 (offline copies) | Never backed up to cloud — operators maintain offline Shamir splits. |

> An "outage" means the *operator API is unable to admit new trade requests
> or rotate envelopes*. On-chain assets are never at risk from operator
> downtime alone — the smart contracts are non-custodial and the
> `windDownActive` permissionless unwind is always available to depositors.

## 2. Backup strategy

### 2.1 What gets backed up

| Asset | Source path | Backup destination | Cadence |
|---|---|---|---|
| Envelope storage | `<state_dir>/trading-envelopes/` | `s3://<bucket>/envelopes/<hostname>/` | 10 min |
| Learning state | `<state_dir>/learning/` | `s3://<bucket>/learning/<hostname>/` | 10 min |
| Bot registry | `<state_dir>/trading-bots.json` | `s3://<bucket>/registry/<hostname>/` | 10 min |
| Activation progress | `<state_dir>/activation-progress.json` | `s3://<bucket>/registry/<hostname>/` | 10 min |
| Trade history | Hasura/Postgres | Hasura/Postgres replica + WAL archiving | continuous |
| Deployment JSON | `deployments/<chainId>/v3.json` | git (committed by CI) | per-deploy |
| Operator key material | (offline) | Shamir-split offline copies | one-shot |

### 2.2 What does NOT get backed up

- **Operator private key** (`OPERATOR_PRIVATE_KEY`). Never written to S3.
  Operators maintain offline Shamir-split copies (e.g. `ssss-split -t 3 -n 5`).
- **Per-bot `BOT_TOKEN`**. These are per-bot bearer tokens stored in the
  bot record. The record IS backed up, so tokens recover with the registry.
- **Sidecar runtime caches** (everything under `<state_dir>/sandboxes/`).
  These are reproducible from the bot spec.

### 2.3 Reference systemd units

`scripts/backup-state.sh` is invoked by a systemd timer. Drop these into
`/etc/systemd/system/` on each operator host (or use the equivalent in your
config-management tool).

`/etc/systemd/system/trading-envelope-backup.service`:

```ini
[Unit]
Description=Trading blueprint state snapshot to S3
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/trading-blueprint/backup.env
# backup.env defines: STATE_DIR, BACKUP_S3_URI, AWS_REGION, AWS_ACCESS_KEY_ID,
#                     AWS_SECRET_ACCESS_KEY (or use IAM instance role)
ExecStart=/usr/local/bin/backup-state.sh \
  --state-dir ${STATE_DIR} \
  --s3-uri ${BACKUP_S3_URI} \
  --hostname %H

# Don't kill an in-flight upload; let it finish or fail explicitly.
TimeoutStartSec=8min

# We only need read of state-dir + write of S3; minimal privilege.
DynamicUser=no
User=trading-blueprint
Group=trading-blueprint
ReadOnlyPaths=/var/lib/trading-blueprint/state
ProtectSystem=strict
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/trading-envelope-backup.timer`:

```ini
[Unit]
Description=Run trading-envelope-backup every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
AccuracySec=30s
# Run immediately if we missed a tick (e.g. host was down).
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
systemctl daemon-reload
systemctl enable --now trading-envelope-backup.timer
```

Verify the next-run time:

```bash
systemctl list-timers trading-envelope-backup.timer
```

### 2.4 S3 bucket conventions

- Versioning: **enabled**. Required so a corrupt-snapshot push doesn't wipe
  the previous good copy.
- Lifecycle: keep 90 days hot, transition to Glacier after 90, expire after
  365.
- Encryption: SSE-KMS with a customer-managed key. The KMS key policy
  scopes decryption to the operator-host IAM role.
- Bucket policy: deny `s3:DeleteObject` and `s3:PutBucketVersioning` from
  the operator-host role; only the security-team break-glass role may
  delete.

## 3. Recovery procedures

### 3.1 Server crash with intact disk

The simplest case. The operator process crashed but `<state_dir>` is fine.

1. `systemctl status trading-blueprint` — confirm it's down.
2. Check the last log lines for the panic / OOM / disk-full root cause.
3. `systemctl start trading-blueprint`.
4. Envelopes auto-load from `<state_dir>/trading-envelopes/` on startup;
   the renewal cron and watcher resume on the next tick.
5. Smoke test: hit `/metrics/prometheus` and `/health` on each port.

Expected total recovery: < 5 min. No snapshot restore needed.

### 3.2 Disk loss

Local disk is gone (failed SSD, accidental `rm -rf`, container was
ephemeral with no volume). State must be rehydrated from S3.

1. **Provision a replacement host** with the same hostname (or remap the
   S3 path prefix to the new hostname).
2. **Install the operator binary** at the same version as the lost host.
   Pull from GHCR or from the GH release matching the running version
   recorded in `<bucket>/registry/<hostname>/version.txt` (written by
   `backup-state.sh`).
3. **Restore state from the latest snapshot:**

   ```bash
   scripts/restore-state.sh \
     --state-dir /var/lib/trading-blueprint/state \
     --s3-uri s3://<bucket>/ \
     --hostname <original-hostname> \
     --as-of latest
   ```

   The script:
   - Pulls `envelopes/`, `learning/`, and `registry/` for the host.
   - Writes them to a staging directory (`<state_dir>.restore`).
   - Atomic-renames the staging dir into `<state_dir>` once all
     downloads succeed.
   - Aborts (and does not touch `<state_dir>`) if any download fails.

4. **Restore secrets** (`OPERATOR_PRIVATE_KEY`, alert webhooks, RPC URLs)
   from the secrets manager — these are NOT in S3.

5. **Start the operator process** and verify:

   ```bash
   systemctl start trading-blueprint
   journalctl -u trading-blueprint -f | grep -E "(loaded|envelope renewal|ready)"
   ```

6. **Replay missed trades** — trade history in Postgres is the source of
   truth. The runtime does not auto-replay; if the disk-loss window
   contained trades, see §3.3.

### 3.3 Trade history recovery (cross-check)

Trade history is durably stored in Hasura/Postgres. Use it to:

- Verify which envelope nonces have been consumed since the last
  snapshot.
- Repopulate the bandit/slippage-learner from outcomes (if learning state
  is also stale).

Recovery query (run against the analytics replica, not primary):

```sql
-- All trades for a bot since the snapshot timestamp, in execution order.
SELECT bot_id,
       trade_id,
       protocol,
       envelope_nonce,
       amount_in,
       reward,
       variant_id,
       reverted,
       executed_at
FROM trade_outcomes
WHERE bot_id = :bot_id
  AND executed_at > :snapshot_ts
ORDER BY executed_at;
```

For each non-reverted row, re-feed `POST /learning/strategy-outcome` to
reconstruct the bandit state. For each row, cross-check that
`envelope_nonce <= current envelope's nonce` — if not, the on-chain envelope
is ahead of the restored disk state and you must trigger a rotation
(`scripts/rotate-envelope.sh`) to bring them back in sync.

### 3.4 Operator key compromise

This is the **hardest** recovery case. If `OPERATOR_PRIVATE_KEY` is
suspected compromised (leaked, exfiltrated, signed an unsanctioned
transaction), every single-sig envelope it signed must be considered
revoked.

#### 3.4.1 Detection

Signals that should trigger this procedure:

- Slack/PagerDuty alert for `EnvelopeRenewalFailed` with `RenewalAction`
  showing a signature that wasn't issued by the cron (audit logs disagree
  with on-chain history).
- Unauthorized `Approval`/`Trade` event from the operator address.
- Compromise indicator from your secrets manager (e.g. AWS GuardDuty
  finding on the IAM role that holds the key).

#### 3.4.2 Containment (first 15 min)

1. **Stop the operator process on every host:**

   ```bash
   ansible operators -a 'systemctl stop trading-blueprint'
   ```

2. **Activate wind-down on every vault** (this blocks `execute()` and
   enables permissionless `unwind()`):

   ```bash
   jq -r '.bots[].vault_address' \
     $BLUEPRINT_STATE_DIR/trading-bots.json \
     | xargs -I{} cast send {} 'activateWindDown()' \
       --rpc-url $HTTP_RPC_URL \
       --private-key $BREAKGLASS_ADMIN_KEY
   ```

   Use a *separate* break-glass admin key — NOT the compromised operator
   key — for this. The admin role is held by a multisig on production
   vaults; the multisig executes wind-down via its own UI.

3. **Page legal/comms:** depositor notification within 1 hour is required
   under the operator agreement.

#### 3.4.3 Revocation + envelope renewal with new key

This is multi-sig-signing-flow heavy. The vault contracts are NOT proxies,
so we cannot upgrade away from the compromised key — we must rotate it via
the existing role mechanisms.

For each affected vault:

1. **Generate a new operator key** in the secrets manager (HSM-backed if
   available). Record its address.

2. **Replace the operator role** on the vault. The `OPERATOR_ROLE` is
   granted via `AccessControl` on `TradingVault`:

   ```bash
   # Multisig admin runs:
   cast send $VAULT \
     'revokeRole(bytes32,address)' \
     $OPERATOR_ROLE_HASH \
     $COMPROMISED_OPERATOR_ADDR \
     --private-key $MULTISIG_KEY

   cast send $VAULT \
     'grantRole(bytes32,address)' \
     $OPERATOR_ROLE_HASH \
     $NEW_OPERATOR_ADDR \
     --private-key $MULTISIG_KEY
   ```

3. **Re-sign every envelope** with the new key (multi-sig path requires
   one signature per signer; if the compromised key was a signer,
   replace it in the `approval_signers` set first via the
   `TradeValidator` admin path).

4. **Restart operators** with the new key:

   ```bash
   # On each operator host:
   sudo systemctl set-environment OPERATOR_PRIVATE_KEY=...
   sudo systemctl start trading-blueprint
   ```

5. **Deactivate wind-down** once a smoke trade succeeds on each vault:

   ```bash
   cast send $VAULT 'deactivateWindDown()' --private-key $MULTISIG_KEY
   ```

6. **Post-incident review** (mandatory): publish a post-mortem within 7
   days, including the compromise vector, the exact set of envelopes
   re-signed, and any depositor impact.

### 3.5 Smart-contract bug requiring upgrade

The contracts are **not** proxies. Recovery is "deploy v4, migrate state,
deprecate v3".

#### 3.5.1 Migration checklist

- [ ] **Trigger:** confirmed bug with a documented exploit path or a
      validator-flagged invariant violation.
- [ ] **Freeze v3:** activate wind-down on every vault (§3.4.2 step 2).
      This blocks `execute()` and lets depositors `unwind()` themselves.
- [ ] **Audit v4:** the patched contracts go through the same external
      audit gate as the original (see `audits/`).
- [ ] **Deploy v4:** new chain deploy via `DeployEnvelopeV4.s.sol`
      (mirroring `DeployEnvelopeV3.s.sol`). Output goes to
      `deployments/{chainId}/v4.json`.
- [ ] **Verify v4:** a new `VerifyEnvelopeV4.s.sol` confirms typehashes,
      digest non-zero, and zero envelope consumption on fresh state.
- [ ] **Migration tool:** for each existing vault, decide between
      a) "exit-only" — depositors `unwind()` from v3, then redeposit into
      v4 themselves; or b) "operator-mediated" — operator pulls assets via
      `emergencyWithdraw` to a recovery multisig, redeposits into v4 on
      depositors' behalf with on-chain proof of share allocation.
      Option (a) is the default; option (b) requires depositor consent.
- [ ] **Re-provision bots** against v4 vaults. Bot state (envelopes,
      learning) does NOT migrate — issue fresh envelopes from the new
      `TradeValidator` address.
- [ ] **Update arena `chains.ts`** to point at `v4.json` instead of
      `v3.json` for the migrated chain.
- [ ] **Deprecate v3:** mark v3 vaults as "winding down" in the
      `arena` UI; remove from new-bot creation flow but keep accessible
      for depositor `unwind()` flows.
- [ ] **Post-mortem** within 14 days.

## 4. Failure modes catalog

Each known failure mode with detection signal + first-response procedure.
Keep this list in sync with `trading-http-api/src/alerts.rs::Alert`.

| Failure | Detection | First response | Runbook section |
|---|---|---|---|
| Operator process panic | `systemctl status` non-zero; `journalctl` shows panic | restart; check `<state_dir>` permissions | runbook §3.4 (`TradeReverted` if cascading) |
| RPC outage | `EnvelopeRenewalFailed` with `ChainConsumptionUnavailable` | failover RPC; retry cron | runbook §3.1 |
| Operator key mismatch | `EnvelopeRenewalFailed` with `SingleSigOperatorKeyMismatch` | rotate key OR PUT re-signed envelope | runbook §9 |
| Multi-sig webhook 5xx | `EnvelopeRenewalFailed` with `MultisigNeedsRenewalNoWebhook` (post-fix) or repeated webhook errors in logs | page signing-infra owner | runbook §2.3 |
| Envelope exhausted | `EnvelopeNearlyExhausted` warning + on-chain `EnvelopeExceeded` revert | trigger renewal; communicate with depositors | runbook §3.2, §3.4 |
| Envelope expired | `EnvelopeNearExpiry` info → unaddressed → `EnvelopeExceeded` revert | force-renew; investigate cron health | runbook §3.3 |
| Trade revert (slippage) | `TradeReverted` with market reason | no action; bot adapts via learning | runbook §3.4 |
| Trade revert (validator) | `TradeReverted` with policy reason | inspect tx; file P2 strategy bug | runbook §3.4 |
| Learning corruption | `LearningStoreCorruption` error | snapshot, restore, replay | runbook §3.5 |
| Disk full | `LearningStoreCorruption` (write fails); `EnvelopeRenewalFailed` (Internal) | free disk; check log rotation; snapshot before restart | DR §3.1 |
| Disk loss | host unresponsive; ssh fails | rehydrate from S3 | DR §3.2 |
| Operator key compromise | secrets-manager finding; rogue tx | wind-down + key rotation | DR §3.4 |
| Smart contract bug | external report or audit finding | wind-down + v4 migration | DR §3.5 |
| Hasura/Postgres outage | trade-history endpoints 5xx | learning replay deferred until DB recovers; operator continues to run | DR §3.3 |
| S3 outage | backup timer fails; CloudWatch alarm | tolerate up to RPO; investigate; do NOT promote without fresh snapshot if recovering | §2.3 |

