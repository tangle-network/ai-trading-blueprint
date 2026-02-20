export type { TradingBlueprintDef, ProvisionParams, StrategyPackDef } from './types';
export { strategyPacks, buildFullInstructions } from './strategy-packs';
export { tradingCloud } from './trading-cloud';
export { tradingInstance } from './trading-instance';
export { tradingTeeInstance } from './trading-tee-instance';

import { tradingCloud } from './trading-cloud';
import { tradingInstance } from './trading-instance';
import { tradingTeeInstance } from './trading-tee-instance';
import type { TradingBlueprintDef } from './types';

/** All registered trading blueprints. Filter out those with blueprintId '0' (not configured). */
export const TRADING_BLUEPRINTS: TradingBlueprintDef[] = [
  tradingCloud,
  tradingInstance,
  tradingTeeInstance,
].filter((b) => b.blueprintId !== '0');

/** Get a blueprint by ID, or the first available. */
export function getBlueprint(id: string): TradingBlueprintDef | undefined {
  return TRADING_BLUEPRINTS.find((b) => b.id === id);
}

/** All unique blueprint IDs (as bigints) for service discovery. */
export const ALL_BLUEPRINT_IDS: bigint[] = [
  ...new Set(TRADING_BLUEPRINTS.map((b) => BigInt(b.blueprintId))),
];
