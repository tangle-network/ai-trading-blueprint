import { encodeAbiParameters, parseAbiParameters, zeroAddress } from 'viem';
import type { TradingBlueprintDef, ProvisionParams } from './types';
import { strategyPacks } from './strategy-packs';
import { resolveTradingBlueprintId } from './ids';

function encodeProvision(params: ProvisionParams): `0x${string}` {
  return encodeAbiParameters(
    parseAbiParameters(
      '(string, string, string, string, address, address, address[], uint256, uint256, string, string, uint64, uint64, uint64, uint64[], uint256, uint8)',
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
        params.depositors.length >= 2 ? 2n : 1n,
        params.chainId,
        params.rpcUrl,
        params.cron,
        params.cpuCores,
        params.memoryMb,
        params.maxLifetimeDays,
        params.validatorServiceIds,
        params.maxCollateralBps,
        validationTrustToDiscriminant(params.validationTrust),
      ],
    ],
  );
}

function validationTrustToDiscriminant(value: ProvisionParams['validationTrust']): number {
  switch (value) {
    case 'envelope':
      return 1;
    case 'self_operated':
      return 2;
    default:
      return 0;
  }
}

export const tradingCloud: TradingBlueprintDef = {
  id: 'trading-cloud',
  name: 'Trading Cloud',
  description: 'Multi-instance fleet — deploy multiple trading bots per service. Best for operators managing a portfolio of strategies.',
  icon: 'i-ph:cloud',
  color: 'violet',
  blueprintId: resolveTradingBlueprintId(import.meta.env.VITE_BLUEPRINT_ID, '1'),
  isFleet: true,
  isTee: false,
  defaults: {
    cpuCores: 2n,
    memoryMb: 2048n,
    maxLifetimeDays: 30n,
  },
  strategyPacks,
  encodeProvision,
};
