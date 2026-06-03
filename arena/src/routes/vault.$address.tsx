import { useCallback, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { MetaFunction } from 'react-router';
import type { Address } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { useStore } from '@nanostores/react';
import { Button } from '@tangle-network/blueprint-ui/components';
import { VaultStats } from '~/components/vault/VaultStats';
import { CollateralStats } from '~/components/vault/CollateralStats';
import { CollateralAdmin } from '~/components/vault/CollateralAdmin';
import { DepositForm } from '~/components/vault/DepositForm';
import { WithdrawForm } from '~/components/vault/WithdrawForm';
import { VaultActivity } from '~/components/vault/VaultActivity';
import { ArenaHeaderLink, ArenaPageHeader, type ArenaPageMetric } from '~/components/arena/ArenaPageHeader';
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

function formatVaultMetric(value: number | undefined, {
  suffix = '',
  maximumFractionDigits = 2,
}: {
  suffix?: string;
  maximumFractionDigits?: number;
} = {}) {
  if (value == null || !Number.isFinite(value)) return '-';
  const compact = Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
      })
    : value.toLocaleString(undefined, {
        maximumFractionDigits,
      });
  return suffix ? `${compact} ${suffix}` : compact;
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
      <div className="arena-trace-terminal min-h-full bg-[#081013] px-3 py-3 text-[#f6fefd] sm:px-4 lg:px-6">
        <div className="mx-auto flex w-full max-w-[980px] flex-col gap-3">
          <ArenaPageHeader
            title="Vault"
            metrics={[
              { label: 'Address', value: 'Invalid' },
              { label: 'Chain', value: '-' },
              { label: 'Status', value: 'Blocked' },
            ]}
            controls={(
              <ArenaHeaderLink to="/" icon="i-ph:arrow-left">
                Arena
              </ArenaHeaderLink>
            )}
          />
          <section className="rounded-[6px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-8 text-center">
            <div className="i-ph:wallet mx-auto mb-4 text-3xl text-[var(--arena-terminal-text-muted)]" />
            <h1 className="font-display text-xl font-semibold text-[var(--arena-terminal-text)]">Invalid vault address</h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-[var(--arena-terminal-text-muted)]">
              Provide a valid vault contract address to inspect shares, NAV, collateral, and withdrawal state.
            </p>
          </section>
        </div>
      </div>
    );
  }

  const vaultMetrics: ArenaPageMetric[] = [
    { label: 'TVL', value: formatVaultMetric(vault.tvl, { suffix: vault.assetSymbol }) },
    { label: 'Share Price', value: formatVaultMetric(vault.sharePrice, { suffix: vault.assetSymbol, maximumFractionDigits: 6 }) },
    { label: 'Shares', value: formatVaultMetric(vault.totalShares, { maximumFractionDigits: 0 }) },
    { label: 'Your Shares', value: isConnected ? formatVaultMetric(vault.userSharesFormatted, { maximumFractionDigits: 4 }) : '-' },
  ];

  return (
    <div className="arena-trace-terminal min-h-full bg-[#081013] px-3 py-3 text-[#f6fefd] sm:px-4 lg:px-6">
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-3">
        <ArenaPageHeader
          title="Vault"
          badge={vault.paused ? (
            <span className="rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] px-2 py-1 font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-danger)]">
              Paused
            </span>
          ) : undefined}
          metrics={vaultMetrics}
          metricsClassName="grid-cols-2 min-[900px]:grid-cols-4 min-[1180px]:w-[34rem] min-[1180px]:shrink-0"
          controls={(
            <ArenaHeaderLink to="/" icon="i-ph:arrow-left">
              Arena
            </ArenaHeaderLink>
          )}
        >
          <div className="grid min-w-0 gap-1.5 font-data text-xs min-[980px]:grid-cols-[minmax(0,1fr)_auto] min-[980px]:items-center">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-[var(--arena-terminal-text-secondary)]" translate="no">
                {vaultAddress}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(vaultAddress!);
                }}
                className="shrink-0 text-[var(--arena-terminal-text-muted)] transition-colors hover:text-[var(--arena-terminal-accent)]"
                aria-label="Copy vault address"
              >
                <span className="i-ph:copy text-sm" aria-hidden="true" />
              </button>
            </div>
            <span className="w-fit rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-2 py-1 font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-muted)]">
              {targetChainName} / {targetChainId}
            </span>
          </div>
        </ArenaPageHeader>

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
          <div className="glass-card rounded-[6px] border-amber-400/30 bg-amber-500/5 p-5">
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
          <div className="glass-card rounded-[6px] border-emerald-400/30 bg-emerald-500/5 p-5">
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
          <div className="glass-card rounded-[6px] p-8 text-center">
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
          <div className="glass-card rounded-[6px] p-8 text-center">
            <div className="i-ph:wallet text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary">
              Connect your wallet on {targetChainName} ({targetChainId}) to deposit or withdraw.
            </p>
          </div>
        ) : isWrongChain ? (
          <div className="glass-card rounded-[6px] p-8 text-center">
            <div className="i-ph:arrow-square-out text-3xl text-amber-500 dark:text-amber-400 mb-3 mx-auto" />
            <p className="text-base text-arena-elements-textSecondary mb-4">
              This vault is on <span className="text-violet-700 dark:text-violet-400 font-semibold">{targetChainName} ({targetChainId})</span>. Your wallet is connected to chain {chainId}. Switch chains to deposit or withdraw.
            </p>
            <Button
              onClick={() => switchChain({ chainId: targetChainId })}
              className="border border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)] hover:bg-[var(--arena-terminal-panel-strong)]"
            >
              Switch to {targetChainName}
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
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
    </div>
  );
}
