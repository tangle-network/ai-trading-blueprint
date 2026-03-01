import { useParams, Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import type { Address } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { useStore } from '@nanostores/react';
import { AnimatedPage, Button } from '@tangle/blueprint-ui/components';
import { VaultStats } from '~/components/vault/VaultStats';
import { CollateralStats } from '~/components/vault/CollateralStats';
import { CollateralAdmin } from '~/components/vault/CollateralAdmin';
import { DepositForm } from '~/components/vault/DepositForm';
import { WithdrawForm } from '~/components/vault/WithdrawForm';
import { useVaultRead } from '~/lib/hooks/useVaultRead';
import { networks } from '~/lib/contracts/chains';
import { selectedChainIdStore } from '@tangle/blueprint-ui';

export const meta: MetaFunction = () => [
  { title: 'Vault — AI Trading Arena' },
];

export default function VaultPage() {
  const { address } = useParams();
  const vaultAddress = address as Address | undefined;
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const selectedChainId = useStore(selectedChainIdStore);
  const selectedNetwork = networks[selectedChainId]!;
  const targetChain = selectedNetwork.chain;

  const vault = useVaultRead(vaultAddress);

  const isValidAddress = vaultAddress && /^0x[a-fA-F0-9]{40}$/.test(vaultAddress);
  const isWrongChain = isConnected && chainId !== targetChain.id;

  if (!isValidAddress) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 text-center">
        <div className="glass-card rounded-xl p-12 max-w-md mx-auto">
          <div className="i-ph:wallet text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
          <h1 className="font-display text-2xl font-bold mb-3">Invalid Vault Address</h1>
          <p className="text-arena-elements-textSecondary mb-6 text-sm">
            Please provide a valid vault contract address.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AnimatedPage>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 mb-6 transition-colors duration-200 font-display font-medium"
        >
          <span className="text-sm">&larr;</span> Back to Leaderboard
        </Link>

        <div className="glass-card rounded-xl p-6 mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
              <div className="i-ph:vault text-xl text-violet-700 dark:text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="font-display font-bold text-2xl tracking-tight">Vault</h1>
                {vault.assetSymbol !== '???' && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs font-data font-semibold text-violet-700 dark:text-violet-400 uppercase tracking-wider">
                    {vault.assetSymbol}
                  </span>
                )}
                {vault.paused && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-crimson-500/10 border border-crimson-500/20 text-xs font-data font-semibold text-crimson-600 dark:text-crimson-400 uppercase tracking-wider">
                    Paused
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1.5">
                <p className="text-sm text-arena-elements-textSecondary font-data truncate">
                  {vaultAddress}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(vaultAddress!);
                  }}
                  className="text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 transition-colors shrink-0"
                  aria-label="Copy vault address"
                >
                  <div className="i-ph:copy text-sm" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <VaultStats
          tvl={vault.tvl}
          sharePrice={vault.sharePrice}
          totalShares={vault.totalShares}
          assetSymbol={vault.assetSymbol}
          paused={vault.paused}
          isLoading={vault.isLoading}
          userSharesFormatted={vault.userSharesFormatted}
        />

        <CollateralStats
          vaultAddress={vaultAddress}
          totalOutstandingCollateral={vault.totalOutstandingCollateral}
          maxCollateralBps={vault.maxCollateralBps}
          availableCollateral={vault.availableCollateral}
          assetDecimals={vault.assetDecimals}
          assetSymbol={vault.assetSymbol}
          tvl={vault.tvl}
          isLoading={vault.isLoading}
        />

        {vault.isAdmin && (
          <CollateralAdmin
            vaultAddress={vaultAddress}
            assetDecimals={vault.assetDecimals}
            assetSymbol={vault.assetSymbol}
            maxCollateralBps={vault.maxCollateralBps}
            onSuccess={vault.refetch}
          />
        )}

        {vault.error ? (
          <div className="glass-card rounded-xl p-8 mb-6 text-center">
            <div className="i-ph:warning-circle text-3xl text-crimson-500 dark:text-crimson-400 mb-3 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary mb-2">
              Could not read vault contract data.
            </p>
            <p className="text-sm text-arena-elements-textTertiary mb-4">
              {vault.error.message}
            </p>
            <Button
              onClick={vault.refetch}
              variant="outline"
              size="sm"
            >
              Retry
            </Button>
          </div>
        ) : !isConnected ? (
          <div className="glass-card rounded-xl p-8 mb-6 text-center">
            <div className="i-ph:wallet text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary">
              Connect your wallet to deposit or withdraw.
            </p>
          </div>
        ) : isWrongChain ? (
          <div className="glass-card rounded-xl p-8 mb-6 text-center">
            <div className="i-ph:arrow-square-out text-3xl text-amber-500 dark:text-amber-400 mb-3 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary mb-4">
              Your wallet is connected to chain {chainId}. Switch to <span className="text-violet-700 dark:text-violet-400 font-semibold">{targetChain.name} ({targetChain.id})</span> to interact with this vault.
            </p>
            <Button
              onClick={() => switchChain({ chainId: targetChain.id })}
              className="bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20"
            >
              Switch to {targetChain.name}
            </Button>
          </div>
        ) : null}

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <DepositForm
            vaultAddress={vaultAddress}
            assetToken={vault.assetToken}
            assetSymbol={vault.assetSymbol}
            assetDecimals={vault.assetDecimals}
            sharePrice={vault.sharePrice}
            userAssetBalance={vault.userAssetBalance}
            userAssetBalanceFormatted={vault.userAssetBalanceFormatted}
            userAllowance={vault.userAllowance}
            onSuccess={vault.refetch}
          />
          <WithdrawForm
            vaultAddress={vaultAddress}
            assetSymbol={vault.assetSymbol}
            shareDecimals={vault.shareDecimals}
            sharePrice={vault.sharePrice}
            userShares={vault.userShares}
            userSharesFormatted={vault.userSharesFormatted}
            onSuccess={vault.refetch}
          />
        </div>

        {/* Recent Activity */}
        <div className="glass-card rounded-xl p-6">
          <h2 className="font-display font-bold text-lg mb-4">Recent Activity</h2>
          <div className="py-8 text-center">
            <div className="i-ph:clock-counter-clockwise text-2xl text-arena-elements-textTertiary mb-3 mx-auto" />
            <p className="text-sm text-arena-elements-textSecondary">
              Deposit and withdrawal history coming soon.
            </p>
          </div>
        </div>
      </div>
    </AnimatedPage>
  );
}
