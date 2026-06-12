import { useState, useCallback, type RefObject } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'sonner';
import { cn, txListStore, pendingCount, clearTxs, type TrackedTx } from '@tangle-network/blueprint-ui';
import { useDropdownMenu } from '@tangle-network/sandbox-ui/hooks';
import { copyText, timeAgo } from '@tangle-network/sandbox-ui/utils';
import { useTxWatcher } from '~/lib/hooks/useTxWatcher';
import { useProvisionWatcher } from '~/lib/hooks/useProvisionWatcher';
import { getExplorerTxLink } from '~/lib/utils/explorerLinks';

const gasFormatter = new Intl.NumberFormat('en-US');

function StatusIcon({ status }: { status: TrackedTx['status'] }) {
  if (status === 'pending') {
    return <div className="w-4 h-4 rounded-full border-2 border-violet-500/40 border-t-violet-400 animate-spin shrink-0" />;
  }
  if (status === 'confirmed') {
    return <div className="i-ph:check-circle-fill text-base text-arena-elements-icon-success shrink-0" />;
  }
  return <div className="i-ph:x-circle-fill text-base text-arena-elements-icon-error shrink-0" />;
}

function TxRow({ tx }: { tx: TrackedTx }) {
  const [expanded, setExpanded] = useState(false);
  const explorer = getExplorerTxLink(tx.chainId, tx.hash);

  const copyHash = useCallback(async () => {
    await copyText(tx.hash);
    toast.success('Tx hash copied');
  }, [tx.hash]);

  return (
    <div className="border-b border-arena-elements-dividerColor/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-arena-elements-item-backgroundHover transition-colors text-left"
      >
        <StatusIcon status={tx.status} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-display font-medium text-arena-elements-textPrimary truncate">
            {tx.label}
          </div>
          <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
            {tx.hash.slice(0, 10)}…{tx.hash.slice(-6)}
            <span className="ml-2">{timeAgo(tx.timestamp)}</span>
          </div>
        </div>
        <div className={`i-ph:caret-down text-xs text-arena-elements-textTertiary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-data text-arena-elements-textTertiary w-16 shrink-0">Hash</span>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <button
                type="button"
                onClick={copyHash}
                className="group flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-data text-arena-elements-textSecondary transition-colors hover:text-violet-700 dark:hover:text-violet-400"
                title={tx.hash}
              >
                <span className="truncate">{tx.hash}</span>
                <div className="i-ph:copy text-xs opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
              {explorer && (
                <a
                  href={explorer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  title={`${tx.hash} · ${explorer.label}`}
                  aria-label={`View transaction on ${explorer.label}`}
                >
                  <span className="i-ph:arrow-square-out text-xs" aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-data text-arena-elements-textTertiary w-16 shrink-0">Status</span>
            <span className={`text-xs font-data font-semibold uppercase tracking-wider ${
              tx.status === 'confirmed' ? 'text-arena-elements-icon-success' :
              tx.status === 'failed' ? 'text-arena-elements-icon-error' :
              'text-amber-700 dark:text-amber-400'
            }`}>
              {tx.status}
            </span>
          </div>
          {tx.blockNumber != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-data text-arena-elements-textTertiary w-16 shrink-0">Block</span>
              <span className="text-xs font-data text-arena-elements-textSecondary">{tx.blockNumber.toString()}</span>
            </div>
          )}
          {tx.gasUsed != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-data text-arena-elements-textTertiary w-16 shrink-0">Gas</span>
              <span className="text-xs font-data text-arena-elements-textSecondary">{gasFormatter.format(Number(tx.gasUsed))}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs font-data text-arena-elements-textTertiary w-16 shrink-0">Chain</span>
            <span className="text-xs font-data text-arena-elements-textSecondary">{tx.chainId}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function TxDropdown({
  align = 'end',
  side = 'down',
  compact = true,
}: {
  align?: 'start' | 'end';
  side?: 'up' | 'down';
  compact?: boolean;
} = {}) {
  useTxWatcher();
  useProvisionWatcher();

  const { open, ref, toggle, close } = useDropdownMenu();
  const menuRef = ref as RefObject<HTMLDivElement>;
  const txs = useStore(txListStore);
  const pending = useStore(pendingCount);

  return (
    <div ref={menuRef} className="relative inline-flex h-full w-full items-center justify-center">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'relative inline-flex items-center justify-center border border-arena-elements-dividerColor/70 bg-arena-elements-bg-depth-3 text-arena-elements-textSecondary transition-[background-color,border-color,color,opacity] duration-150 hover:border-[#50d2c1]/35 hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
          compact ? 'h-9 w-9 p-0' : 'h-10 w-full gap-2 px-2 font-display text-sm font-medium',
        )}
        aria-label="Transaction history"
        aria-expanded={open}
      >
        <div className="i-ph:receipt pointer-events-none text-base leading-none text-arena-elements-textSecondary" />
        {!compact && <span className="min-w-0 truncate">Transactions</span>}
        {pending > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center px-1 rounded-full bg-violet-600 text-white text-[10px] font-data font-bold animate-pulse">
            {pending}
          </span>
        )}
        {txs.length > 0 && pending === 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-violet-500/60" />
        )}
      </button>

      {open && (
        <div
          className={`absolute ${align === 'start' ? 'left-0' : 'right-0'} ${side === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} z-50 max-h-[min(28rem,calc(100vh-1rem))] w-[min(20rem,calc(100vw-1rem))] overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] shadow-[var(--arena-terminal-shadow-lg)]`}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-arena-elements-dividerColor/50">
            <div className="flex items-center gap-2">
              <div className="i-ph:clock-counter-clockwise text-base text-arena-elements-textTertiary" />
              <span className="text-sm font-display font-semibold text-arena-elements-textPrimary">
                Transactions
              </span>
              {txs.length > 0 && (
                <span className="text-xs font-data text-arena-elements-textTertiary">
                  ({txs.length})
                </span>
              )}
            </div>
            {txs.length > 0 && (
              <button
                type="button"
                onClick={() => { clearTxs(); close(); }}
                className="text-xs font-data text-arena-elements-textTertiary hover:text-crimson-700 dark:hover:text-crimson-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-[400px] overflow-y-auto">
            {txs.length === 0 ? (
              <div className="py-10 text-center">
                <div className="i-ph:receipt text-2xl text-arena-elements-textTertiary mb-2 mx-auto" />
                <p className="text-sm text-arena-elements-textTertiary">
                  No transactions yet
                </p>
              </div>
            ) : (
              txs.map((tx: TrackedTx) => <TxRow key={tx.hash} tx={tx} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
