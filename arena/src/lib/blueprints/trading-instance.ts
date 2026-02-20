import { encodeAbiParameters, parseAbiParameters } from 'viem';
import type { TradingBlueprintDef, ProvisionParams } from './types';
import { strategyPacks } from './strategy-packs';

function encodeProvision(params: ProvisionParams): `0x${string}` {
  // Instance uses the same ABI as cloud (TradingProvisionRequest is shared)
  return encodeAbiParameters(
    parseAbiParameters(
      '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[])',
    ),
    [
      [
        params.name,
        params.strategyType,
        JSON.stringify(params.strategyConfig),
        params.riskParams,
        params.vaultAddress,
        params.assetAddress,
        params.depositors,
        1n,
        params.chainId,
        params.rpcUrl,
        params.cron,
        params.cpuCores,
        params.memoryMb,
        params.maxLifetimeDays,
        params.validatorServiceIds,
      ],
    ],
  );
}

export const tradingInstance: TradingBlueprintDef = {
  id: 'trading-instance',
  name: 'Trading Instance',
  description: 'Single dedicated bot per service — one agent, one strategy, full focus. Best for individual traders.',
  icon: 'i-lucide-user',
  color: 'teal',
  blueprintId: import.meta.env.VITE_INSTANCE_BLUEPRINT_ID ?? '0',
  isFleet: false,
  isTee: false,
  defaults: {
    cpuCores: 2n,
    memoryMb: 2048n,
    maxLifetimeDays: 30n,
  },
  strategyPacks,
  encodeProvision,
};
