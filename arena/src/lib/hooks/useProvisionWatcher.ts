import { useEffect, useRef } from 'react';
import { decodeAbiParameters, decodeEventLog, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { provisionsStore, updateProvision, type TrackedProvision } from '~/lib/stores/provisions';
import { tangleJobsAbi, tradingBlueprintAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { publicClient } from '@tangle/blueprint-ui';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

/**
 * ABI for decoding TradingProvisionOutput struct.
 *
 * CRITICAL: The Rust `abi_encode()` produces TUPLE-WRAPPED encoding:
 *   [32-byte tuple offset][vault_address][share_token][string offset][workflow_id][string data]
 *
 * We MUST decode as a tuple, NOT as flat parameters.
 */
const PROVISION_OUTPUT_ABI = [{
  type: 'tuple' as const,
  components: [
    { name: 'vault_address', type: 'address' as const },
    { name: 'share_token', type: 'address' as const },
    { name: 'sandbox_id', type: 'string' as const },
    { name: 'workflow_id', type: 'uint64' as const },
  ],
}];

/** Decode the output bytes from a TradingProvisionOutput struct. */
function decodeProvisionOutput(output: `0x${string}`) {
  const decoded = decodeAbiParameters(PROVISION_OUTPUT_ABI, output);
  const result = decoded[0] as {
    vault_address: string;
    share_token: string;
    sandbox_id: string;
    workflow_id: bigint;
  };
  return {
    vaultAddress: result.vault_address as string,
    sandboxId: result.sandbox_id as string,
    workflowId: Number(result.workflow_id),
  };
}

/**
 * Global provision watcher. Mount once near the app root.
 *
 * PERF: Uses nanostores `.subscribe()` instead of `useStore()` to avoid
 * re-rendering the host component on every provision update. All effects
 * run via refs and direct store reads, not React state.
 */
export function useProvisionWatcher() {
  const watchingTxs = useRef(new Set<string>());
  const repairRan = useRef(false);
  const eventWatcherActive = useRef(false);
  const unwatchRef = useRef<(() => void) | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stage 1 + 2 + 2.5: Single subscription drives all logic without re-rendering
  useEffect(() => {
    function processProvisions() {
      const provisions = provisionsStore.get();

      // ── Stage 1: Watch pending TX confirmations ──
      for (const prov of provisions) {
        if (prov.phase !== 'pending_confirmation') continue;
        if (!prov.txHash) continue;
        if (watchingTxs.current.has(prov.id)) continue;
        watchingTxs.current.add(prov.id);

        publicClient
          .waitForTransactionReceipt({ hash: prov.txHash })
          .then((receipt: { status: string; logs: Array<{ data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] }> }) => {
            if (receipt.status !== 'success') {
              updateProvision(prov.id, { phase: 'failed', errorMessage: 'Transaction reverted' });
              return;
            }

            let callId: number | undefined;
            let serviceId: number | undefined;
            for (const log of receipt.logs) {
              try {
                const decoded = decodeEventLog({
                  abi: tangleJobsAbi,
                  data: log.data,
                  topics: log.topics,
                });
                if (decoded.eventName === 'JobSubmitted' || decoded.eventName === 'JobCalled') {
                  const args = decoded.args as { serviceId: bigint; callId: bigint };
                  callId = Number(args.callId);
                  serviceId = Number(args.serviceId);
                  break;
                }
              } catch {
                // Not a matching event
              }
            }

            console.log('[provision-watcher] TX confirmed, callId=', callId, 'serviceId=', serviceId);
            updateProvision(prov.id, {
              phase: 'job_submitted',
              callId,
              ...(serviceId != null ? { serviceId } : {}),
            });
          })
          .catch((err: unknown) => {
            updateProvision(prov.id, {
              phase: 'failed',
              errorMessage: err instanceof Error ? err.message.slice(0, 200) : 'Transaction failed',
            });
          })
          .finally(() => {
            watchingTxs.current.delete(prov.id);
          });
      }

      // ── Stage 2: Contract event watchers ──
      const hasPending = provisions.some(
        (p: TrackedProvision) => p.phase === 'job_submitted' || p.phase === 'job_processing',
      );

      if (hasPending && !eventWatcherActive.current) {
        eventWatcherActive.current = true;

        // Historical check first
        (async () => {
          try {
            const logs = await publicClient.getLogs({
              address: addresses.tangle,
              event: {
                type: 'event',
                name: 'JobResultSubmitted',
                inputs: [
                  { name: 'serviceId', type: 'uint64', indexed: true },
                  { name: 'callId', type: 'uint64', indexed: true },
                  { name: 'operator', type: 'address', indexed: true },
                  { name: 'output', type: 'bytes', indexed: false },
                ],
              },
              fromBlock: 0n,
            });
            const waiting = provisionsStore.get().filter(
              (p: TrackedProvision) => p.phase === 'job_submitted' || p.phase === 'job_processing',
            );
            for (const log of logs) {
              const sid = log.args.serviceId;
              const cid = log.args.callId;
              const output = log.args.output;
              if (sid == null || cid == null) continue;
              for (const prov of waiting) {
                if (prov.callId !== Number(cid)) continue;
                if (prov.serviceId != null && prov.serviceId !== Number(sid)) continue;
                applyResultToProvision(prov.id, output, Number(sid), Number(cid));
              }
            }
          } catch (err) {
            console.error('[provision-watcher] Historical check failed:', err);
          }
        })();

        const unwatchResult = publicClient.watchContractEvent({
          address: addresses.tangle,
          abi: tangleJobsAbi,
          eventName: 'JobResultSubmitted',
          onLogs(logs: Array<{ args: { serviceId?: bigint; callId?: bigint; output?: `0x${string}` } }>) {
            const waiting = provisionsStore.get().filter(
              (p: TrackedProvision) => p.phase === 'job_submitted' || p.phase === 'job_processing',
            );
            if (waiting.length === 0) return;
            for (const log of logs) {
              const sid = log.args.serviceId;
              const cid = log.args.callId;
              const output = log.args.output;
              if (sid == null || cid == null) continue;
              for (const prov of waiting) {
                if (prov.callId !== Number(cid)) continue;
                if (prov.serviceId != null && prov.serviceId !== Number(sid)) continue;
                applyResultToProvision(prov.id, output, Number(sid), Number(cid));
              }
            }
          },
        });

        const unwatchCompleted = publicClient.watchContractEvent({
          address: addresses.tangle,
          abi: tangleJobsAbi,
          eventName: 'JobCompleted',
          onLogs(logs: Array<{ args: { callId?: bigint } }>) {
            for (const log of logs) {
              const cid = log.args.callId;
              if (cid == null) continue;
              for (const prov of provisionsStore.get()) {
                if (prov.callId !== Number(cid)) continue;
                if (prov.phase === 'job_submitted') {
                  updateProvision(prov.id, { phase: 'job_processing' });
                }
              }
            }
          },
        });

        unwatchRef.current = () => {
          unwatchResult();
          unwatchCompleted();
          eventWatcherActive.current = false;
        };
      } else if (!hasPending && eventWatcherActive.current) {
        unwatchRef.current?.();
        unwatchRef.current = null;
      }

      // ── Stage 2.5: Operator API polling ──
      const hasSubmitted = provisions.some(
        (p: TrackedProvision) => (p.phase === 'job_submitted' || p.phase === 'job_processing') && p.callId != null,
      );

      if (hasSubmitted && OPERATOR_API_URL && !pollingRef.current) {
        const poll = async () => {
          const submitted = provisionsStore.get().filter(
            (p: TrackedProvision) => (p.phase === 'job_submitted' || p.phase === 'job_processing') && p.callId != null,
          );
          if (submitted.length === 0) {
            // No more pending — stop polling
            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
            return;
          }
          for (const prov of submitted) {
            try {
              const res = await fetch(`${OPERATOR_API_URL}/api/provisions/${prov.callId}`);
              if (!res.ok) continue;
              const progress = await res.json();
              if (progress?.phase) {
                // If operator reports ready (100%), transition to awaiting_secrets
                // This is the fallback path when on-chain event decoding misses
                if (progress.phase === 'ready' && progress.progress_pct === 100) {
                  updateProvision(prov.id, {
                    phase: 'awaiting_secrets',
                    progressPhase: progress.phase,
                    progressDetail: progress.message,
                    ...(progress.sandbox_id ? { sandboxId: progress.sandbox_id } : {}),
                    ...(progress.metadata?.bot_id ? {} : {}),
                    ...(progress.metadata?.service_id ? { serviceId: progress.metadata.service_id } : {}),
                  });
                } else {
                  updateProvision(prov.id, {
                    phase: 'job_processing',
                    progressPhase: progress.phase,
                    progressDetail: progress.message,
                    ...(progress.sandbox_id ? { sandboxId: progress.sandbox_id } : {}),
                  });
                }
              }
            } catch {
              // Operator API unreachable
            }
          }
        };
        poll();
        pollingRef.current = setInterval(poll, 5000); // 5s instead of 2s
      } else if (!hasSubmitted && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }

    // Run once immediately, then subscribe to store changes
    processProvisions();
    const unsub = provisionsStore.subscribe(processProvisions);

    return () => {
      unsub();
      unwatchRef.current?.();
      unwatchRef.current = null;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      eventWatcherActive.current = false;
    };
  }, []); // Runs once — all logic driven by store subscription, not React re-renders

  // Stage 3: One-time repair pass
  useEffect(() => {
    if (repairRan.current) return;
    repairRan.current = true;

    const needsRepair = provisionsStore.get().filter(
      (p: TrackedProvision) =>
        ['active', 'awaiting_secrets'].includes(p.phase) &&
        p.callId != null &&
        (!p.vaultAddress || p.vaultAddress === zeroAddress || p.vaultAddress === '0x0000000000000000000000000000000000000020'),
    );
    if (needsRepair.length === 0) return;

    console.log('[provision-watcher] Repairing', needsRepair.length, 'provisions with missing/bad vault addresses');

    (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: addresses.tangle,
          event: {
            type: 'event',
            name: 'JobResultSubmitted',
            inputs: [
              { name: 'serviceId', type: 'uint64', indexed: true },
              { name: 'callId', type: 'uint64', indexed: true },
              { name: 'operator', type: 'address', indexed: true },
              { name: 'output', type: 'bytes', indexed: false },
            ],
          },
          fromBlock: 0n,
        });

        for (const log of logs) {
          const cid = log.args.callId;
          const output = log.args.output;
          if (cid == null) continue;

          for (const prov of needsRepair) {
            if (prov.callId !== Number(cid)) continue;
            applyResultToProvision(prov.id, output, Number(log.args.serviceId ?? 0), Number(cid));
          }
        }
      } catch (err) {
        console.error('[provision-watcher] Repair failed:', err);
      }
    })();
  }, []);
}

