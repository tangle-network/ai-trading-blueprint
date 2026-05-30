import { useMemo } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { zeroHash } from 'viem';
import { toast } from 'sonner';
import { Button } from '@tangle-network/blueprint-ui/components';
import { blueprintsBinaryVersionsAbi } from '~/lib/contracts/abis';
import { addresses } from '~/lib/contracts/addresses';

// UpgradePolicy.AUTO — operator tracks the active version without per-version acks.
const POLICY_AUTO = 1;

interface BinaryUpdatesPanelProps {
  // On-chain service id for the bot.
  serviceId: number;
  // Blueprint id the service runs; defaults to nothing and the panel stays idle
  // until resolved (ControlsTab passes the service's blueprintId).
  blueprintId: number | undefined;
}

interface BinaryVersion {
  versionId: bigint;
  sha256Hash: `0x${string}`;
  binaryUri: string;
  attestationHash: `0x${string}`;
  publishedAt: bigint;
  deprecated: boolean;
}

function shortHash(hash: string): string {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function formatPublished(ts: bigint): string {
  const seconds = Number(ts);
  if (!seconds) return 'unknown';
  return new Date(seconds * 1000).toLocaleString();
}

export function BinaryUpdatesPanel({ serviceId, blueprintId }: BinaryUpdatesPanelProps) {
  const { address: operator } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const serviceArg = BigInt(serviceId);
  const blueprintArg = blueprintId != null ? BigInt(blueprintId) : undefined;

  const { data: effective, isLoading: effectiveLoading } = useReadContract({
    address: addresses.tangle,
    abi: blueprintsBinaryVersionsAbi,
    functionName: 'effectiveBinaryVersion',
    args: [serviceArg],
  });

  const { data: versionCount, isLoading: countLoading } = useReadContract({
    address: addresses.tangle,
    abi: blueprintsBinaryVersionsAbi,
    functionName: 'getBinaryVersionCount',
    args: blueprintArg != null ? [blueprintArg] : undefined,
    query: { enabled: blueprintArg != null },
  });

  const latestVersionId = useMemo(() => {
    if (versionCount == null || versionCount === 0n) return undefined;
    return versionCount - 1n;
  }, [versionCount]);

  const { data: latest, isLoading: latestLoading } = useReadContract({
    address: addresses.tangle,
    abi: blueprintsBinaryVersionsAbi,
    functionName: 'getBinaryVersion',
    args: blueprintArg != null && latestVersionId != null ? [blueprintArg, latestVersionId] : undefined,
    query: { enabled: blueprintArg != null && latestVersionId != null },
  });

  const loading = effectiveLoading || countLoading || latestLoading;
  const effectiveVersion = effective as BinaryVersion | undefined;
  const latestVersion = latest as BinaryVersion | undefined;

  const hasUpdate =
    !!effectiveVersion &&
    !!latestVersion &&
    !latestVersion.deprecated &&
    latestVersion.versionId > effectiveVersion.versionId;

  const handleApprove = () => {
    if (!operator) {
      toast.error('Connect your operator wallet to approve updates.');
      return;
    }
    if (!latestVersion) return;
    writeContract(
      {
        address: addresses.tangle,
        abi: blueprintsBinaryVersionsAbi,
        functionName: 'ackBinaryVersion',
        args: [serviceArg, latestVersion.versionId],
      },
      {
        onSuccess: () => toast.success(`Approved binary v${latestVersion.versionId.toString()} — rollout will proceed on next protocol notify.`),
        onError: (err) => toast.error(`Approval failed: ${(err.message || 'Unknown error').slice(0, 120)}`),
      },
    );
  };

  const handleEnableAuto = () => {
    if (!operator) {
      toast.error('Connect your operator wallet to change the upgrade policy.');
      return;
    }
    writeContract(
      {
        address: addresses.tangle,
        abi: blueprintsBinaryVersionsAbi,
        functionName: 'setServiceUpgradePolicy',
        args: [serviceArg, POLICY_AUTO],
      },
      {
        onSuccess: () => toast.success('Auto-updates enabled — this service now tracks the active version.'),
        onError: (err) => toast.error(`Could not enable auto-updates: ${(err.message || 'Unknown error').slice(0, 120)}`),
      },
    );
  };

  return (
    <div className="glass-card rounded-xl p-5">
      <h3 className="font-display font-bold text-lg mb-4">
        <span className="i-ph:download-simple text-base mr-2 align-middle text-arena-elements-textTertiary" />
        Binary Updates
      </h3>

      {loading ? (
        <div className="space-y-2">
          <div className="h-4 w-2/3 rounded bg-arena-elements-borderColor/30 animate-pulse" />
          <div className="h-4 w-1/2 rounded bg-arena-elements-borderColor/30 animate-pulse" />
        </div>
      ) : !effectiveVersion ? (
        <p className="text-sm text-arena-elements-textTertiary">
          No binary version is published for this service yet.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-arena-elements-textTertiary">Running</span>
              <span className="font-data">
                v{effectiveVersion.versionId.toString()}
                <span className="text-arena-elements-textTertiary ml-2">{shortHash(effectiveVersion.sha256Hash)}</span>
              </span>
            </div>
            {latestVersion && (
              <div className="flex justify-between gap-4">
                <span className="text-arena-elements-textTertiary">Latest published</span>
                <span className="font-data">
                  v{latestVersion.versionId.toString()}
                  <span className="text-arena-elements-textTertiary ml-2">{shortHash(latestVersion.sha256Hash)}</span>
                </span>
              </div>
            )}
          </div>

          {hasUpdate && latestVersion ? (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
                <span className="i-ph:sparkle text-base" />
                Update available — v{latestVersion.versionId.toString()}
              </div>
              <dl className="space-y-1.5 text-xs text-amber-800/90 dark:text-amber-200/90">
                <div className="flex justify-between gap-4">
                  <dt className="text-arena-elements-textTertiary">sha256</dt>
                  <dd className="font-data">{shortHash(latestVersion.sha256Hash)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-arena-elements-textTertiary">Attestation</dt>
                  <dd className="font-data">
                    {latestVersion.attestationHash && latestVersion.attestationHash !== zeroHash
                      ? `present (${shortHash(latestVersion.attestationHash)})`
                      : 'none'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-arena-elements-textTertiary">Published</dt>
                  <dd className="font-data">{formatPublished(latestVersion.publishedAt)}</dd>
                </div>
              </dl>
              {latestVersion.binaryUri && (
                <p className="text-xs text-amber-800/80 dark:text-amber-200/80 break-all font-data">
                  {latestVersion.binaryUri}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" disabled={isPending || !operator} onClick={handleApprove}>
                  <span className="i-ph:check-circle text-xs mr-1" />
                  {isPending ? 'Submitting…' : 'Approve & roll out'}
                </Button>
                <Button size="sm" variant="outline" disabled={isPending || !operator} onClick={handleEnableAuto}>
                  <span className="i-ph:lightning text-xs mr-1" />
                  Enable auto-updates
                </Button>
              </div>
              {!operator && (
                <p className="text-xs text-arena-elements-textTertiary">
                  Connect your operator wallet to approve.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <span className="i-ph:check-circle text-base" />
              Up to date — running the latest published binary.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
