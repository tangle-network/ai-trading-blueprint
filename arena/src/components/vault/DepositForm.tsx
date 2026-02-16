import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits } from 'viem';
import type { Address } from 'viem';
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { toast } from 'sonner';
import { useApprove, useDeposit } from '~/lib/hooks/useVaultWrite';

interface DepositFormProps {
  vaultAddress: Address;
  assetToken?: Address;
  assetSymbol: string;
  assetDecimals: number;
  sharePrice?: number;
  userAssetBalance?: bigint;
  userAssetBalanceFormatted?: number;
  userAllowance?: bigint;
  onSuccess: () => void;
}

export function DepositForm({
  vaultAddress,
  assetToken,
  assetSymbol,
  assetDecimals,
  sharePrice,
  userAssetBalance,
  userAssetBalanceFormatted,
  userAllowance,
  onSuccess,
}: DepositFormProps) {
  const { isConnected } = useAccount();
  const [amount, setAmount] = useState('');

  const approve = useApprove();
  const deposit = useDeposit();

  const parsedAmount = amount && parseFloat(amount) > 0
    ? parseUnits(amount, assetDecimals)
    : 0n;

  const needsApproval = parsedAmount > 0n && (userAllowance ?? 0n) < parsedAmount;

  const sharesReceived = amount && parseFloat(amount) > 0 && sharePrice && sharePrice > 0
    ? (parseFloat(amount) / sharePrice).toFixed(4)
    : null;

  const insufficientBalance = parsedAmount > 0n && (userAssetBalance ?? 0n) < parsedAmount;

  // Handle approval success
  useEffect(() => {
    if (approve.isSuccess) {
      toast.success('Approval confirmed');
      approve.reset();
      onSuccess(); // refetch allowance
    }
  }, [approve.isSuccess]);

  // Handle deposit success
  useEffect(() => {
    if (deposit.isSuccess) {
      toast.success('Deposit confirmed!');
      deposit.reset();
      setAmount('');
      onSuccess();
    }
  }, [deposit.isSuccess]);

  // Handle errors
  useEffect(() => {
    if (approve.error) toast.error(`Approval failed: ${approve.error.message.slice(0, 100)}`);
    if (deposit.error) toast.error(`Deposit failed: ${deposit.error.message.slice(0, 100)}`);
  }, [approve.error, deposit.error]);

  const handleClick = () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (insufficientBalance) {
      toast.error('Insufficient balance');
      return;
    }
    if (needsApproval && assetToken) {
      approve.approve(assetToken, vaultAddress);
    } else {
      deposit.deposit(vaultAddress, amount, assetDecimals);
    }
  };

  const isPending = approve.isPending || approve.isConfirming || deposit.isPending || deposit.isConfirming;

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : insufficientBalance
    ? 'Insufficient Balance'
    : isPending
    ? (approve.isPending || approve.isConfirming ? 'Approving...' : 'Depositing...')
    : needsApproval
    ? `Approve ${assetSymbol}`
    : `Deposit ${assetSymbol}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="i-ph:arrow-down-right text-emerald-400" />
          Deposit
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary">
                Amount ({assetSymbol})
              </label>
              {userAssetBalanceFormatted != null && (
                <button
                  type="button"
                  onClick={() => setAmount(userAssetBalanceFormatted.toString())}
                  className="text-[11px] font-data text-arena-elements-textTertiary hover:text-emerald-400 transition-colors"
                >
                  Balance: {userAssetBalanceFormatted.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </button>
              )}
            </div>
            <Input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min="0"
              step="any"
            />
          </div>
          {sharesReceived && (
            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
              <span className="text-xs text-arena-elements-textTertiary font-data">You'll receive</span>
              <span className="text-sm font-data font-bold text-emerald-400">~{sharesReceived} shares</span>
            </div>
          )}
          <Button
            onClick={handleClick}
            className="w-full"
            disabled={!isConnected || isPending || insufficientBalance || !amount}
          >
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