/** Decode output and update a provision with vault/sandbox data.
 *  Since per-bot vaults are created on-chain in _handleProvisionResult,
 *  the operator returns vault_address=0x0. We query botVaults(serviceId, callId)
 *  from the BSM to get the actual vault address.
 */
function applyResultToProvision(provId: string, output: `0x${string}` | undefined, serviceId: number, callId?: number) {
  let sandboxId: string | undefined;
  let workflowId = 0;

  // Decode operator output for sandbox_id and workflow_id
  if (output) {
    try {
      const decoded = decodeProvisionOutput(output);
      sandboxId = decoded.sandboxId;
      workflowId = decoded.workflowId;
    } catch (decodeErr) {
      console.warn('[provision-watcher] Decode failed:', decodeErr);
    }
  }

  // Query the per-bot vault from the BSM contract
  const prov = provisionsStore.get().find((p: TrackedProvision) => p.id === provId);
  const resolvedCallId = callId ?? prov?.callId;

  if (resolvedCallId != null && serviceId > 0 && addresses.tradingBlueprint !== zeroAddress) {
    publicClient.readContract({
      address: addresses.tradingBlueprint,
      abi: tradingBlueprintAbi,
      functionName: 'botVaults',
      args: [BigInt(serviceId), BigInt(resolvedCallId)],
    }).then((vaultAddr: unknown) => {
      const vault = vaultAddr as Address;
      console.log('[provision-watcher] botVaults resolved:', vault, 'for callId=', resolvedCallId);
      updateProvision(provId, {
        phase: workflowId === 0 ? 'awaiting_secrets' : 'active',
        vaultAddress: vault !== zeroAddress ? vault : undefined,
        sandboxId,
        workflowId,
        serviceId,
      });
    }).catch((err: unknown) => {
      console.warn('[provision-watcher] botVaults query failed:', err);
      updateProvision(provId, {
        phase: 'awaiting_secrets',
        sandboxId,
        ...(serviceId > 0 ? { serviceId } : {}),
      });
    });
  } else {
    // No BSM or no callId — update without vault
    updateProvision(provId, {
      phase: workflowId === 0 ? 'awaiting_secrets' : 'active',
      sandboxId,
      ...(serviceId > 0 ? { serviceId } : {}),
    });
  }
}
