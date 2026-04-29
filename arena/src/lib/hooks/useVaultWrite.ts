import { useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi';
import { parseUnits } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';

/** Approve the vault to spend exactly the requested amount of the asset token. */
export function useApprove() {
  const [receiptChainId, setReceiptChainId] = useState<number | undefined>();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: receiptChainId });

  function approve(tokenAddress: Address, spender: Address, amount: bigint, chainId: number) {
    setReceiptChainId(chainId);
    writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
      chainId,
    });
  }

  return { approve, hash, isPending, isConfirming, isSuccess, error, reset };
}

/** Deposit assets into the vault. */
export function useDeposit() {
  const { address: userAddress } = useAccount();
  const [receiptChainId, setReceiptChainId] = useState<number | undefined>();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: receiptChainId });

  function deposit(vaultAddress: Address, amount: string, decimals: number, chainId: number) {
    if (!userAddress) return;
    const parsed = parseUnits(amount, decimals);
    setReceiptChainId(chainId);
    writeContract({
      address: vaultAddress,
      abi: tradingVaultAbi,
      functionName: 'deposit',
      args: [parsed, userAddress],
      chainId,
    });
  }

  return { deposit, hash, isPending, isConfirming, isSuccess, error, reset };
}

interface RedeemCallbacks {
  onHash?: (hash: `0x${string}`) => void;
  onError?: (error: Error) => void;
}

/** Redeem shares from the vault (shares -> assets). */
export function useRedeem() {
  const { address: userAddress } = useAccount();
  const [receiptChainId, setReceiptChainId] = useState<number | undefined>();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: receiptChainId });

  function redeem(
    vaultAddress: Address,
    shares: string,
    shareDecimals: number,
    chainId: number,
    callbacks?: RedeemCallbacks,
  ) {
    if (!userAddress) return;
    const parsed = parseUnits(shares, shareDecimals);
    setReceiptChainId(chainId);
    writeContract(
      {
        address: vaultAddress,
        abi: tradingVaultAbi,
        functionName: 'redeem',
        args: [parsed, userAddress, userAddress],
        chainId,
      },
      {
        onSuccess(h) { callbacks?.onHash?.(h); },
        onError(e) { callbacks?.onError?.(e); },
      },
    );
  }

  return { redeem, hash, isPending, isConfirming, isSuccess, error, reset };
}
