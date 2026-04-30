import { useEffect, useState } from 'react';
import { decodeEventLog, formatUnits } from 'viem';
import type { Address, Log } from 'viem';
import { useAccount } from 'wagmi';
import { Skeleton } from '@tangle-network/blueprint-ui/components';
import { tradingVaultAbi } from '~/lib/contracts/abis';
import { getChainPublicClient } from '~/lib/contracts/chainClients';
import { timeAgo, truncateAddress } from '~/lib/format';

type VaultActivityType = 'deposit' | 'withdraw' | 'redeem_in_kind';

interface VaultActivityItem {
  id: string;
  type: VaultActivityType;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp?: number;
  primaryAddress: Address;
  secondaryAddress?: Address;
  assets?: bigint;
  shares: bigint;
}

interface VaultActivityProps {
  vaultAddress: Address;
  assetToken?: Address;
  targetChainId: number;
  assetSymbol: string;
  assetDecimals: number;
  shareDecimals: number;
  refreshKey: number;
}

const RECENT_BLOCK_WINDOW = 2_000n;
const LOCAL_RECENT_BLOCK_WINDOW = 500n;
const CHUNK_SIZE = 10n;
const LOCAL_BOOTSTRAP_SCAN_BLOCKS = 500n;
const MAX_ACTIVITY_ITEMS = 20;
const LOCAL_CHAIN_IDS = new Set([31337, 31338, 31339]);
const CHUNK_CONCURRENCY = 16;

const erc20TransferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

function isSameAddress(a: string | undefined, b: string | undefined) {
  return a != null && b != null && a.toLowerCase() === b.toLowerCase();
}

