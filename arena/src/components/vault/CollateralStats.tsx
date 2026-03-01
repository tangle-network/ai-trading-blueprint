import { m } from 'framer-motion';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { AnimatedNumber } from '~/components/motion/AnimatedNumber';
import { Skeleton } from '@tangle/blueprint-ui/components';
import { publicClient } from '@tangle/blueprint-ui';
import { tradingVaultAbi } from '~/lib/contracts/abis';
import { useEffect, useState } from 'react';

interface CollateralStatsProps {
  vaultAddress: Address;
  totalOutstandingCollateral?: bigint;
  maxCollateralBps?: number;
  availableCollateral?: bigint;
  assetDecimals: number;
  assetSymbol: string;
  tvl?: number;
  isLoading: boolean;
}

interface CollateralEvent {
  type: 'released' | 'returned' | 'written_down';
  amount: number;
  blockNumber: bigint;
  operator: string;
}

export function CollateralStats({
  vaultAddress,
  totalOutstandingCollateral,
  maxCollateralBps,
  availableCollateral,
  assetDecimals,
  assetSymbol,
  tvl,
  isLoading,
}: CollateralStatsProps) {
  const [events, setEvents] = useState<CollateralEvent[]>([]);

  const enabled = maxCollateralBps != null && maxCollateralBps > 0;
  const capPct = maxCollateralBps != null ? (maxCollateralBps / 100) : 0;
  const outstandingFormatted = totalOutstandingCollateral != null
    ? Number(formatUnits(totalOutstandingCollateral, assetDecimals))
    : undefined;
  const availableFormatted = availableCollateral != null
    ? Number(formatUnits(availableCollateral, assetDecimals))
    : undefined;
  const outstandingPct = tvl && outstandingFormatted ? (outstandingFormatted / tvl) * 100 : 0;

  // Fetch recent collateral events
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function fetchEvents() {
      try {
        // Use a recent block window to avoid scanning full chain history
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > 10000n ? currentBlock - 10000n : 0n;

        const [released, returned, writtenDown] = await Promise.all([
          publicClient.getLogs({
            address: vaultAddress,
            event: {
              type: 'event',
              name: 'CollateralReleased',
              inputs: [
                { name: 'operator', type: 'address', indexed: true },
                { name: 'amount', type: 'uint256', indexed: false },
                { name: 'recipient', type: 'address', indexed: true },
                { name: 'intentHash', type: 'bytes32', indexed: true },
              ],
            },
            fromBlock,
          }),
          publicClient.getLogs({
            address: vaultAddress,
            event: {
              type: 'event',
              name: 'CollateralReturned',
              inputs: [
                { name: 'operator', type: 'address', indexed: true },
                { name: 'amount', type: 'uint256', indexed: false },
                { name: 'credited', type: 'uint256', indexed: false },
              ],
            },
            fromBlock,
          }),
          publicClient.getLogs({
            address: vaultAddress,
            event: {
              type: 'event',
              name: 'CollateralWrittenDown',
              inputs: [
                { name: 'operator', type: 'address', indexed: true },
                { name: 'amount', type: 'uint256', indexed: false },
              ],
            },
            fromBlock,
          }),
        ]);

        if (cancelled) return;

        const all: CollateralEvent[] = [
          ...released.map((log) => ({
            type: 'released' as const,
            amount: Number(formatUnits((log.args as any).amount ?? 0n, assetDecimals)),
            blockNumber: log.blockNumber,
            operator: ((log.args as any).operator ?? '').toString().slice(0, 10) + '...',
          })),
          ...returned.map((log) => ({
            type: 'returned' as const,
            amount: Number(formatUnits((log.args as any).amount ?? 0n, assetDecimals)),
            blockNumber: log.blockNumber,
            operator: ((log.args as any).operator ?? '').toString().slice(0, 10) + '...',
          })),
          ...writtenDown.map((log) => ({
            type: 'written_down' as const,
            amount: Number(formatUnits((log.args as any).amount ?? 0n, assetDecimals)),
            blockNumber: log.blockNumber,
            operator: ((log.args as any).operator ?? '').toString().slice(0, 10) + '...',
          })),
        ];

        all.sort((a, b) => Number(b.blockNumber - a.blockNumber));
        setEvents(all.slice(0, 5));
      } catch {
        // Events are non-critical — vault may be on a chain where getLogs is limited
      }
    }

    fetchEvents();
    return () => { cancelled = true; };
  }, [vaultAddress, enabled, assetDecimals]);

  if (!enabled) {
    return (
      <m.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="glass-card rounded-xl p-5 mb-6"
      >
        <div className="flex items-center gap-2 mb-1">
          <div className="i-ph:lock-key text-base text-arena-elements-textTertiary" />
          <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
            CLOB Collateral
          </span>
        </div>
        <p className="text-sm text-arena-elements-textTertiary">
          Not enabled for this vault.
        </p>
      </m.div>
    );
  }

  const stats = [
    {
      label: 'Outstanding',
      value: outstandingFormatted,
      suffix: ` ${assetSymbol}`,
      subtext: outstandingPct > 0 ? `${outstandingPct.toFixed(1)}% of NAV` : undefined,
      decimals: 2,
      icon: 'i-ph:arrow-up-right',
      color: outstandingFormatted && outstandingFormatted > 0 ? 'text-amber-600 dark:text-amber-400' : '',
    },
    {
      label: 'Available',
      value: availableFormatted,
      suffix: ` ${assetSymbol}`,
      subtext: undefined,
      decimals: 2,
      icon: 'i-ph:arrow-down-left',
      color: '',
    },
    {
      label: 'Cap',
      value: capPct,
      suffix: '%',
      subtext: undefined,
      decimals: 1,
      icon: 'i-ph:gauge',
      color: '',
    },
  ];

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="i-ph:lock-key text-base text-violet-700 dark:text-violet-400" />
        <span className="text-sm font-display font-semibold">CLOB Collateral</span>
      </div>
      <div className="grid sm:grid-cols-3 gap-4 mb-4">
        {stats.map((stat, i) => (
          <m.div
            key={stat.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.4 }}
            className="glass-card rounded-xl p-4"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <div className={`${stat.icon} text-sm text-arena-elements-textTertiary`} />
              <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
                {stat.label}
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : stat.value != null ? (
              <>
                <div className={`text-xl font-display font-bold ${stat.color}`}>
                  <AnimatedNumber
                    value={stat.value}
                    suffix={stat.suffix}
                    decimals={stat.decimals}
                  />
                </div>
                {stat.subtext && (
                  <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
                    {stat.subtext}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xl font-display font-bold text-arena-elements-textTertiary">--</div>
            )}
          </m.div>
        ))}
      </div>

      {/* Recent collateral activity */}
      {events.length > 0 && (
        <div className="glass-card rounded-xl p-4">
          <div className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2">
            Recent Activity
          </div>
          <div className="space-y-1.5">
            {events.map((evt, i) => (
              <div key={i} className="flex items-center justify-between text-xs font-data">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    evt.type === 'released' ? 'bg-amber-400'
                    : evt.type === 'written_down' ? 'bg-crimson-400'
                    : 'bg-arena-elements-icon-success'
                  }`} />
                  <span className="text-arena-elements-textSecondary">
                    {evt.type === 'released' ? 'Released' : evt.type === 'written_down' ? 'Written Down' : 'Returned'}
                  </span>
                  <span className="text-arena-elements-textTertiary">{evt.operator}</span>
                </div>
                <span className={
                  evt.type === 'released' ? 'text-amber-600 dark:text-amber-400'
                  : evt.type === 'written_down' ? 'text-crimson-600 dark:text-crimson-400'
                  : 'text-arena-elements-icon-success'
                }>
                  {evt.type === 'returned' ? '+' : '-'}{evt.amount.toFixed(2)} {assetSymbol}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
