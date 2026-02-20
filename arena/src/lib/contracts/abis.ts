// Core Tangle ABIs from shared package
export { tangleJobsAbi, tangleServicesAbi } from '@tangle/blueprint-ui';

// Arena-specific ABIs (stay local)
export const tradingVaultAbi = [
  { type: 'function', name: 'asset', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'share', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'totalAssets', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'convertToShares', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'convertToAssets', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxDeposit', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxRedeem', inputs: [{ name: 'owner_', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxWithdraw', inputs: [{ name: 'owner_', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'previewDeposit', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'previewRedeem', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'deposit', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ name: 'shares', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'redeem', inputs: [{ name: 'shares', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner_', type: 'address' }], outputs: [{ name: 'assets', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'paused', inputs: [], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'event', name: 'TradeExecuted', inputs: [{ name: 'target', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }, { name: 'outputGained', type: 'uint256', indexed: false }, { name: 'outputToken', type: 'address', indexed: false }, { name: 'intentHash', type: 'bytes32', indexed: true }], anonymous: false },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'name', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
] as const;

export const vaultFactoryAbi = [
  { type: 'function', name: 'getServiceVaults', inputs: [{ name: 'serviceId', type: 'uint64' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'getServiceVaultCount', inputs: [{ name: 'serviceId', type: 'uint64' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'serviceShares', inputs: [{ name: 'serviceId', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'vaultServiceId', inputs: [{ name: 'vault', type: 'address' }], outputs: [{ name: '', type: 'uint64' }], stateMutability: 'view' },
] as const;

export const tradingBlueprintAbi = [
  { type: 'function', name: 'estimateProvisionCost', inputs: [{ name: 'maxLifetimeDays', type: 'uint64' }, { name: 'cpuCores', type: 'uint64' }, { name: 'memoryMb', type: 'uint64' }], outputs: [{ name: 'cost', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'estimateExtendCost', inputs: [{ name: 'additionalDays', type: 'uint64' }], outputs: [{ name: 'cost', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceVault', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceShare', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'botVaults', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'callId', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'botShares', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'callId', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceProvisioned', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'dailyRate', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'event', name: 'BotVaultDeployed', inputs: [{ name: 'serviceId', type: 'uint64', indexed: true }, { name: 'callId', type: 'uint64', indexed: true }, { name: 'vault', type: 'address', indexed: false }, { name: 'shareToken', type: 'address', indexed: false }], anonymous: false },
] as const;
