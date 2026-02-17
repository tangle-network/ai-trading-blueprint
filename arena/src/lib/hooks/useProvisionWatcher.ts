import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { decodeAbiParameters, parseAbiParameters, decodeEventLog } from 'viem';
import { provisionsStore, updateProvision } from '~/lib/stores/provisions';
import { tangleJobsAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { publicClient } from '~/lib/contracts/publicClient';

/**
 * Global provision watcher. Mount once near the app root.
 * Uses standalone viem client — works regardless of wallet chain.
 *
 * Stage 1: For `pending_confirmation` provisions — waits for tx receipt.
 *   On success → parse JobSubmitted event from logs → `job_submitted` with callId.
 *   On failure → `failed`.
 *
 * Stage 2: For `job_submitted` provisions — watches JobResultSubmitted event.
 *   On match → decode output as TradingProvisionOutput → `active` with vault/sandbox info.
 */
export function useProvisionWatcher() {
  const provisions = useStore(provisionsStore);
  const watchingTxs = useRef(new Set<string>());

  // Stage 1: Watch pending TX confirmations → extract callId from JobSubmitted
  useEffect(() => {
    for (const prov of provisions) {
      if (prov.phase !== 'pending_confirmation') continue;
      if (!prov.txHash) continue;
      if (watchingTxs.current.has(prov.id)) continue;
      watchingTxs.current.add(prov.id);

      publicClient
        .waitForTransactionReceipt({ hash: prov.txHash })
        .then((receipt) => {
          if (receipt.status !== 'success') {
            updateProvision(prov.id, { phase: 'failed', errorMessage: 'Transaction reverted' });
            return;
          }

          // Parse JobSubmitted event from receipt logs to extract callId
          let callId: number | undefined;
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({
                abi: tangleJobsAbi,
                data: log.data,
                topics: log.topics,
              });
              if (decoded.eventName === 'JobSubmitted') {
                const args = decoded.args as { serviceId: bigint; callId: bigint; jobIndex: number };
                callId = Number(args.callId);
                break;
              }
            } catch {
              // Not a matching event — skip
            }
          }

          updateProvision(prov.id, {
            phase: 'job_submitted',
            callId,
          });
        })
        .catch((err) => {
          updateProvision(prov.id, {
            phase: 'failed',
            errorMessage: err instanceof Error ? err.message.slice(0, 200) : 'Transaction failed',
          });
        })
        .finally(() => {
          watchingTxs.current.delete(prov.id);
        });
    }
  }, [provisions]);

  // Stage 2: Watch contract events for job_submitted/job_processing provisions
  const pendingJobs = provisions.filter(
    (p) => p.phase === 'job_submitted' || p.phase === 'job_processing',
  );

  useEffect(() => {
    if (pendingJobs.length === 0) return;

    // Watch JobResultSubmitted
    const unwatchResult = publicClient.watchContractEvent({
      address: addresses.tangle,
      abi: tangleJobsAbi,
      eventName: 'JobResultSubmitted',
      onLogs(logs) {
        const waiting = provisionsStore.get().filter(
          (p) => p.phase === 'job_submitted' || p.phase === 'job_processing',
        );
        if (waiting.length === 0) return;

        for (const log of logs) {
          const serviceId = log.args.serviceId;
          const callId = log.args.callId;
          const output = log.args.output;
          if (serviceId == null || callId == null) continue;

          for (const prov of waiting) {
            if (prov.callId !== Number(callId)) continue;
            if (prov.serviceId != null && prov.serviceId !== Number(serviceId)) continue;

            if (output) {
              try {
                const decoded = decodeAbiParameters(
                  parseAbiParameters('address, address, string, uint64'),
                  output,
                );
                updateProvision(prov.id, {
                  phase: 'active',
                  vaultAddress: decoded[0] as string,
                  sandboxId: decoded[2] as string,
                  workflowId: Number(decoded[3]),
                });
              } catch {
                updateProvision(prov.id, { phase: 'active' });
              }
            } else {
              updateProvision(prov.id, { phase: 'active' });
            }
          }
        }
      },
    });

    // Also watch JobCompleted as backup
    const unwatchCompleted = publicClient.watchContractEvent({
      address: addresses.tangle,
      abi: tangleJobsAbi,
      eventName: 'JobCompleted',
      onLogs(logs) {
        const waiting = provisionsStore.get().filter(
          (p) => p.phase === 'job_submitted' || p.phase === 'job_processing',
        );
        if (waiting.length === 0) return;

        for (const log of logs) {
          const callId = log.args.callId;
          if (callId == null) continue;

          for (const prov of waiting) {
            if (prov.callId !== Number(callId)) continue;
            if (prov.phase !== 'active') {
              updateProvision(prov.id, { phase: 'active' });
            }
          }
        }
      },
    });

    return () => {
      unwatchResult();
      unwatchCompleted();
    };
  }, [pendingJobs.length]);
}
