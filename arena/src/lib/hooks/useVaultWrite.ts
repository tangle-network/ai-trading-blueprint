import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi';
import { parseUnits, maxUint256 } from 'viem';
import type { Address } from 'viem';
import { tradingVaultAbi, erc20Abi } from '~/lib/contracts/abis';
import { tangleLocal } from '~/lib/contracts/chains';

const chainId = tangleLocal.id;

/** Approve the vault to spend the asset token. */
export function useApprove() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function approve(tokenAddress: Address, spender: Address) {
    writeContract({
      chainId,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, maxUint256],
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
      chainId,
      address: vaultAddress,
      abi: tradingVaultAbi,
      functionName: 'deposit',
      args: [parsed, userAddress],
    });
  }

  return { deposit, hash, isPending, isConfirming, isSuccess, error, reset };
}

/** Redeem shares from the vault (shares → assets). */
export function useRedeem() {
  const { address: userAddress } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function redeem(vaultAddress: Address, shares: string, shareDecimals: number) {
    if (!userAddress) return;
    const parsed = parseUnits(shares, shareDecimals);
    writeContract({
      chainId,
      address: vaultAddress,
      abi: tradingVaultAbi,
      functionName: 'redeem',
      args: [parsed, userAddress, userAddress],
    });
  }

  return { redeem, hash, isPending, isConfirming, isSuccess, error, reset };
}
