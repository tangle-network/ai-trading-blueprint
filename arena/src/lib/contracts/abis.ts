// Core Tangle ABIs from shared package
import { tangleJobsAbi as sharedTangleJobsAbi } from '@tangle-network/blueprint-ui';

export const tangleJobsAbi = sharedTangleJobsAbi;

// Keep the service ABI local until the published shared package catches up with
// the current pricing-engine quote tuple.
export const tangleServicesAbi = [
  {
    type: 'function',
    name: 'requestService',
    inputs: [
      { name: 'blueprintId', type: 'uint64' },
      { name: 'operators', type: 'address[]' },
      { name: 'config', type: 'bytes' },
      { name: 'permittedCallers', type: 'address[]' },
      { name: 'ttl', type: 'uint64' },
      { name: 'paymentToken', type: 'address' },
      { name: 'paymentAmount', type: 'uint256' },
    ],
    outputs: [{ name: 'requestId', type: 'uint64' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'createServiceFromQuotes',
    inputs: [
      { name: 'blueprintId', type: 'uint64' },
      {
        name: 'quotes',
        type: 'tuple[]',
        components: [
          {
            name: 'details',
            type: 'tuple',
            components: [
              { name: 'blueprintId', type: 'uint64' },
              { name: 'ttlBlocks', type: 'uint64' },
              { name: 'totalCost', type: 'uint256' },
              { name: 'timestamp', type: 'uint64' },
              { name: 'expiry', type: 'uint64' },
              { name: 'confidentiality', type: 'uint8' },
              {
                name: 'securityCommitments',
                type: 'tuple[]',
                components: [
                  {
                    name: 'asset',
                    type: 'tuple',
                    components: [
                      { name: 'kind', type: 'uint8' },
                      { name: 'token', type: 'address' },
                    ],
                  },
                  { name: 'exposureBps', type: 'uint16' },
                ],
              },
              {
                name: 'resourceCommitments',
                type: 'tuple[]',
                components: [
                  { name: 'kind', type: 'uint8' },
                  { name: 'count', type: 'uint64' },
                ],
              },
            ],
          },
          { name: 'signature', type: 'bytes' },
          { name: 'operator', type: 'address' },
        ],
      },
      { name: 'config', type: 'bytes' },
      { name: 'permittedCallers', type: 'address[]' },
      { name: 'ttl', type: 'uint64' },
    ],
    outputs: [{ name: 'serviceId', type: 'uint64' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'getService',
    inputs: [{ name: 'serviceId', type: 'uint64' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'blueprintId', type: 'uint64' },
          { name: 'owner', type: 'address' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'ttl', type: 'uint64' },
          { name: 'terminatedAt', type: 'uint64' },
          { name: 'lastPaymentAt', type: 'uint64' },
          { name: 'operatorCount', type: 'uint32' },
          { name: 'minOperators', type: 'uint32' },
          { name: 'maxOperators', type: 'uint32' },
          { name: 'membership', type: 'uint8' },
          { name: 'pricing', type: 'uint8' },
          { name: 'status', type: 'uint8' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isServiceActive',
    inputs: [{ name: 'serviceId', type: 'uint64' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getServiceOperators',
    inputs: [{ name: 'serviceId', type: 'uint64' }],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isPermittedCaller',
    inputs: [
      { name: 'serviceId', type: 'uint64' },
      { name: 'caller', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'ServiceRequested',
    inputs: [
      { name: 'requestId', type: 'uint64', indexed: true },
      { name: 'blueprintId', type: 'uint64', indexed: true },
      { name: 'requester', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ServiceActivated',
    inputs: [
      { name: 'serviceId', type: 'uint64', indexed: true },
      { name: 'requestId', type: 'uint64', indexed: true },
      { name: 'blueprintId', type: 'uint64', indexed: true },
    ],
  },
] as const;

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
  // Collateral views
  { type: 'function', name: 'totalOutstandingCollateral', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'operatorCollateral', inputs: [{ name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxCollateralBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'availableCollateral', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // Collateral admin
  { type: 'function', name: 'setMaxCollateralBps', inputs: [{ name: 'bps', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'writeDownCollateral', inputs: [{ name: 'operator_', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // Access control
  { type: 'function', name: 'DEFAULT_ADMIN_ROLE', inputs: [], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'hasRole', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  // Events
  { type: 'event', name: 'TradeExecuted', inputs: [{ name: 'target', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }, { name: 'outputGained', type: 'uint256', indexed: false }, { name: 'outputToken', type: 'address', indexed: false }, { name: 'intentHash', type: 'bytes32', indexed: true }], anonymous: false },
  { type: 'event', name: 'CollateralReleased', inputs: [{ name: 'operator', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'recipient', type: 'address', indexed: true }, { name: 'intentHash', type: 'bytes32', indexed: true }], anonymous: false },
  { type: 'event', name: 'CollateralReturned', inputs: [{ name: 'operator', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'credited', type: 'uint256', indexed: false }], anonymous: false },
  { type: 'event', name: 'CollateralWrittenDown', inputs: [{ name: 'operator', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }], anonymous: false },
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
  { type: 'function', name: 'instanceVault', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceShare', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'botVaults', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'callId', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'botShares', inputs: [{ name: 'serviceId', type: 'uint64' }, { name: 'callId', type: 'uint64' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'instanceProvisioned', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getDefaultJobRates', inputs: [{ name: 'baseRate', type: 'uint256' }], outputs: [{ name: 'jobIndexes', type: 'uint8[]' }, { name: 'rates', type: 'uint256[]' }], stateMutability: 'pure' },
  { type: 'function', name: 'getJobPriceMultiplier', inputs: [{ name: 'jobId', type: 'uint8' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'pure' },
  { type: 'event', name: 'BotVaultDeployed', inputs: [{ name: 'serviceId', type: 'uint64', indexed: true }, { name: 'callId', type: 'uint64', indexed: true }, { name: 'vault', type: 'address', indexed: false }, { name: 'shareToken', type: 'address', indexed: false }], anonymous: false },
] as const;
