import { STRATEGY_NAMES } from '~/lib/format';

function normalizeName(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isFabricatedStrategyAgentName(name: string, strategyType?: string | null): boolean {
  const normalizedStrategyType = normalizeName(strategyType);
  if (!normalizedStrategyType) return false;
  return name.toLowerCase() === `${normalizedStrategyType} agent`.toLowerCase();
}

export function fallbackBotDisplayName(strategyType?: string | null): string {
  const normalizedStrategyType = normalizeName(strategyType);
  if (!normalizedStrategyType) return 'Agent';
  return STRATEGY_NAMES[normalizedStrategyType] ?? normalizedStrategyType;
}

export function resolveBotDisplayName({
  primaryName,
  fallbackName,
  strategyType,
}: {
  primaryName?: string | null;
  fallbackName?: string | null;
  strategyType?: string | null;
}): string {
  const preferredName = normalizeName(primaryName);
  if (preferredName) return preferredName;

  const secondaryName = normalizeName(fallbackName);
  if (secondaryName && !isFabricatedStrategyAgentName(secondaryName, strategyType)) {
    return secondaryName;
  }

  return fallbackBotDisplayName(strategyType);
}
