import type { Address } from 'viem';

export interface StrategyPackDef {
  id: string;
  name: string;
  providers: string[];
  description: string;
  cron: string;
  maxTurns: number;
  timeoutMs: number;
  expertKnowledge: string;
}

export interface TradingBlueprintDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: 'violet' | 'teal' | 'blue';
  blueprintId: string;
  /** True for cloud (multi-bot fleet), false for instance (single dedicated bot) */
  isFleet: boolean;
  /** TEE-secured variant */
  isTee: boolean;
  /** Default resource allocations */
  defaults: {
    cpuCores: bigint;
    memoryMb: bigint;
    maxLifetimeDays: bigint;
  };
  /** Strategy packs available for this blueprint (all share the same packs initially) */
  strategyPacks: StrategyPackDef[];
  /** Encode the provision job inputs for submitJob */
  encodeProvision: (params: ProvisionParams) => `0x${string}`;
}

export interface ProvisionParams {
  name: string;
  strategyType: string;
  strategyConfig: Record<string, unknown>;
  riskParams: string;
  vaultAddress: Address;
  assetAddress: Address;
  depositors: Address[];
  chainId: bigint;
  rpcUrl: string;
  cron: string;
  cpuCores: bigint;
  memoryMb: bigint;
  maxLifetimeDays: bigint;
  validatorServiceIds: bigint[];
}
