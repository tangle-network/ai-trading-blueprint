// Minimal typed ABIs extracted from compiled Foundry artifacts.
// Only the functions/events the frontend actually calls.

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

export const tangleJobsAbi = [
  { type: 'function', name: 'submitJob', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'jobIndex', type: 'uint8' }, { name: 'inputs', type: 'bytes' }], outputs: [{ name: 'callId', type: 'uint64' }], stateMutability: 'payable' },
  { type: 'event', name: 'JobSubmitted', inputs: [{ name: 'serviceId', type: 'uint64', indexed: true }, { name: 'callId', type: 'uint64', indexed: true }, { name: 'jobIndex', type: 'uint8', indexed: true }, { name: 'caller', type: 'address', indexed: false }, { name: 'inputs', type: 'bytes', indexed: false }], anonymous: false },
  { type: 'event', name: 'JobCompleted', inputs: [{ name: 'serviceId', type: 'uint64', indexed: true }, { name: 'callId', type: 'uint64', indexed: true }], anonymous: false },
] as const;

export const tangleServicesAbi = [
  { type: 'function', name: 'requestService', inputs: [{ name: 'blueprintId', type: 'uint64' }, { name: 'operators', type: 'address[]' }, { name: 'config', type: 'bytes' }, { name: 'permittedCallers', type: 'address[]' }, { name: 'ttl', type: 'uint64' }, { name: 'paymentToken', type: 'address' }, { name: 'paymentAmount', type: 'uint256' }], outputs: [{ name: 'requestId', type: 'uint64' }], stateMutability: 'payable' },
  {
    type: 'function', name: 'createServiceFromQuotes',
    inputs: [
      { name: 'blueprintId', type: 'uint64' },
      { name: 'quotes', type: 'tuple[]', components: [
        { name: 'details', type: 'tuple', components: [
          { name: 'blueprintId', type: 'uint64' },
          { name: 'ttlBlocks', type: 'uint64' },
          { name: 'totalCost', type: 'uint256' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'expiry', type: 'uint64' },
          { name: 'securityCommitments', type: 'tuple[]', components: [
            { name: 'asset', type: 'tuple', components: [
              { name: 'kind', type: 'uint8' },
              { name: 'token', type: 'address' },
            ] },
            { name: 'exposureBps', type: 'uint16' },
          ] },
        ] },
        { name: 'signature', type: 'bytes' },
        { name: 'operator', type: 'address' },
      ] },
      { name: 'config', type: 'bytes' },
      { name: 'permittedCallers', type: 'address[]' },
      { name: 'ttl', type: 'uint64' },
    ],
    outputs: [{ name: 'serviceId', type: 'uint64' }],
    stateMutability: 'payable',
  },
  { type: 'function', name: 'getService', inputs: [{ name: 'serviceId', type: 'uint64' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'blueprintId', type: 'uint64' }, { name: 'owner', type: 'address' }, { name: 'permittedCallers', type: 'address[]' }, { name: 'operators', type: 'address[]' }, { name: 'ttl', type: 'uint64' }] }], stateMutability: 'view' },
  { type: 'function', name: 'isServiceActive', inputs: [{ name: 'serviceId', type: 'uint64' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getServiceOperators', inputs: [{ name: 'serviceId', type: 'uint64' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'isPermittedCaller', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'caller', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'event', name: 'ServiceRequested', inputs: [{ name: 'requester', type: 'address', indexed: true }, { name: 'requestId', type: 'uint64', indexed: true }, { name: 'blueprintId', type: 'uint64', indexed: true }], anonymous: false },
  { type: 'event', name: 'ServiceActivated', inputs: [{ name: 'serviceId', type: 'uint64', indexed: true }, { name: 'requestId', type: 'uint64', indexed: true }, { name: 'blueprintId', type: 'uint64', indexed: true }], anonymous: false },
] as const;

export const tangleOperatorsAbi = [
  { type: 'function', name: 'blueprintOperatorCount', inputs: [{ name: 'blueprintId', type: 'uint64' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isOperatorRegistered', inputs: [{ name: 'blueprintId', type: 'uint64' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getOperatorPreferences', inputs: [{ name: 'blueprintId', type: 'uint64' }, { name: 'operator', type: 'address' }], outputs: [{ name: 'preferences', type: 'tuple', components: [{ name: 'ecdsaPublicKey', type: 'bytes' }, { name: 'rpcAddress', type: 'string' }] }], stateMutability: 'view' },
  { type: 'event', name: 'OperatorRegistered', inputs: [{ name: 'blueprintId', type: 'uint64', indexed: true }, { name: 'operator', type: 'address', indexed: true }, { name: 'ecdsaPublicKey', type: 'bytes', indexed: false }, { name: 'rpcAddress', type: 'string', indexed: false }], anonymous: false },
  { type: 'event', name: 'OperatorUnregistered', inputs: [{ name: 'blueprintId', type: 'uint64', indexed: true }, { name: 'operator', type: 'address', indexed: true }], anonymous: false },
] as const;

export const tradingBlueprintAbi = [
  { type: 'function', name: 'estimateProvisionCost', inputs: [{ name: 'maxLifetimeDays', type: 'uint64' }, { name: 'cpuCores', type: 'uint64' }, { name: 'memoryMb', type: 'uint64' }], outputs: [{ name: 'cost', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceVault', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceShare', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceProvisioned', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
] as const;
