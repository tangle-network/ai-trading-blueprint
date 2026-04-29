import { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, isAddress } from 'viem';
import type { Address } from 'viem';
import { Button, Input } from '@tangle-network/blueprint-ui/components';
import { tradingVaultAbi } from '~/lib/contracts/abis';

interface CollateralAdminProps {
  vaultAddress: Address;
  assetDecimals: number;
  assetSymbol: string;
  maxCollateralBps?: number;
  targetChainId: number;
  targetChainName: string;
  onSuccess?: () => void;
}

export function CollateralAdmin({
  vaultAddress,
  assetDecimals,
  assetSymbol,
  maxCollateralBps,
  targetChainId,
  targetChainName,
  onSuccess,
}: CollateralAdminProps) {
  const { chainId } = useAccount();
  const [capPct, setCapPct] = useState(maxCollateralBps != null ? (maxCollateralBps / 100).toString() : '');
  const [writeDownOperator, setWriteDownOperator] = useState('');
  const [writeDownAmount, setWriteDownAmount] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const isReady = chainId === targetChainId;

  useEffect(() => {
    setCapPct(maxCollateralBps != null ? (maxCollateralBps / 100).toString() : '');
  }, [maxCollateralBps]);

  // setMaxCollateralBps
  const {
    writeContract: writeCap,
    data: capHash,
    isPending: capPending,
    error: capError,
    reset: capReset,
  } = useWriteContract();
  const { isLoading: capConfirming, isSuccess: capSuccess } = useWaitForTransactionReceipt({ hash: capHash, chainId: targetChainId });

  // writeDownCollateral
  const {
    writeContract: writeDown,
    data: wdHash,
    isPending: wdPending,
    error: wdError,
    reset: wdReset,
  } = useWriteContract();
  const { isLoading: wdConfirming, isSuccess: wdSuccess } = useWaitForTransactionReceipt({ hash: wdHash, chainId: targetChainId });

  function handleSetCap() {
    if (!isReady) {
      setValidationError(`Switch to ${targetChainName} first`);
      return;
    }
    const bps = Math.round(parseFloat(capPct) * 100);
    if (isNaN(bps) || bps < 0 || bps > 10000) {
      setValidationError('Collateral cap must be between 0 and 100');
      return;
    }
    setValidationError(null);
    writeCap({
      address: vaultAddress,
      abi: tradingVaultAbi,
      functionName: 'setMaxCollateralBps',
      args: [BigInt(bps)],
      chainId: targetChainId,
    });
  }

  function handleWriteDown() {
    if (!isReady) {
      setValidationError(`Switch to ${targetChainName} first`);
      return;
    }
    if (!writeDownOperator || !writeDownAmount) {
      setValidationError('Enter an operator and amount');
      return;
    }
    if (!isAddress(writeDownOperator)) {
      setValidationError('Enter a valid operator address');
      return;
    }
    let parsed: bigint;
    try {
      parsed = parseUnits(writeDownAmount, assetDecimals);
    } catch {
      setValidationError('Enter a valid write-down amount');
      return;
    }
    if (parsed <= 0n) {
      setValidationError('Write-down amount must be greater than 0');
      return;
    }
    setValidationError(null);
    writeDown({
      address: vaultAddress,
      abi: tradingVaultAbi,
      functionName: 'writeDownCollateral',
      args: [writeDownOperator as Address, parsed],
      chainId: targetChainId,
    });
  }

  // Trigger refetch on success (must be in useEffect to avoid render-loop)
  useEffect(() => {
    if (capSuccess) { onSuccess?.(); capReset(); }
  }, [capSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (wdSuccess) { onSuccess?.(); wdReset(); }
  }, [wdSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="glass-card rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="i-ph:shield-check text-base text-violet-700 dark:text-violet-400" />
        <span className="text-sm font-display font-semibold">Collateral Admin</span>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Set Collateral Cap */}
        <div>
          <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-1.5 block">
            Collateral Cap (%)
          </label>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="e.g. 20"
              value={capPct}
              onChange={(e) => setCapPct(e.target.value)}
              min={0}
              max={100}
              step={0.1}
            />
            <Button
              onClick={handleSetCap}
              disabled={!isReady || capPending || capConfirming || !capPct}
              size="sm"
            >
              {capPending ? 'Confirm...' : capConfirming ? 'Setting...' : 'Set'}
            </Button>
          </div>
          {capError && (
            <p className="text-xs text-crimson-500 mt-1">{capError.message.slice(0, 80)}</p>
          )}
          {validationError && (
            <p className="text-xs text-crimson-500 mt-1">{validationError}</p>
          )}
          <p className="text-xs text-arena-elements-textTertiary mt-1">
            Max % of vault NAV that can be released as CLOB collateral. 0 = disabled.
          </p>
        </div>

        {/* Write Down Collateral */}
        <div>
          <label className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-1.5 block">
            Write Down Loss
          </label>
          <div className="space-y-2">
            <Input
              type="text"
              placeholder="Operator address (0x...)"
              value={writeDownOperator}
              onChange={(e) => setWriteDownOperator(e.target.value)}
            />
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder={`Amount (${assetSymbol})`}
                value={writeDownAmount}
                onChange={(e) => setWriteDownAmount(e.target.value)}
                min={0}
                step={0.01}
              />
              <Button
                onClick={handleWriteDown}
                disabled={!isReady || wdPending || wdConfirming || !writeDownOperator || !writeDownAmount}
                size="sm"
                variant="outline"
              >
                {wdPending ? 'Confirm...' : wdConfirming ? 'Writing...' : 'Write Down'}
              </Button>
            </div>
          </div>
          {wdError && (
            <p className="text-xs text-crimson-500 mt-1">{wdError.message.slice(0, 80)}</p>
          )}
          <p className="text-xs text-arena-elements-textTertiary mt-1">
            Acknowledge a collateral loss for an operator. Reduces outstanding and vault NAV.
          </p>
        </div>
      </div>
    </div>
  );
}