function eventToActivity(log: Log): VaultActivityItem | null {
  try {
    const decoded = decodeEventLog({
      abi: tradingVaultAbi,
      data: log.data,
      topics: log.topics,
    });

    if (!log.blockNumber || !log.transactionHash) return null;

    const base = {
      blockNumber: log.blockNumber,
      logIndex: log.logIndex ?? 0,
      txHash: log.transactionHash,
      id: `${log.transactionHash}-${log.logIndex ?? 0}`,
      timestamp: timestampFromLog(log),
    };

    if (decoded.eventName === 'Deposit') {
      const args = decoded.args as unknown as {
        sender: Address;
        owner: Address;
        assets: bigint;
        shares: bigint;
      };
      return {
        ...base,
        type: 'deposit',
        primaryAddress: args.owner,
        secondaryAddress: args.sender,
        assets: args.assets,
        shares: args.shares,
      };
    }

    if (decoded.eventName === 'Withdraw') {
      const args = decoded.args as unknown as {
        sender: Address;
        receiver: Address;
        owner: Address;
        assets: bigint;
        shares: bigint;
      };
      return {
        ...base,
        type: 'withdraw',
        primaryAddress: args.owner,
        secondaryAddress: args.receiver,
        assets: args.assets,
        shares: args.shares,
      };
    }

    if (decoded.eventName === 'InKindRedeemed') {
      const args = decoded.args as unknown as {
        caller: Address;
        receiver: Address;
        owner: Address;
        shares: bigint;
      };
      return {
        ...base,
        type: 'redeem_in_kind',
        primaryAddress: args.owner,
        secondaryAddress: args.receiver,
        shares: args.shares,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function timestampFromLog(log: Log): number | undefined {
  const raw = (log as any).blockTimestamp;
  if (typeof raw === 'bigint') return Number(raw) * 1000;
  if (typeof raw === 'number') return raw < 1_000_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const seconds = raw.startsWith('0x') ? Number(BigInt(raw)) : Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  return undefined;
}

async function getLogsChunked(
  client: ReturnType<typeof getChainPublicClient>,
  vaultAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  const logs: Log[] = [];

  for (let from = fromBlock; from <= toBlock; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n > toBlock ? toBlock : from + CHUNK_SIZE - 1n;
    ranges.push({ from, to });
  }

  for (let i = 0; i < ranges.length; i += CHUNK_CONCURRENCY) {
    const batch = ranges.slice(i, i + CHUNK_CONCURRENCY);
    const chunks = await Promise.all(batch.map(({ from, to }) =>
      client.getLogs({
        address: vaultAddress,
        fromBlock: from,
        toBlock: to,
      }).catch(() => [] as Log[]),
    ));
    logs.push(...chunks.flat());
  }

  return logs;
}

async function getVaultLogs(
  client: ReturnType<typeof getChainPublicClient>,
  vaultAddress: Address,
  targetChainId: number,
) {
  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock > RECENT_BLOCK_WINDOW ? currentBlock - RECENT_BLOCK_WINDOW : 0n;

  if (LOCAL_CHAIN_IDS.has(targetChainId)) {
    const localRecentFrom = currentBlock > LOCAL_RECENT_BLOCK_WINDOW ? currentBlock - LOCAL_RECENT_BLOCK_WINDOW : 0n;
    const localRecentLogs = await getLogsChunked(client, vaultAddress, localRecentFrom, currentBlock);
    if (localRecentLogs.length > 0) return localRecentLogs;

    const bootstrapTo = currentBlock < LOCAL_BOOTSTRAP_SCAN_BLOCKS ? currentBlock : LOCAL_BOOTSTRAP_SCAN_BLOCKS;
    const bootstrapLogs = await getLogsChunked(client, vaultAddress, 0n, bootstrapTo);
    if (bootstrapLogs.length > 0) return bootstrapLogs;
  }

  try {
    const logs = await client.getLogs({
      address: vaultAddress,
      fromBlock,
      toBlock: currentBlock,
    });
    if (logs.length > 0 || fromBlock === 0n) return logs;
  } catch {
    const logs = await getLogsChunked(client, vaultAddress, fromBlock, currentBlock);
    if (logs.length > 0 || fromBlock === 0n) return logs;
  }

  // Local fork providers can expose freshly mined dev blocks separately from the
  // upstream fork height, so scan the bootstrapped low block range as a fallback.
  const bootstrapTo = currentBlock < LOCAL_BOOTSTRAP_SCAN_BLOCKS ? currentBlock : LOCAL_BOOTSTRAP_SCAN_BLOCKS;
  return getLogsChunked(client, vaultAddress, 0n, bootstrapTo);
}

async function attachTimestamps(
  client: ReturnType<typeof getChainPublicClient>,
  items: VaultActivityItem[],
  targetChainId: number,
) {
  if (LOCAL_CHAIN_IDS.has(targetChainId)) return items;

  const blockNumbers = [...new Set(
    items
      .filter((item) => item.timestamp == null)
      .map((item) => item.blockNumber.toString()),
  )];
  const timestamps = new Map<string, number>();

  await Promise.all(blockNumbers.map(async (blockNumber) => {
    try {
      const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
      timestamps.set(blockNumber, Number(block.timestamp) * 1000);
    } catch {
      // Block timestamps are nice-to-have; block numbers still identify order.
    }
  }));

  return items.map((item) => ({
    ...item,
    timestamp: item.timestamp ?? timestamps.get(item.blockNumber.toString()),
  }));
}

async function attachRedeemAssetAmounts(
  client: ReturnType<typeof getChainPublicClient>,
  vaultAddress: Address,
  assetToken: Address | undefined,
  items: VaultActivityItem[],
) {
  if (!assetToken) return items;

  const redeemItems = items.filter((item) => item.type === 'redeem_in_kind' && item.assets == null);
  if (redeemItems.length === 0) return items;

  const amounts = new Map<string, bigint>();

  await Promise.all(redeemItems.map(async (item) => {
    if (!item.secondaryAddress) return;

    try {
      const receipt = await client.getTransactionReceipt({ hash: item.txHash });
      let received = 0n;

      for (const log of receipt.logs) {
        if (!isSameAddress(log.address, assetToken)) continue;

        try {
          const decoded = decodeEventLog({
            abi: [erc20TransferEvent],
            data: log.data,
            topics: log.topics,
          });
          const args = decoded.args as unknown as {
            from: Address;
            to: Address;
            value: bigint;
          };

          if (isSameAddress(args.from, vaultAddress) && isSameAddress(args.to, item.secondaryAddress)) {
            received += args.value;
          }
        } catch {
          // Ignore unrelated logs from the same receipt.
        }
      }

      if (received > 0n) amounts.set(item.id, received);
    } catch {
      // Receipt-derived asset amounts are best effort for basket withdrawals.
    }
  }));

  if (amounts.size === 0) return items;

  return items.map((item) => ({
    ...item,
    assets: amounts.get(item.id) ?? item.assets,
  }));
}

function formatAmount(value: bigint, decimals: number) {
  const amount = Number(formatUnits(value, decimals));
  if (!Number.isFinite(amount)) return formatUnits(value, decimals);
  if (amount === 0) return '0';
  if (amount >= 1000) return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (amount >= 1) return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return amount.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function activityCopy(type: VaultActivityType) {
  switch (type) {
    case 'deposit':
      return {
        label: 'Deposit',
        icon: 'i-ph:arrow-down-right',
        color: 'text-arena-elements-icon-success',
        shareSign: '+',
        assetSuffix: 'deposited',
      };
    case 'withdraw':
      return {
        label: 'Withdraw',
        icon: 'i-ph:arrow-up-right',
        color: 'text-crimson-600 dark:text-crimson-400',
        shareSign: '-',
        assetSuffix: 'received',
      };
    case 'redeem_in_kind':
      return {
        label: 'Basket withdrawal',
        icon: 'i-ph:basket',
        color: 'text-crimson-600 dark:text-crimson-400',
        shareSign: '-',
        assetSuffix: 'received',
      };
  }
}

function actorText(item: VaultActivityItem, currentUser: Address | undefined) {
  const actor = isSameAddress(item.primaryAddress, currentUser)
    ? 'You'
    : truncateAddress(item.primaryAddress);

  switch (item.type) {
    case 'deposit':
      return `${actor} deposited`;
    case 'withdraw':
      return `${actor} withdrew`;
    case 'redeem_in_kind':
      return `${actor} withdrew a basket`;
  }
}

export function VaultActivity({
  vaultAddress,
  assetToken,
  targetChainId,
  assetSymbol,
  assetDecimals,
  shareDecimals,
  refreshKey,
}: VaultActivityProps) {
  const { address: currentUser } = useAccount();
  const [items, setItems] = useState<VaultActivityItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchActivity() {
      setIsLoading(true);
      setError(null);

      try {
        const client = getChainPublicClient(targetChainId);
        const logs = await getVaultLogs(client, vaultAddress, targetChainId);
        const decoded = logs
          .map(eventToActivity)
          .filter((item): item is VaultActivityItem => item != null)
          .sort((a, b) => {
            const blockDiff = Number(b.blockNumber - a.blockNumber);
            return blockDiff !== 0 ? blockDiff : b.logIndex - a.logIndex;
          })
          .slice(0, MAX_ACTIVITY_ITEMS);

        const withAssets = await attachRedeemAssetAmounts(client, vaultAddress, assetToken, decoded);
        const withTimestamps = await attachTimestamps(client, withAssets, targetChainId);
        if (!cancelled) setItems(withTimestamps);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load vault activity');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void fetchActivity();

    return () => {
      cancelled = true;
    };
  }, [vaultAddress, assetToken, targetChainId, refreshKey]);

  return (
    <div className="glass-card rounded-xl p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="font-display font-bold text-lg">Recent Activity</h2>
        {items.length > 0 && (
          <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
            {items.length} latest
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : error ? (
        <div className="py-8 text-center">
          <div className="i-ph:warning-circle text-2xl text-amber-600 dark:text-amber-400 mb-3 mx-auto" />
          <p className="text-sm text-arena-elements-textSecondary">
            Could not load vault activity.
          </p>
          <p className="text-xs text-arena-elements-textTertiary mt-1 max-w-xl mx-auto">
            {error}
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center">
          <div className="i-ph:clock-counter-clockwise text-2xl text-arena-elements-textTertiary mb-3 mx-auto" />
          <p className="text-sm text-arena-elements-textSecondary">
            No deposits or withdrawals found for this vault yet.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-arena-elements-dividerColor/60">
          {items.map((item) => {
            const copy = activityCopy(item.type);
            const shareDelta = `${copy.shareSign}${formatAmount(item.shares, shareDecimals)} shares`;
            const assetDetail = item.assets != null
              ? `${formatAmount(item.assets, assetDecimals)} ${assetSymbol} ${copy.assetSuffix}`
              : 'Basket received';

            return (
              <div key={item.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                <div className={`w-9 h-9 rounded-lg bg-arena-elements-background-depth-2 border border-arena-elements-borderColor flex items-center justify-center shrink-0 ${copy.color}`}>
                  <div className={`${copy.icon} text-base`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-display font-semibold text-arena-elements-textPrimary">
                      {copy.label}
                    </span>
                  </div>
                  <div className="text-sm text-arena-elements-textSecondary mt-0.5 truncate">
                    {actorText(item, currentUser)}
                  </div>
                  <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5 truncate">
                    Block {item.blockNumber.toString()} · Tx {item.txHash.slice(0, 10)}...{item.txHash.slice(-6)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-sm font-data font-semibold ${copy.color}`}>
                    {shareDelta}
                  </div>
                  <div className="text-xs font-data font-semibold text-arena-elements-textPrimary mt-0.5">
                    {assetDetail}
                  </div>
                  <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
                    {item.timestamp ? timeAgo(item.timestamp) : 'confirmed'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
