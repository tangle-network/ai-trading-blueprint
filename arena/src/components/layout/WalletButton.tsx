import type { RefObject } from 'react';
import { ConnectKitButton } from 'connectkit';
import { useAccount, useDisconnect, useSwitchChain, useConnectorClient } from 'wagmi';
import { useStore } from '@nanostores/react';
import type { Address } from 'viem';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import { publicClient, selectedChainIdStore, useWalletEthBalance } from '@tangle-network/blueprint-ui';
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
}: {
  align?: 'start' | 'end';
  side?: 'up' | 'down';
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
              className="inline-flex h-10 min-w-[8.75rem] max-w-full items-center justify-center gap-2 rounded-[5px] border border-[#50d2c1]/55 bg-[#50d2c1] px-3 font-display text-sm font-semibold text-[#06100e] shadow-none transition-[background-color,border-color,opacity,transform] duration-150 hover:border-[#7ce6d9] hover:bg-[#7ce6d9] active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#081013]"
              aria-label="Connect Wallet"
            >
              <span className="i-ph:plug-charging-bold shrink-0 text-base" aria-hidden="true" />
              <span className="truncate">
                {isReconnecting ? 'Reconnecting…' : 'Connect Wallet'}
              </span>
            </button>
          );
        }

        const truncated = truncateAddress(address);
        const displayBalance = ethBalance ?? (balanceError ? '—' : '…');

        return (
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={toggle}
              className="relative rounded-full transition-[box-shadow,opacity] duration-150 hover:ring-2 hover:ring-[#50d2c1]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
              aria-label="Account menu"
              aria-expanded={open}
            >
              {address && <Identicon address={address as Address} size={32} />}
              {isWrongChain && (
                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-500 dark:bg-amber-400 animate-pulse ring-2 ring-arena-elements-background-depth-1" title="Wrong chain" />
              )}
            </button>

            {open && (
              <div className={`absolute ${align === 'start' ? 'left-0' : 'right-0'} ${side === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} z-50 w-72 max-w-[calc(100vw-1rem)] rounded-[6px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-3 text-[var(--arena-terminal-text)] shadow-[var(--arena-terminal-shadow-lg)]`}>
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
                      <span className="text-sm font-data text-arena-elements-textPrimary truncate">
                        {truncated}
                      </span>
                      <div className="i-ph:copy text-sm text-arena-elements-textTertiary group-hover:text-violet-700 dark:group-hover:text-violet-400 transition-colors shrink-0" />
                    </button>
                    <div className="text-xs font-data text-arena-elements-textSecondary">
                      {displayBalance} ETH
                    </div>
                  </div>
                </div>

                {/* Chain status */}
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[5px] bg-arena-elements-item-backgroundActive mb-3">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isWrongChain ? 'bg-amber-500 dark:bg-amber-400 animate-pulse' : 'bg-emerald-600 dark:bg-emerald-400'}`} />
                  <span className="text-sm font-data text-arena-elements-textSecondary flex-1">
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
                      className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-[5px] hover:bg-violet-500/10 transition-colors text-left"
                    >
                      <div className="i-ph:swap text-base text-violet-700 dark:text-violet-400" />
                      <span className="text-sm font-display text-arena-elements-textSecondary">
                        Switch to {targetChain?.name ?? 'Unknown'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={addChain}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-[5px] hover:bg-violet-500/10 transition-colors text-left"
                  >
                    <div className="i-ph:plus-circle text-base text-violet-700 dark:text-violet-400" />
                    <span className="text-sm font-display text-arena-elements-textSecondary">
                      Add {targetChain?.name ?? 'Unknown'} to Wallet
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={copyAddress}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-[5px] hover:bg-arena-elements-item-backgroundHover transition-colors text-left"
                  >
                    <div className="i-ph:copy text-base text-arena-elements-textTertiary" />
                    <span className="text-sm font-display text-arena-elements-textSecondary">
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
