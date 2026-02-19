import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi';
import { parseUnits } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';

/** Approve the vault to spend exactly the requested amount of the asset token. */
export function useApprove() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function approve(tokenAddress: Address, spender: Address, amount: bigint) {
    writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    });
  }

  return { approve, hash, isPending, isConfirming, isSuccess, error, reset };
}

/** Deposit assets into the vault. */
export function useDeposit() {
  const { address: userAddress } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function deposit(vaultAddress: Address, amount: string, decimals: number) {
    if (!userAddress) return;
    const parsed = parseUnits(amount, decimals);
    writeContract({
      address: vaultAddress,
      abi: tradingVaultAbi,
      functionName: 'deposit',
      args: [parsed, userAddress],
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
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function redeem(
    vaultAddress: Address,
    shares: string,
    shareDecimals: number,
    callbacks?: RedeemCallbacks,
  ) {
    if (!userAddress) return;
    const parsed = parseUnits(shares, shareDecimals);
    writeContract(
      {
        address: vaultAddress,
        abi: tradingVaultAbi,
        functionName: 'redeem',
        args: [parsed, userAddress, userAddress],
      },
      {
        onSuccess(h) { callbacks?.onHash?.(h); },
        onError(e) { callbacks?.onError?.(e); },
      },
    );
  }

  return { redeem, hash, isPending, isConfirming, isSuccess, error, reset };
}
