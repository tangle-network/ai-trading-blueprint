import { useState, useEffect } from 'react';
import type { Address } from 'viem';
import { tangleOperatorsAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';
import { publicClient } from '~/lib/contracts/publicClient';

export interface DiscoveredOperator {
  address: Address;
  ecdsaPublicKey: string;
  rpcAddress: string;
}

export function useOperators(blueprintId: bigint) {
  const [operators, setOperators] = useState<DiscoveredOperator[]>([]);
  const [operatorCount, setOperatorCount] = useState<bigint>(0n);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function discover() {
      setIsLoading(true);
      setError(null);

      try {
        // Step 1: Check operator count
        const count = await publicClient.readContract({
          address: addresses.tangle,
          abi: tangleOperatorsAbi,
          functionName: 'blueprintOperatorCount',
          args: [blueprintId],
        });

        if (cancelled) return;
        setOperatorCount(count);
        console.log(`[useOperators] blueprintOperatorCount(${blueprintId}) = ${count}`);

        if (count === 0n) {
          setOperators([]);
          setIsLoading(false);
          return;
        }

        // Step 2: Fetch OperatorRegistered logs
        const registeredLogs = await publicClient.getLogs({
          address: addresses.tangle,
          event: {
            type: 'event',
            name: 'OperatorRegistered',
            inputs: [
              { name: 'blueprintId', type: 'uint64', indexed: true },
              { name: 'operator', type: 'address', indexed: true },
              { name: 'ecdsaPublicKey', type: 'bytes', indexed: false },
              { name: 'rpcAddress', type: 'string', indexed: false },
            ],
          },
          args: { blueprintId },
          fromBlock: 0n,
          toBlock: 'latest',
        });

        if (cancelled) return;
        console.log(`[useOperators] Found ${registeredLogs.length} OperatorRegistered logs`);

        // Deduplicate by address (keep latest)
        const byAddress = new Map<Address, DiscoveredOperator>();
        for (const log of registeredLogs) {
          const addr = log.args.operator;
          if (!addr) continue;
          byAddress.set(addr, {
            address: addr,
            ecdsaPublicKey: log.args.ecdsaPublicKey ?? '0x',
            rpcAddress: log.args.rpcAddress ?? '',
          });
        }

        // Step 3: Verify each is still registered and fetch current preferences
        // (events may have stale RPC addresses if updateOperatorPreferences was called)
        const candidates = Array.from(byAddress.values());
        if (candidates.length === 0) {
          setOperators([]);
          setIsLoading(false);
          return;
        }

        const [registrationResults, preferencesResults] = await Promise.all([
          publicClient.multicall({
            contracts: candidates.map((op) => ({
              address: addresses.tangle,
              abi: tangleOperatorsAbi,
              functionName: 'isOperatorRegistered' as const,
              args: [blueprintId, op.address],
            })),
          }),
          publicClient.multicall({
            contracts: candidates.map((op) => ({
              address: addresses.tangle,
              abi: tangleOperatorsAbi,
              functionName: 'getOperatorPreferences' as const,
              args: [blueprintId, op.address],
            })),
          }),
        ]);

        if (cancelled) return;

        const active = candidates
          .filter((_, i) => registrationResults[i]?.result === true)
          .map((op, i) => {
            const prefs = preferencesResults[i];
            if (prefs?.status === 'success' && prefs.result != null) {
              // getOperatorPreferences returns a struct { ecdsaPublicKey: bytes, rpcAddress: string }
              // Viem may return as object or array depending on ABI shape
              const result = prefs.result as Record<string, unknown>;
              let ecdsaKey: string;
              let rpcAddr: string;
              if (Array.isArray(result)) {
                ecdsaKey = String(result[0] ?? '');
                rpcAddr = String(result[1] ?? '');
              } else {
                ecdsaKey = String(result.ecdsaPublicKey ?? '');
                rpcAddr = String(result.rpcAddress ?? '');
              }
              return {
                ...op,
                ecdsaPublicKey: ecdsaKey || op.ecdsaPublicKey,
                rpcAddress: rpcAddr || op.rpcAddress,
              };
            }
            return op;
          });
        console.log(`[useOperators] ${active.length} active operators after verification`);
        setOperators(active);
      } catch (err) {
        if (!cancelled) {
          console.error('[useOperators] Discovery failed:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    discover();
    return () => { cancelled = true; };
  }, [blueprintId]);

  return {
    operators,
    isLoading,
    error,
    operatorCount,
  };
}
