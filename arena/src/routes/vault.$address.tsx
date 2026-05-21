import { useCallback, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router';
import type { MetaFunction } from 'react-router';
import type { Address } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { useStore } from '@nanostores/react';
import { AnimatedPage, Button } from '@tangle-network/blueprint-ui/components';
import { VaultStats } from '~/components/vault/VaultStats';
import { CollateralStats } from '~/components/vault/CollateralStats';
import { CollateralAdmin } from '~/components/vault/CollateralAdmin';
import { DepositForm } from '~/components/vault/DepositForm';
import { WithdrawForm } from '~/components/vault/WithdrawForm';
import { VaultActivity } from '~/components/vault/VaultActivity';
import { useVaultRead } from '~/lib/hooks/useVaultRead';
import { networks } from '~/lib/contracts/chains';
import { selectedChainIdStore } from '@tangle-network/blueprint-ui';

export const meta: MetaFunction = () => [
  { title: 'Vault — AI Trading Arena' },
];

const KNOWN_CHAIN_NAMES: Record<number, string> = {
  8453: 'Base',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
  31337: 'Tangle Local',
  31338: 'Ethereum Local Fork',
  31339: 'Ethereum Fork',
};

function parseChainIdParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function chainLabel(chainId: number, configuredName?: string): string {
  return configuredName ?? KNOWN_CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export default function VaultPage() {
  const { address } = useParams();
  const [searchParams] = useSearchParams();
  const vaultAddress = address as Address | undefined;
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const selectedChainId = useStore(selectedChainIdStore);
  const selectedNetwork = networks[selectedChainId] ?? Object.values(networks)[0];
  const requestedChainId = parseChainIdParam(searchParams.get('chainId'));
  const targetChainId = requestedChainId ?? selectedNetwork.chain.id;
  const targetNetwork = networks[targetChainId];
  const targetChainName = chainLabel(targetChainId, targetNetwork?.chain.name);

  const vault = useVaultRead(vaultAddress, targetChainId);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const handleVaultMutationSuccess = useCallback(() => {
    void vault.refetch();
    setActivityRefreshKey((key) => key + 1);
  }, [vault.refetch]);

  const isValidAddress = vaultAddress && /^0x[a-fA-F0-9]{40}$/.test(vaultAddress);
  const isWrongChain = isConnected && chainId !== targetChainId;
  const navNeedsPricing = vault.hasNonDepositAssets && vault.isNavSafe !== true;

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
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-arena-elements-background-depth-2 border border-arena-elements-borderColor text-xs font-data font-semibold text-arena-elements-textSecondary uppercase tracking-wider">
                  {targetChainName} · {targetChainId}
                </span>
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
          isConnected={isConnected}
          approximateNav={navNeedsPricing}
          userSharesFormatted={vault.userSharesFormatted}
        />

        {navNeedsPricing ? (
          <div className="glass-card rounded-xl p-5 mb-6 border-amber-400/30 bg-amber-500/5">
            <div className="flex items-start gap-3">
              <div className="i-ph:warning-circle text-lg text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-display font-semibold text-arena-elements-textPrimary">
                  Vault value needs pricing
                </div>
                <p className="text-sm text-arena-elements-textSecondary mt-1">
                  This vault holds assets without a configured price adapter. Deposits and main-asset withdrawals are paused until pricing is configured.
                </p>
              </div>
            </div>
          </div>
        ) : vault.hasNonDepositAssets ? (
          <div className="glass-card rounded-xl p-5 mb-6 border-emerald-400/30 bg-emerald-500/5">
            <div className="flex items-start gap-3">
              <div className="i-ph:check-circle text-lg text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-display font-semibold text-arena-elements-textPrimary">
                  Vault value includes traded assets
                </div>
                <p className="text-sm text-arena-elements-textSecondary mt-1">
                  Non-{vault.assetSymbol} positions are priced through the vault adapter. Basket withdrawals return each held asset pro rata.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <CollateralStats
          vaultAddress={vaultAddress}
          targetChainId={targetChainId}
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
            targetChainId={targetChainId}
            targetChainName={targetChainName}
            onSuccess={handleVaultMutationSuccess}
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
              Connect your wallet on {targetChainName} ({targetChainId}) to deposit or withdraw.
            </p>
          </div>
        ) : isWrongChain ? (
          <div className="glass-card rounded-xl p-8 mb-6 text-center">
            <div className="i-ph:arrow-square-out text-3xl text-amber-500 dark:text-amber-400 mb-3 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary mb-4">
              This vault is on <span className="text-violet-700 dark:text-violet-400 font-semibold">{targetChainName} ({targetChainId})</span>. Your wallet is connected to chain {chainId}. Switch chains to deposit or withdraw.
            </p>
            <Button
              onClick={() => switchChain({ chainId: targetChainId })}
              className="bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20"
            >
              Switch to {targetChainName}
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
            maxDeposit={vault.maxDeposit}
            paused={vault.paused}
            targetChainId={targetChainId}
            targetChainName={targetChainName}
            onSuccess={handleVaultMutationSuccess}
          />
          <WithdrawForm
            vaultAddress={vaultAddress}
            assetSymbol={vault.assetSymbol}
            assetDecimals={vault.assetDecimals}
            shareDecimals={vault.shareDecimals}
            userShares={vault.userShares}
            userSharesFormatted={vault.userSharesFormatted}
            paused={vault.paused}
            targetChainId={targetChainId}
            targetChainName={targetChainName}
            onSuccess={handleVaultMutationSuccess}
          />
        </div>

        <VaultActivity
          vaultAddress={vaultAddress}
          assetToken={vault.assetToken}
          targetChainId={targetChainId}
          assetSymbol={vault.assetSymbol}
          assetDecimals={vault.assetDecimals}
          shareDecimals={vault.shareDecimals}
          refreshKey={activityRefreshKey}
        />
      </div>
    </AnimatedPage>
  );
}
