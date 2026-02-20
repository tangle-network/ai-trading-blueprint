import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'sonner';
import { txListStore, pendingCount, clearTxs, type TrackedTx } from '@tangle/blueprint-ui';
import { useTxWatcher } from '~/lib/hooks/useTxWatcher';
import { useProvisionWatcher } from '~/lib/hooks/useProvisionWatcher';

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

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

  const copyHash = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tx.hash);
      toast.success('Tx hash copied');
    } catch {
      const el = document.createElement('textarea');
      el.value = tx.hash;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      toast.success('Tx hash copied');
    }
  }, [tx.hash]);

  return (
    <div className="border-b border-arena-elements-dividerColor/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-arena-elements-item-backgroundHover transition-colors text-left"
      >
        <StatusIcon status={tx.status} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-display font-medium text-arena-elements-textPrimary truncate">
            {tx.label}
          </div>
          <div className="text-xs font-data text-arena-elements-textTertiary mt-0.5">
            {tx.hash.slice(0, 10)}...{tx.hash.slice(-6)}
            <span className="ml-2">{timeAgo(tx.timestamp)}</span>
          </div>
        </div>
        <div className={`i-ph:caret-down text-xs text-arena-elements-textTertiary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-data text-arena-elements-textTertiary w-16 shrink-0">Hash</span>
            <button
              type="button"
              onClick={copyHash}
              className="text-xs font-data text-arena-elements-textSecondary hover:text-violet-700 dark:hover:text-violet-400 transition-colors truncate group flex items-center gap-1.5"
            >
              <span className="truncate">{tx.hash}</span>
              <div className="i-ph:copy text-xs opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
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
              <span className="text-xs font-data text-arena-elements-textSecondary">{tx.gasUsed.toLocaleString()}</span>
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

export function TxDropdown() {
  useTxWatcher();
  useProvisionWatcher();

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const txs = useStore(txListStore);
  const pending = useStore(pendingCount);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative p-2.5 rounded-lg glass-card hover:border-violet-500/20 transition-all"
        title="Transaction history"
      >
        <div className="i-ph:receipt text-base text-arena-elements-textSecondary" />
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
        <div className="absolute right-0 top-full mt-2 w-96 glass-card-strong rounded-xl border border-arena-elements-dividerColor/50 z-50 shadow-xl overflow-hidden">
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
                onClick={() => { clearTxs(); setOpen(false); }}
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
