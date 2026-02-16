import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import type { Address } from 'viem';
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { toast } from 'sonner';
import { useRedeem } from '~/lib/hooks/useVaultWrite';

interface WithdrawFormProps {
  vaultAddress: Address;
  assetSymbol: string;
  sharePrice?: number;
  userShares?: bigint;
  userSharesFormatted?: number;
  onSuccess: () => void;
}

export function WithdrawForm({
  vaultAddress,
  assetSymbol,
  sharePrice,
  userShares,
  userSharesFormatted,
  onSuccess,
}: WithdrawFormProps) {
  const { isConnected } = useAccount();
  const [shares, setShares] = useState('');
  const redeem = useRedeem();

  const parsedShares = shares && parseFloat(shares) > 0
    ? parseUnits(shares, 18)
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
    if (redeem.error) toast.error(`Withdrawal failed: ${redeem.error.message.slice(0, 100)}`);
  }, [redeem.error]);

  const handleClick = () => {
    if (!shares || parseFloat(shares) <= 0) {
      toast.error('Enter a valid number of shares');
      return;
    }
    if (insufficientShares) {
      toast.error('Insufficient shares');
      return;
    }
    redeem.redeem(vaultAddress, shares);
  };

  const isPending = redeem.isPending || redeem.isConfirming;

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : insufficientShares
    ? 'Insufficient Shares'
    : isPending
    ? 'Withdrawing...'
    : 'Withdraw';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="i-ph:arrow-up-right text-crimson-400" />
          Withdraw
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
                Shares
              </label>
              {userSharesFormatted != null && (
                <button
                  type="button"
                  onClick={() => setShares(userSharesFormatted.toString())}
                  className="text-[11px] font-data text-arena-elements-textTertiary hover:text-emerald-400 transition-colors"
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
            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-crimson-500/5 border border-crimson-500/10">
              <span className="text-xs text-arena-elements-textTertiary font-data">You'll receive</span>
              <span className="text-sm font-data font-bold text-arena-elements-textSecondary">
                ~{valueReceived} {assetSymbol}
              </span>
            </div>
          )}
          <Button
            onClick={handleClick}
            variant="outline"
            className="w-full"
            disabled={!isConnected || isPending || insufficientShares || !shares}
          >
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
