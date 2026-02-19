import { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits } from 'viem';
import type { Address } from 'viem';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '@tangle/blueprint-ui/components';
import { toast } from 'sonner';
import { useApprove, useDeposit } from '~/lib/hooks/useVaultWrite';
import { addTx, selectedChainIdStore } from '@tangle/blueprint-ui';

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
  const { isConnected, chainId } = useAccount();
  const isReady = isConnected && chainId === selectedChainIdStore.get();
  const [amount, setAmount] = useState('');
  // Track that we just approved — skip needsApproval check until refetch completes
  const [justApproved, setJustApproved] = useState(false);

  const approve = useApprove();
  const deposit = useDeposit();

  const parsedAmount = amount && parseFloat(amount) > 0
    ? parseUnits(amount, assetDecimals)
    : 0n;

  // If we just approved, skip the allowance check until refetch completes
  const needsApproval = !justApproved && parsedAmount > 0n && (userAllowance ?? 0n) < parsedAmount;

  const sharesReceived = amount && parseFloat(amount) > 0 && sharePrice && sharePrice > 0
    ? (parseFloat(amount) / sharePrice).toFixed(4)
    : null;

  const insufficientBalance = parsedAmount > 0n && (userAssetBalance ?? 0n) < parsedAmount;

  // Reset justApproved when allowance updates (refetch completed)
  const prevAllowance = useRef(userAllowance);
  useEffect(() => {
    if (userAllowance !== prevAllowance.current) {
      prevAllowance.current = userAllowance;
      if (justApproved) setJustApproved(false);
    }
  }, [userAllowance, justApproved]);

  // Handle approval success — auto-proceed to deposit
  useEffect(() => {
    if (approve.isSuccess) {
      toast.success('Approval confirmed — depositing...');
      approve.reset();
      setJustApproved(true);
      onSuccess(); // refetch allowance

      // Auto-proceed to deposit
      if (amount && parseFloat(amount) > 0) {
        deposit.deposit(vaultAddress, amount, assetDecimals);
      }
    }
  }, [approve.isSuccess]);

  // Handle deposit success
  useEffect(() => {
    if (deposit.isSuccess) {
      toast.success('Deposit confirmed!');
      deposit.reset();
      setAmount('');
      setJustApproved(false);
      onSuccess();
    }
  }, [deposit.isSuccess]);

  // Handle errors
  useEffect(() => {
    if (approve.error) {
      toast.error(`Approval failed: ${approve.error.message.slice(0, 100)}`);
      approve.reset();
    }
    if (deposit.error) {
      toast.error(`Deposit failed: ${deposit.error.message.slice(0, 100)}`);
      deposit.reset();
    }
  }, [approve.error, deposit.error]);

  // Register txs in history store
  useEffect(() => {
    if (approve.hash) addTx(approve.hash, `Approve ${assetSymbol}`, selectedChainIdStore.get());
  }, [approve.hash, assetSymbol]);
  useEffect(() => {
    if (deposit.hash) addTx(deposit.hash, `Deposit ${amount || '?'} ${assetSymbol}`, selectedChainIdStore.get());
  }, [deposit.hash, assetSymbol]);

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
      approve.approve(assetToken, vaultAddress, parsedAmount);
    } else {
      deposit.deposit(vaultAddress, amount, assetDecimals);
    }
  };

  const isPending = approve.isPending || approve.isConfirming || deposit.isPending || deposit.isConfirming;

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : !isReady
    ? 'Switch to Tangle Local'
    : insufficientBalance
    ? 'Insufficient Balance'
    : isPending
    ? (approve.isPending || approve.isConfirming ? 'Approving...' : 'Depositing...')
    : needsApproval
    ? `Approve & Deposit ${assetSymbol}`
    : `Deposit ${assetSymbol}`;

  if (assetSymbol === '???') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="i-ph:arrow-down-right text-arena-elements-icon-success" />
            Deposit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center">
            <div className="i-ph:warning-circle text-2xl text-amber-600 dark:text-amber-400 mb-2 mx-auto" />
            <p className="text-sm text-arena-elements-textSecondary">
              Vault asset token not found on-chain.
            </p>
            <p className="text-xs text-arena-elements-textTertiary mt-1">
              The vault may still be initializing or the asset token is not deployed on this network.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="i-ph:arrow-down-right text-arena-elements-icon-success" />
          Deposit
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <label htmlFor="deposit-amount" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
                Amount ({assetSymbol})
              </label>
              {userAssetBalanceFormatted != null && (
                <button
                  type="button"
                  onClick={() => setAmount(userAssetBalanceFormatted.toString())}
                  className="text-sm font-data text-arena-elements-textSecondary hover:text-violet-700 dark:hover:text-violet-400 transition-colors"
                >
                  Balance: {userAssetBalanceFormatted.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </button>
              )}
            </div>
            <Input
              id="deposit-amount"
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min="0"
              step="any"
              className="text-base"
            />
          </div>
          {sharesReceived && (
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-emerald-700/5 dark:bg-emerald-500/5 border border-emerald-700/10 dark:border-emerald-500/10">
              <span className="text-sm text-arena-elements-textSecondary font-data">You'll receive</span>
              <span className="text-sm font-data font-bold text-arena-elements-icon-success">~{sharesReceived} shares</span>
            </div>
          )}
          <Button
            onClick={handleClick}
            className="w-full text-sm"
            disabled={!isReady || isPending || insufficientBalance || !amount}
          >
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
