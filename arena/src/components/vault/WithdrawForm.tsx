import { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import type { Address } from 'viem';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '@tangle-network/blueprint-ui/components';
import { toast } from 'sonner';
import { useRedeemInKind } from '~/lib/hooks/useVaultWrite';
import { erc20Abi, tradingVaultAbi } from '~/lib/contracts/abis';
import { getChainPublicClient } from '~/lib/contracts/chainClients';
import { addTx } from '@tangle-network/blueprint-ui';
import { formatNumber } from '~/lib/format';

interface WithdrawFormProps {
  vaultAddress: Address;
  assetSymbol: string;
  shareDecimals: number;
  userShares?: bigint;
  userSharesFormatted?: number;
  paused: boolean;
  targetChainId: number;
  targetChainName: string;
  onSuccess: () => void;
}

interface BasketPreviewItem {
  token: Address;
  symbol: string;
  amount: bigint;
  decimals: number;
}

export function WithdrawForm({
  vaultAddress,
  assetSymbol,
  shareDecimals,
  userShares,
  userSharesFormatted,
  paused,
  targetChainId,
  targetChainName,
  onSuccess,
}: WithdrawFormProps) {
  const { isConnected, chainId } = useAccount();
  const isReady = isConnected && chainId === targetChainId;
  const [shares, setShares] = useState('');
  const [basketPreview, setBasketPreview] = useState<BasketPreviewItem[]>([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const redeemInKind = useRedeemInKind();

  const sharesNumber = Number(shares);
  let parsedShares = 0n;
  let invalidShares = false;
  if (shares && Number.isFinite(sharesNumber) && sharesNumber > 0) {
    try {
      parsedShares = parseUnits(shares, shareDecimals);
    } catch {
      invalidShares = true;
    }
  } else if (shares) {
    invalidShares = true;
  }

  const insufficientShares = parsedShares > 0n && (userShares ?? 0n) < parsedShares;
  const maxSharesFormatted = userShares != null
    ? Number(formatUnits(userShares, shareDecimals))
    : userSharesFormatted;

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      if (parsedShares === 0n || invalidShares) {
        setBasketPreview([]);
        return;
      }
      setIsPreviewLoading(true);
      try {
        const client = getChainPublicClient(targetChainId);
        const result = await client.readContract({
          address: vaultAddress,
          abi: tradingVaultAbi,
          functionName: 'previewRedeemInKind',
          args: [parsedShares],
        }) as readonly [Address[], bigint[]];
        const [tokens, amounts] = result;
        const items = await Promise.all(tokens.map(async (token, index) => {
          let symbol = 'Asset';
          let decimals = 18;
          try {
            symbol = await client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }) as string;
          } catch {}
          try {
            decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }) as number;
          } catch {}
          return { token, symbol, amount: amounts[index] ?? 0n, decimals };
        }));
        if (!cancelled) setBasketPreview(items.filter((item) => item.amount > 0n));
      } catch {
        if (!cancelled) setBasketPreview([]);
      } finally {
        if (!cancelled) setIsPreviewLoading(false);
      }
    }
    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [invalidShares, parsedShares, targetChainId, vaultAddress]);

  // Track confirmation (isSuccess from useWaitForTransactionReceipt) via ref
  // to avoid firing the callback multiple times during re-renders.
  const confirmedRef = useRef(false);
  useEffect(() => {
    if (redeemInKind.isSuccess && !confirmedRef.current) {
      confirmedRef.current = true;
      toast.success('Withdrawal confirmed!');
      redeemInKind.reset();
      setShares('');
      onSuccess();
    }
    if (!redeemInKind.isSuccess) {
      confirmedRef.current = false;
    }
  }, [redeemInKind.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClick = () => {
    if (!shares || invalidShares || sharesNumber <= 0) {
      toast.error('Enter a valid number of shares');
      return;
    }
    if (!isReady) {
      toast.error(`Switch to ${targetChainName} first`);
      return;
    }
    if (paused) {
      toast.error('Vault is paused');
      return;
    }
    if (insufficientShares) {
      toast.error('Insufficient shares');
      return;
    }
    const callbacks = {
      onHash(h: `0x${string}`) {
        addTx(h, `Withdraw ${shares || '?'} shares as basket`, targetChainId);
      },
      onError(e: Error) {
        toast.error(`Withdrawal failed: ${e.message.slice(0, 100)}`);
        redeemInKind.reset();
      },
    };
    redeemInKind.redeemInKind(vaultAddress, shares, shareDecimals, targetChainId, callbacks);
  };

  const isPending = redeemInKind.isPending || redeemInKind.isConfirming;

  const buttonText = !isConnected
    ? 'Connect Wallet'
    : !isReady
    ? `Switch to ${targetChainName}`
    : paused
    ? 'Vault Paused'
    : invalidShares
    ? 'Invalid Shares'
    : insufficientShares
    ? 'Insufficient Shares'
    : isPending
    ? 'Withdrawing...'
    : 'Withdraw Basket';

  if (assetSymbol === '???') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="i-ph:arrow-up-right text-crimson-600 dark:text-crimson-400" />
            Withdraw
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center">
            <div className="i-ph:warning-circle text-2xl text-amber-600 dark:text-amber-400 mb-2 mx-auto" />
            <p className="text-sm text-arena-elements-textSecondary">
              Vault asset token not found on-chain.
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
          <div className="i-ph:arrow-up-right text-crimson-600 dark:text-crimson-400" />
          Withdraw
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <label htmlFor="withdraw-shares" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary">
                Shares
              </label>
              {maxSharesFormatted != null && (
                <button
                  type="button"
                  onClick={() => setShares(maxSharesFormatted.toString())}
                  className="text-sm font-data text-arena-elements-textSecondary hover:text-violet-700 dark:hover:text-violet-400 transition-colors"
                  aria-label="Set maximum withdrawal"
                >
                  Withdrawable: {formatNumber(maxSharesFormatted, { maximumFractionDigits: 4 })}
                </button>
              )}
            </div>
            <Input
              id="withdraw-shares"
              type="number"
              placeholder="0.00"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              min="0"
              step="any"
              disabled={isPending}
            />
          </div>
          <div className="rounded-lg border border-arena-border bg-arena-surface-muted/40 p-3">
            <div className="mb-2 flex items-center justify-between text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
              <span>Withdrawal Basket</span>
              {isPreviewLoading && <span>Loading...</span>}
            </div>
            {basketPreview.length > 0 ? (
              <div className="space-y-2">
                {basketPreview.map((item) => (
                  <div key={item.token} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-data text-arena-elements-textSecondary">{item.symbol}</span>
                    <span className="font-data font-semibold text-arena-elements-textPrimary">
                      {formatNumber(Number(formatUnits(item.amount, item.decimals)), { maximumFractionDigits: 6 })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-arena-elements-textSecondary">
                Enter shares to preview the assets you will receive.
              </div>
            )}
          </div>
          <Button
            onClick={handleClick}
            variant="outline"
            className="w-full"
            disabled={!isReady || isPending || invalidShares || insufficientShares || paused || !shares}
          >
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
