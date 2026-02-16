import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import type { Address } from 'viem';
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { toast } from 'sonner';
import { useRedeem } from '~/lib/hooks/useVaultWrite';
import { tangleLocal } from '~/lib/contracts/chains';
import { addTx } from '~/lib/stores/txHistory';

interface WithdrawFormProps {
  vaultAddress: Address;
  assetSymbol: string;
  shareDecimals: number;
  sharePrice?: number;
  userShares?: bigint;
  userSharesFormatted?: number;
  onSuccess: () => void;
}

export function WithdrawForm({
  vaultAddress,
  assetSymbol,
  shareDecimals,
  sharePrice,
  userShares,
  userSharesFormatted,
  onSuccess,
}: WithdrawFormProps) {
  const { isConnected, chainId } = useAccount();
  const isReady = isConnected && chainId === tangleLocal.id;
  const [shares, setShares] = useState('');
  const redeem = useRedeem();

  const parsedShares = shares && parseFloat(shares) > 0
    ? parseUnits(shares, shareDecimals)
    : 0n;

  const insufficientShares = parsedShares > 0n && (userShares ?? 0n) < parsedShares;

  const valueReceived = shares && parseFloat(shares) > 0 && sharePrice
    ? (parseFloat(shares) * sharePrice).toFixed(4)
    : null;

  useEffect(() => {
    if (redeem.isSuccess) {
      toast.success('Withdrawal confirmed!');
      redeem.reset();
      setShares('');
      onSuccess();
    }
  }, [redeem.isSuccess]);

  useEffect(() => {
    if (redeem.error) {
      toast.error(`Withdrawal failed: ${redeem.error.message.slice(0, 100)}`);
      redeem.reset();
    }
  }, [redeem.error]);

  // Register tx in history store
  useEffect(() => {
    if (redeem.hash) addTx(redeem.hash, `Withdraw ${shares || '?'} shares`, tangleLocal.id);
  }, [redeem.hash]);

  const handleClick = () => {
    if (!shares || parseFloat(shares) <= 0) {
      toast.error('Enter a valid number of shares');
      return;
    }
    if (insufficientShares) {
      toast.error('Insufficient shares');
      return;
    }
    redeem.redeem(vaultAddress, shares, shareDecimals);
  };

  const isPending = redeem.isPending || redeem.isConfirming;

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : !isReady
    ? 'Switch to Tangle Local'
    : insufficientShares
    ? 'Insufficient Shares'
    : isPending
    ? 'Withdrawing...'
    : 'Withdraw';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="i-ph:arrow-up-right text-crimson-600 dark:text-crimson-400" />
          Withdraw
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <label className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
                Shares
              </label>
              {userSharesFormatted != null && (
                <button
                  type="button"
                  onClick={() => setShares(userSharesFormatted.toString())}
                  className="text-sm font-data text-arena-elements-textSecondary hover:text-violet-700 dark:hover:text-violet-400 transition-colors"
                >
                  Balance: {userSharesFormatted.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </button>
              )}
            </div>
            <Input
              type="number"
              placeholder="0.00"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              min="0"
              step="any"
            />
          </div>
          {valueReceived && (
            <div className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-crimson-500/5 border border-crimson-500/10">
              <span className="text-sm text-arena-elements-textSecondary font-data">You'll receive</span>
              <span className="text-base font-data font-bold text-arena-elements-textPrimary">
                ~{valueReceived} {assetSymbol}
              </span>
            </div>
          )}
          <Button
            onClick={handleClick}
            variant="outline"
            className="w-full"
            disabled={!isReady || isPending || insufficientShares || !shares}
          >
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
