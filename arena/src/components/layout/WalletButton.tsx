import { ConnectKitButton } from 'connectkit';
import { useAccount, useDisconnect, useSwitchChain, useConnectorClient } from 'wagmi';
import { useStore } from '@nanostores/react';
import type { Address } from 'viem';
import { Identicon } from '@tangle/blueprint-ui/components';
import { publicClient, selectedChainIdStore } from '@tangle/blueprint-ui';
import {
  ConnectWalletCta,
  copyText,
  truncateAddress,
  useDropdownMenu,
  useWalletEthBalance,
} from '@tangle/agent-ui/primitives';
import { networks } from '~/lib/contracts/chains';
import { toast } from 'sonner';

export function WalletButton() {
  const { open, ref, toggle, close } = useDropdownMenu();
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
      toast.success(`Switching to ${targetChain.name}...`);
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
          return <ConnectWalletCta onClick={show} isReconnecting={isReconnecting} />;
        }

        const truncated = truncateAddress(address);
        const displayBalance = ethBalance ?? (balanceError ? '—' : '...');

        return (
          <div ref={ref} className="relative">
            <button
              onClick={toggle}
              className="relative rounded-full hover:ring-2 hover:ring-violet-500/30 transition-all"
              aria-label="Account menu"
              aria-expanded={open}
            >
              {address && <Identicon address={address as Address} size={32} />}
              {isWrongChain && (
                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-500 dark:bg-amber-400 animate-pulse ring-2 ring-arena-elements-background-depth-1" title="Wrong chain" />
              )}
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
                      {displayBalance} ETH
                    </div>
                  </div>
                </div>

                {/* Chain status */}
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-arena-elements-item-backgroundActive mb-3">
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
                      onClick={handleSwitchChain}
                      className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg hover:bg-violet-500/10 transition-colors text-left"
                    >
                      <div className="i-ph:swap text-base text-violet-700 dark:text-violet-400" />
                      <span className="text-sm font-display text-arena-elements-textSecondary">
                        Switch to {targetChain?.name ?? 'Unknown'}
                      </span>
                    </button>
                  )}
                  <button
                    onClick={addChain}
                    className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg hover:bg-violet-500/10 transition-colors text-left"
                  >
                    <div className="i-ph:plus-circle text-base text-violet-700 dark:text-violet-400" />
                    <span className="text-sm font-display text-arena-elements-textSecondary">
                      Add {targetChain?.name ?? 'Unknown'} to Wallet
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
                    onClick={() => { disconnect(); close(); }}
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
