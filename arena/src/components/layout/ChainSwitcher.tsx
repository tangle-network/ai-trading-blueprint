import { useState, useRef, useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { selectedChainIdStore } from '~/lib/contracts/publicClient';
import { networks, tangleLocal, tangleTestnet, tangleMainnet } from '~/lib/contracts/chains';

const chainOrder = [tangleLocal.id, tangleTestnet.id, tangleMainnet.id];

const chainIcons: Record<number, string> = {
  [tangleLocal.id]: 'i-ph:desktop',
  [tangleTestnet.id]: 'i-ph:flask',
  [tangleMainnet.id]: 'i-ph:globe-hemisphere-west',
};

export function ChainSwitcher() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedChainId = useStore(selectedChainIdStore);
  const current = networks[selectedChainId];

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function selectChain(chainId: number) {
    selectedChainIdStore.set(chainId);
    setOpen(false);
    // Force refetch on all hooks by reloading — simplest way to propagate chain change
    // In production, hooks should subscribe to the store. For now, a page reload is fine.
    window.location.reload();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-data font-medium
          bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-4
          border border-arena-elements-borderColor
          hover:border-arena-elements-borderColorActive/40 transition-all"
        title={current?.label ?? 'Select network'}
      >
        <div className={`${chainIcons[selectedChainId] ?? 'i-ph:globe'} text-sm text-arena-elements-icon-success`} />
        <span className="hidden sm:inline text-arena-elements-textSecondary">
          {current?.shortLabel ?? 'Unknown'}
        </span>
        <div className={`i-ph:caret-down text-[10px] text-arena-elements-textTertiary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-48 glass-card-strong rounded-xl border border-arena-elements-dividerColor/50 py-1.5 z-50 shadow-lg">
          <div className="px-3 py-1.5 text-[10px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
            Network
          </div>
          {chainOrder.map((chainId) => {
            const net = networks[chainId];
            if (!net) return null;
            const isSelected = chainId === selectedChainId;
            return (
              <button
                key={chainId}
                onClick={() => selectChain(chainId)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? 'bg-violet-500/10 text-violet-700 dark:text-violet-400'
                    : 'hover:bg-arena-elements-item-backgroundHover text-arena-elements-textSecondary'
                }`}
              >
                <div className={`${chainIcons[chainId] ?? 'i-ph:globe'} text-sm ${
                  isSelected ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textTertiary'
                }`} />
                <span className="text-sm font-display font-medium">{net.label}</span>
                {isSelected && (
                  <div className="i-ph:check-bold text-xs ml-auto text-violet-700 dark:text-violet-400" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
