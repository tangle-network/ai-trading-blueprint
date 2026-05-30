# Blueprint Upgrade CD Loop

How a new blueprint binary goes from a git tag to running on operators' nodes —
with an optional manual approval gate, fully on-chain and verifiable.

**Most of this was already built.** The on-chain version registry, the operator
manager's watcher + swap pipeline, and the publish script all existed; this loop
only wired the two missing seams (a release→publish trigger and a dApp approve
surface). Nothing in the manager was rebuilt.

## The loop

```
release tag (vX) ──▶ blueprint release CI builds binaries (x86_64 + aarch64)
        │
        └─ publish-onchain job ──gh workflow run──▶ tnt-core publish-blueprint-binary.yml
                                                      │ (owner key lives only in tnt-core)
                                                      ▼
                              Tangle.publishBinaryVersion(sha256, uri, attestation)
                              Tangle.setActiveBinaryVersion(blueprintId, versionId)
                                                      │
                       BinaryVersionPublished / BinaryActiveVersionChanged events
                                                      │
        ┌─────────────────────────────────────────────┴───────────────────────────┐
        ▼                                                                           ▼
  arena dApp "Binary Updates" panel                              operator manager UpgradeWatcher
  shows effective vs latest version                             re-resolves effectiveBinaryVersion(serviceId)
  operator clicks:                                              on each protocol block-notify
   • Approve & roll out → ackBinaryVersion(serviceId, ver) ───▶ effective version changes
   • Enable auto-updates → setServiceUpgradePolicy(.., AUTO) ─▶ swap pipeline runs:
                                                                download → sha256 verify →
                                                                attestation → drain → respawn ✅
```

## Upgrade policies (per service, on-chain)

- **APPROVE** (default) — the manager runs the genesis version until the operator
  `ackBinaryVersion`s a new one. The dApp "Approve & roll out" button is this ack.
- **AUTO** — the service tracks the blueprint's active version; new publishes roll
  out with no click. The dApp "Enable auto-updates" button sets this.
- **MANUAL** — pinned; operator pins/whitelists locally via the manager RPC.

## The pieces and where they live

| Piece | Where | Status |
|---|---|---|
| Version registry + policies + ack | `tnt-core/src/core/BlueprintsBinaryVersions.sol` | shipped |
| Publish script (sha256 + URI + publish/active) | `tnt-core/deploy/publish-binary.sh` | shipped |
| Reusable publish workflow (`workflow_call`) | `tnt-core/.github/workflows/publish-blueprint-binary.yml` | this loop |
| Release→publish trigger | `ai-trading-blueprint/.github/workflows/release.yml` (`publish-onchain` job) | this loop |
| Operator approve UI | `ai-trading-blueprint/arena` `BinaryUpdatesPanel` (in `ControlsTab`) | this loop |
| Watcher + swap (download→sha256→attestation→drain→respawn) | blueprint manager `crates/manager/src/upgrade/` | shipped |
| Operator-local pin/whitelist + status RPC | manager `GET /upgrades/{pending,history,authz}` | shipped |

## Operator setup (one-time)

Add repo secret `TNT_CORE_PUBLISH_TOKEN` to the blueprint repo — a GitHub PAT with
`actions:write` + `contents:read` on `tangle-network/tnt-core`. The blueprint
**owner key** (`BLUEPRINT_OWNER_KEY`) stays only in tnt-core secrets; the blueprint
repo only holds the token that *triggers* the publish.

## End-to-end test

1. Tag a release in the blueprint repo (`git tag vX.Y.Z && git push --tags`).
2. `publish-onchain` runs once after the build matrix; confirm it dispatched tnt-core
   (`gh run list --repo tangle-network/tnt-core --workflow publish-blueprint-binary.yml`).
3. The new version appears on-chain; the arena "Binary Updates" panel surfaces it.
4. Approve (or have AUTO set); the operator's manager swaps to the new binary.
