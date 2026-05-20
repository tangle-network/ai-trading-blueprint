import { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits, maxUint256, parseUnits } from 'viem';
import type { Address } from 'viem';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '@tangle-network/blueprint-ui/components';
import { toast } from 'sonner';
import { useApprove, useDeposit } from '~/lib/hooks/useVaultWrite';
import { addTx } from '@tangle-network/blueprint-ui';
import { formatNumber } from '~/lib/format';
import { ConfirmVaultActionDialog } from './ConfirmVaultActionDialog';

interface DepositFormProps {
  vaultAddress: Address;
  assetToken?: Address;
  assetSymbol: string;
  assetDecimals: number;
  sharePrice?: number;
  userAssetBalance?: bigint;
  userAssetBalanceFormatted?: number;
  userAllowance?: bigint;
  maxDeposit?: bigint;
  paused: boolean;
  targetChainId: number;
  targetChainName: string;
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
  maxDeposit,
  paused,
  targetChainId,
  targetChainName,
  onSuccess,
}: DepositFormProps) {
  const { isConnected, chainId } = useAccount();
  const isReady = isConnected && chainId === targetChainId;
  const [amount, setAmount] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingDepositAfterApprovalRef = useRef<{ amount: string } | null>(null);

  const approve = useApprove();
  const deposit = useDeposit();

  const amountNumber = Number(amount);
  let parsedAmount = 0n;
  let invalidAmount = false;
  if (amount && Number.isFinite(amountNumber) && amountNumber > 0) {
    try {
      parsedAmount = parseUnits(amount, assetDecimals);
    } catch {
      invalidAmount = true;
    }
  } else if (amount) {
    invalidAmount = true;
  }

  const needsApproval = parsedAmount > 0n && (userAllowance ?? 0n) < parsedAmount;
  const exceedsMaxDeposit = parsedAmount > 0n && maxDeposit != null && maxDeposit !== maxUint256 && parsedAmount > maxDeposit;
  const maxDepositFormatted = maxDeposit != null && maxDeposit !== maxUint256
    ? Number(formatUnits(maxDeposit, assetDecimals))
    : undefined;

  const sharesReceived = amount && !invalidAmount && amountNumber > 0 && sharePrice && sharePrice > 0
    ? formatNumber(amountNumber / sharePrice, { maximumFractionDigits: 4 })
    : null;

  const insufficientBalance = parsedAmount > 0n && (userAssetBalance ?? 0n) < parsedAmount;

  // Handle approval success — auto-proceed to deposit
  useEffect(() => {
    if (approve.isSuccess) {
      const approvedRequest = pendingDepositAfterApprovalRef.current;
      pendingDepositAfterApprovalRef.current = null;
      toast.success('Approval confirmed — depositing...');
      approve.reset();
      onSuccess(); // refetch allowance

      if (approvedRequest) {
        deposit.deposit(vaultAddress, approvedRequest.amount, assetDecimals, targetChainId);
      }
    }
  }, [approve.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (approve.error) {
      toast.error(`Approval failed: ${approve.error.message.slice(0, 100)}`);
      pendingDepositAfterApprovalRef.current = null;
      approve.reset();
    }
    if (deposit.error) {
      toast.error(`Deposit failed: ${deposit.error.message.slice(0, 100)}`);
      deposit.reset();
    }
  }, [approve.error, deposit.error]);

  // Register txs in history store
  useEffect(() => {
    if (approve.hash) addTx(approve.hash, `Approve ${assetSymbol}`, targetChainId);
  }, [approve.hash, assetSymbol, targetChainId]);
  useEffect(() => {
    if (deposit.hash) addTx(deposit.hash, `Deposit ${amount || '?'} ${assetSymbol}`, targetChainId);
  }, [deposit.hash, assetSymbol, targetChainId]);

  const validateSubmission = () => {
    if (!amount || invalidAmount || amountNumber <= 0) {
      toast.error('Enter a valid amount');
      return false;
    }
    if (!isReady) {
      toast.error(`Switch to ${targetChainName} first`);
      return false;
    }
    if (paused) {
      toast.error('Vault is paused');
      return false;
    }
    if (insufficientBalance) {
      toast.error('Insufficient balance');
      return false;
    }
    if (exceedsMaxDeposit) {
      toast.error('Amount is above this vault deposit limit');
      return false;
    }
    return true;
  };

  const submitDeposit = () => {
    if (needsApproval && assetToken) {
      pendingDepositAfterApprovalRef.current = { amount };
      approve.approve(assetToken, vaultAddress, parsedAmount, targetChainId);
    } else {
      deposit.deposit(vaultAddress, amount, assetDecimals, targetChainId);
    }
  };

  const handleClick = () => {
    if (!validateSubmission()) return;
    setConfirmOpen(true);
  };

  const isPending = approve.isPending || approve.isConfirming || deposit.isPending || deposit.isConfirming;

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : !isReady
    ? `Switch to ${targetChainName}`
    : paused
    ? 'Vault Paused'
    : invalidAmount
    ? 'Invalid Amount'
    : insufficientBalance
    ? 'Insufficient Balance'
    : exceedsMaxDeposit
    ? 'Above Deposit Limit'
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
    <>
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
                  aria-label="Set maximum deposit"
                >
                  Balance: {formatNumber(userAssetBalanceFormatted, { maximumFractionDigits: 4 })}
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
              disabled={isPending}
              className="text-base"
            />
          </div>
          {maxDepositFormatted != null && (
            <div className="text-xs text-arena-elements-textTertiary font-data">
              Max deposit: {formatNumber(maxDepositFormatted, { maximumFractionDigits: 4 })} {assetSymbol}
            </div>
          )}
          {sharesReceived && (
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-emerald-700/5 dark:bg-emerald-500/5 border border-emerald-700/10 dark:border-emerald-500/10">
              <span className="text-sm text-arena-elements-textSecondary font-data flex items-center gap-1.5">
                <div className="i-ph:arrow-right text-xs text-arena-elements-textTertiary" />
                You'll receive
              </span>
              <span className="text-sm font-data font-bold text-arena-elements-icon-success">~{sharesReceived} shares</span>
            </div>
          )}
          <Button
            onClick={handleClick}
            className="w-full text-sm"
            disabled={!isReady || isPending || invalidAmount || insufficientBalance || exceedsMaxDeposit || paused || !amount}
          >
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
    <ConfirmVaultActionDialog
      open={confirmOpen}
      title={needsApproval ? 'Confirm approval and deposit' : 'Confirm deposit'}
      description={`Submit ${amount || '0'} ${assetSymbol} to ${targetChainName}.`}
      confirmLabel={needsApproval ? 'Approve and deposit' : 'Deposit'}
      pending={isPending}
      onOpenChange={setConfirmOpen}
      onConfirm={() => {
        if (!validateSubmission()) {
          setConfirmOpen(false);
          return;
        }
        setConfirmOpen(false);
        submitDeposit();
      }}
    />
    </>
  );
}
