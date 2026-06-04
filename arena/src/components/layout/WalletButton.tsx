import type { RefObject } from 'react';
import { ConnectKitButton } from 'connectkit';
import { useAccount, useDisconnect, useSwitchChain, useConnectorClient } from 'wagmi';
import { useStore } from '@nanostores/react';
import type { Address } from 'viem';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import { cn, publicClient, selectedChainIdStore, useWalletEthBalance } from '@tangle-network/blueprint-ui';
import { useDropdownMenu } from '@tangle-network/sandbox-ui/hooks';
import { copyText } from '@tangle-network/sandbox-ui/utils';
import { networks } from '~/lib/contracts/chains';
import { toast } from 'sonner';

function truncateAddress(address?: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton({
  align = 'end',
  side = 'down',
  compact = false,
}: {
  align?: 'start' | 'end';
  side?: 'up' | 'down';
  compact?: boolean;
} = {}) {
  const { open, ref, toggle, close } = useDropdownMenu();
  const menuRef = ref as RefObject<HTMLDivElement>;
  const { address, chainId, isConnected, status } = useAccount();
  const isReconnecting = status === 'reconnecting';
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: connectorClient } = useConnectorClient();
  const selectedChainId = useStore(selectedChainIdStore);
  const selectedNetwork = networks[selectedChainId];
  const { balance: ethBalance, hasError: balanceError } = useWalletEthBalance({
    address,
    refreshKey: selectedChainId,
    readBalance: (walletAddress) => publicClient.getBalance({ address: walletAddress as Address }),
    onError: (err) => console.warn('[WalletButton] balance fetch failed:', err),
  });

  const isWrongChain = isConnected && chainId !== selectedChainId;

  async function copyAddress() {
    if (!address) return;
    await copyText(address);
    toast.success('Address copied');
  }

  const targetChain = selectedNetwork?.chain;

  async function addChain() {
    if (!targetChain) return;
    // Use wagmi's switchChain which handles add+switch via the active connector
    try {
      switchChain({ chainId: targetChain.id });
      toast.success(`Switching to ${targetChain.name}…`);
    } catch (err: any) {
      if (err?.code === 4001) return; // user rejected
      // Fallback: try raw provider if available
      const provider = connectorClient?.transport || (window as any).ethereum;
      if (provider?.request) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: `0x${targetChain.id.toString(16)}`,
              chainName: targetChain.name,
              nativeCurrency: targetChain.nativeCurrency,
              rpcUrls: targetChain.rpcUrls.default.http,
            }],
          });
          toast.success(`${targetChain.name} added to wallet`);
          return;
        } catch (addErr: any) {
          if (addErr?.code === 4001) return;
        }
      }
      toast.error('Failed to add chain — add it manually in your wallet settings');
    }
  }

  function handleSwitchChain() {
    if (targetChain) switchChain({ chainId: targetChain.id });
  }

  return (
    <ConnectKitButton.Custom>
      {({ show }) => {
        if (!isConnected) {
          return (
            <button
              type="button"
              onClick={show}
              disabled={isReconnecting}
              className={cn(
                'inline-flex h-10 max-w-full items-center justify-center gap-2 rounded-[5px] border border-[#50d2c1]/55 bg-[#50d2c1] font-display text-sm font-semibold text-[#06100e] shadow-none transition-[background-color,border-color,opacity,transform] duration-150 hover:border-[#7ce6d9] hover:bg-[#7ce6d9] active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#081013]',
                compact ? 'w-10 min-w-0 px-0' : 'min-w-[8.75rem] px-3',
              )}
              aria-label="Connect Wallet"
              title={compact ? 'Connect Wallet' : undefined}
            >
              <span className="i-ph:plug-charging-bold shrink-0 text-base" aria-hidden="true" />
              <span className={compact ? 'sr-only' : 'truncate'}>
                {isReconnecting ? 'Reconnecting…' : 'Connect Wallet'}
              </span>
            </button>
          );
        }

        const truncated = truncateAddress(address);
        const displayBalance = ethBalance ?? (balanceError ? '—' : '…');

        return (
          <div ref={menuRef} className="relative min-w-0">
            <button
              type="button"
              onClick={toggle}
              className={cn(
                'inline-flex h-10 max-w-full items-center rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)] transition-[background-color,border-color,color,opacity,transform] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
                compact ? 'w-10 justify-center px-0' : 'w-full min-w-0 justify-start gap-2 px-2',
              )}
              aria-label={`Account menu ${truncated}`}
              aria-expanded={open}
              title={compact ? truncated : undefined}
            >
              <span className="relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full">
                {address && <Identicon address={address as Address} size={28} />}
                {isWrongChain && (
                  <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-[var(--arena-terminal-panel)] dark:bg-amber-400" title="Wrong chain" />
                )}
              </span>
              {!compact && (
                <>
                  <span className="min-w-0 flex-1 truncate text-left font-data text-sm font-semibold tabular-nums text-[var(--arena-terminal-text)]">
                    {truncated}
                  </span>
                  <span className="i-ph:caret-up-down shrink-0 text-xs text-[var(--arena-terminal-text-muted)]" aria-hidden="true" />
                </>
              )}
            </button>

            {open && (
              <div
                role="menu"
                aria-label="Account actions"
                className={cn(
                  'absolute z-50 max-h-[min(28rem,calc(100vh-1rem))] w-[min(18rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3 text-[var(--arena-terminal-text)] shadow-[var(--arena-terminal-shadow-lg)]',
                  align === 'start' ? 'left-0' : 'right-0',
                  side === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
                )}
              >
                {/* Address + Copy */}
                <div className="flex items-center gap-3 mb-4">
                  {address && <Identicon address={address as Address} size={32} />}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={copyAddress}
                      className="flex items-center gap-2 group w-full"
                      title="Copy address"
                    >
                      <span className="truncate text-sm font-data text-[var(--arena-terminal-text)]">
                        {truncated}
                      </span>
                      <div className="i-ph:copy shrink-0 text-sm text-[var(--arena-terminal-text-muted)] transition-colors group-hover:text-[var(--arena-terminal-accent)]" />
                    </button>
                    <div className="text-xs font-data text-[var(--arena-terminal-text-secondary)]">
                      {displayBalance} ETH
                    </div>
                  </div>
                </div>

                {/* Chain status */}
                <div className="mb-3 flex items-center gap-2.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3 py-2.5">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isWrongChain ? 'bg-amber-500 dark:bg-amber-400 animate-pulse' : 'bg-emerald-600 dark:bg-emerald-400'}`} />
                  <span className="flex-1 text-sm font-data text-[var(--arena-terminal-text-secondary)]">
                    {isWrongChain ? `Chain ${chainId}` : (targetChain?.name ?? 'Unknown')}
                  </span>
                  {isWrongChain && (
                    <span className="text-xs font-data text-amber-600 dark:text-amber-400 uppercase tracking-wider font-semibold">wrong chain</span>
                  )}
                </div>

                {/* Actions */}
                <div className="space-y-1">
                  {isWrongChain && (
                    <button
                      type="button"
                      onClick={handleSwitchChain}
                      className="flex w-full items-center gap-2.5 rounded-[5px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--arena-terminal-panel-strong)]"
                    >
                      <div className="i-ph:swap text-base text-[var(--arena-terminal-accent)]" />
                      <span className="text-sm font-display text-[var(--arena-terminal-text-secondary)]">
                        Switch to {targetChain?.name ?? 'Unknown'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={addChain}
                    className="flex w-full items-center gap-2.5 rounded-[5px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--arena-terminal-panel-strong)]"
                  >
                    <div className="i-ph:plus-circle text-base text-[var(--arena-terminal-accent)]" />
                    <span className="text-sm font-display text-[var(--arena-terminal-text-secondary)]">
                      Add {targetChain?.name ?? 'Unknown'} to Wallet
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={copyAddress}
                    className="flex w-full items-center gap-2.5 rounded-[5px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--arena-terminal-panel-strong)]"
                  >
                    <div className="i-ph:copy text-base text-[var(--arena-terminal-text-muted)]" />
                    <span className="text-sm font-display text-[var(--arena-terminal-text-secondary)]">
                      Copy Address
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { disconnect(); close(); }}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-[5px] hover:bg-crimson-500/10 transition-colors text-left"
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
