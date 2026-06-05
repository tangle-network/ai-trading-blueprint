import type { TradingBlueprintDef } from './types';
import { resolveTradingBlueprintId } from './ids';
import { tradingInstance } from './trading-instance';

export const tradingTeeInstance: TradingBlueprintDef = {
  ...tradingInstance,
  id: 'trading-tee-instance',
  name: 'Trading Instance TEE',
  description: 'TEE-secured single bot — hardware-isolated execution for maximum security. Keys never leave the enclave.',
  icon: 'i-ph:shield-check',
  color: 'blue',
  blueprintId: resolveTradingBlueprintId(import.meta.env.VITE_TEE_BLUEPRINT_ID, '3'),
  isTee: true,
  defaults: {
    cpuCores: 2n,
    memoryMb: 4096n,
    maxLifetimeDays: 30n,
  },
};
