import { useParams, Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { AnimatedPage } from '~/components/motion/AnimatedPage';
import { VaultStats } from '~/components/vault/VaultStats';
import { DepositForm } from '~/components/vault/DepositForm';
import { WithdrawForm } from '~/components/vault/WithdrawForm';
import { useVaultRead } from '~/lib/hooks/useVaultRead';

export const meta: MetaFunction = () => [
  { title: 'Vault — AI Trading Arena' },
];

export default function VaultPage() {
  const { address } = useParams();
  const vaultAddress = address as Address | undefined;
  const { isConnected } = useAccount();

  const vault = useVaultRead(vaultAddress);

  const isValidAddress = vaultAddress && /^0x[a-fA-F0-9]{40}$/.test(vaultAddress);

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
          to="/arena"
          className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-emerald-400 mb-6 transition-colors duration-200 font-display font-medium"
        >
          <span className="text-xs">&larr;</span> Back to Arena
        </Link>

        <div className="mb-8">
          <h1 className="font-display font-bold text-3xl tracking-tight">Vault</h1>
          <p className="text-sm text-arena-elements-textTertiary font-data mt-1 break-all">
            {vaultAddress}
          </p>
          {vault.assetSymbol !== '???' && (
            <p className="text-sm text-arena-elements-textSecondary font-display mt-1">
              Asset: {vault.assetSymbol}
            </p>
          )}
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

        {!isConnected && (
          <div className="glass-card rounded-xl p-8 mb-6 text-center">
            <div className="i-ph:wallet text-2xl text-arena-elements-textTertiary mb-3 mx-auto" />
            <p className="text-sm text-arena-elements-textSecondary">
              Connect your wallet to deposit or withdraw.
            </p>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6">
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
            sharePrice={vault.sharePrice}
            userShares={vault.userShares}
            userSharesFormatted={vault.userSharesFormatted}
            onSuccess={vault.refetch}
          />
        </div>
      </div>
    </AnimatedPage>
  );
}
