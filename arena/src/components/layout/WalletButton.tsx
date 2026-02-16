import { useState, useRef, useEffect } from 'react';
import { ConnectKitButton } from 'connectkit';
import { useAccount, useBalance, useDisconnect, useSwitchChain } from 'wagmi';
import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { tangleLocal } from '~/lib/contracts/chains';
import { Identicon } from '~/components/shared/Identicon';
import { toast } from 'sonner';

export function WalletButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { address, chainId, isConnected, status } = useAccount();
  // Only show loading spinner during page-load rehydration, not active connecting
  const isReconnecting = status === 'reconnecting';
  const { data: balance } = useBalance({ address, chainId: tangleLocal.id });
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const isWrongChain = isConnected && chainId !== tangleLocal.id;

  // Close dropdown on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success('Address copied');
    } catch {
      // Fallback for non-HTTPS contexts
      const textarea = document.createElement('textarea');
      textarea.value = address;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      toast.success('Address copied');
    }
  }

  async function addChain() {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      toast.error('No wallet detected');
      return;
    }
    try {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: `0x${tangleLocal.id.toString(16)}`,
          chainName: tangleLocal.name,
          nativeCurrency: tangleLocal.nativeCurrency,
          rpcUrls: tangleLocal.rpcUrls.default.http,
        }],
      });
      toast.success(`${tangleLocal.name} added to wallet`);
    } catch (err: any) {
      if (err?.code === 4001) return; // user rejected
      toast.error('Failed to add chain');
    }
  }

  function handleSwitchChain() {
    switchChain({ chainId: tangleLocal.id });
  }

  return (
    <ConnectKitButton.Custom>
      {({ show }) => {
        if (!isConnected) {
          return (
            <button
              onClick={show}
              className="px-4 py-2.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-700 dark:text-violet-400 text-sm font-display font-medium hover:bg-violet-500/20 transition-colors"
            >
              {isReconnecting ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full border-2 border-violet-500/40 border-t-violet-600 dark:border-t-violet-400 animate-spin" />
                  Reconnecting...
                </span>
              ) : 'Connect'}
            </button>
          );
        }

        const truncated = address
          ? `${address.slice(0, 6)}...${address.slice(-4)}`
          : '';
        const ethBalance = balance
          ? parseFloat(formatUnits(balance.value, balance.decimals)).toFixed(3)
          : '...';

        return (
          <div ref={ref} className="relative">
            <button
              onClick={() => setOpen(!open)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg glass-card hover:border-violet-500/20 transition-all"
            >
              {isWrongChain && (
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500 dark:bg-amber-400 animate-pulse shrink-0" title="Wrong chain" />
              )}
              {address && <Identicon address={address as Address} size={22} />}
              <span className="text-sm font-data text-arena-elements-textPrimary">
                {truncated}
              </span>
              <span className="text-xs font-data text-arena-elements-textSecondary">
                {ethBalance} ETH
              </span>
              <div className={`i-ph:caret-down text-xs text-arena-elements-textTertiary transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
              <div className="absolute right-0 top-full mt-2 w-72 glass-card-strong rounded-xl border border-arena-elements-dividerColor/50 p-4 z-50 shadow-lg">
                {/* Address + Copy */}
                <div className="flex items-center gap-3 mb-4">
                  {address && <Identicon address={address as Address} size={32} />}
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={copyAddress}
                      className="flex items-center gap-2 group w-full"
                      title="Copy address"
                    >
                      <span className="text-sm font-data text-arena-elements-textPrimary truncate">
                        {truncated}
                      </span>
                      <div className="i-ph:copy text-sm text-arena-elements-textTertiary group-hover:text-violet-700 dark:group-hover:text-violet-400 transition-colors shrink-0" />
                    </button>
                    <div className="text-xs font-data text-arena-elements-textSecondary">
                      {ethBalance} ETH
                    </div>
                  </div>
                </div>

                {/* Chain status */}
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-arena-elements-item-backgroundActive mb-3">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isWrongChain ? 'bg-amber-500 dark:bg-amber-400 animate-pulse' : 'bg-emerald-600 dark:bg-emerald-400'}`} />
                  <span className="text-sm font-data text-arena-elements-textSecondary flex-1">
                    {isWrongChain ? `Chain ${chainId}` : tangleLocal.name}
                  </span>
                  {isWrongChain && (
                    <span className="text-xs font-data text-amber-600 dark:text-amber-400 uppercase tracking-wider font-semibold">wrong chain</span>
                  )}
                </div>

                {/* Actions */}
                <div className="space-y-1">
                  {isWrongChain && (
                    <button
                      onClick={handleSwitchChain}
                      className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg hover:bg-violet-500/10 transition-colors text-left"
                    >
                      <div className="i-ph:swap text-base text-violet-700 dark:text-violet-400" />
                      <span className="text-sm font-display text-arena-elements-textSecondary">
                        Switch to {tangleLocal.name}
                      </span>
                    </button>
                  )}
                  <button
                    onClick={addChain}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg hover:bg-violet-500/10 transition-colors text-left"
                  >
                    <div className="i-ph:plus-circle text-base text-violet-700 dark:text-violet-400" />
                    <span className="text-sm font-display text-arena-elements-textSecondary">
                      Add {tangleLocal.name} to Wallet
                    </span>
                  </button>
                  <button
                    onClick={copyAddress}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg hover:bg-arena-elements-item-backgroundHover transition-colors text-left"
                  >
                    <div className="i-ph:copy text-base text-arena-elements-textTertiary" />
                    <span className="text-sm font-display text-arena-elements-textSecondary">
                      Copy Address
                    </span>
                  </button>
                  <button
                    onClick={() => { disconnect(); setOpen(false); }}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg hover:bg-crimson-500/10 transition-colors text-left"
                  >
                    <div className="i-ph:sign-out text-base text-crimson-600 dark:text-crimson-400" />
                    <span className="text-sm font-display text-crimson-600 dark:text-crimson-400">
                      Disconnect
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      }}
    </ConnectKitButton.Custom>
  );
}
