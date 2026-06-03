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

function isPromptLikeAgentName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length < 40) return false;
  return /^(i want|i need|build|create|make|deploy|launch)\b/.test(normalized)
    && /\b(agent|trade|trades|trading|yield|perp|prediction)\b/.test(normalized);
}

function isUnusableAgentName(name: string, strategyType?: string | null): boolean {
  return isFabricatedStrategyAgentName(name, strategyType) || isPromptLikeAgentName(name);
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
  if (preferredName && !isUnusableAgentName(preferredName, strategyType)) return preferredName;

  const secondaryName = normalizeName(fallbackName);
  if (secondaryName && !isUnusableAgentName(secondaryName, strategyType)) {
    return secondaryName;
  }

  return fallbackBotDisplayName(strategyType);
}
