import { zeroAddress } from 'viem';
import type { TrackedProvision } from '~/lib/stores/provisions';
import type { Bot } from '~/lib/types/bot';

function normalizeAddress(address?: string): string | null {
  if (!address) return null;
  const normalized = address.toLowerCase();
  return normalized === zeroAddress ? null : normalized;
}

export function isInstanceProvision(provision: TrackedProvision): boolean {
  return provision.id.startsWith('instance-')
    || provision.blueprintType === 'trading-instance'
    || provision.blueprintType === 'trading-tee-instance';
}

export function doesProvisionMatchBot(provision: TrackedProvision, bot: Bot): boolean {
  if (provision.botId && provision.botId === bot.id) return true;

  if (provision.sandboxId && bot.sandboxId && provision.sandboxId === bot.sandboxId) {
    return true;
  }

  if (
    provision.callId != null
    && bot.callId != null
    && provision.serviceId != null
    && bot.serviceId > 0
    && provision.callId === bot.callId
    && provision.serviceId === bot.serviceId
  ) {
    return true;
  }

  const provisionVault = normalizeAddress(provision.vaultAddress);
  const botVault = normalizeAddress(bot.vaultAddress);
  if (provisionVault && botVault && provisionVault === botVault) {
    return true;
  }

  return false;
}

export function collectMatchedProvisionIds(
  provisions: TrackedProvision[],
  bots: Bot[],
): Set<string> {
  const matched = new Set<string>();

  for (const provision of provisions) {
    if (bots.some((bot) => doesProvisionMatchBot(provision, bot))) {
      matched.add(provision.id);
    }
  }

  return matched;
}

export function partitionProvisionsForBots(
  provisions: TrackedProvision[],
  bots: Bot[],
): {
  matched: TrackedProvision[];
  unresolved: TrackedProvision[];
} {
  const matchedIds = collectMatchedProvisionIds(provisions, bots);

  return {
    matched: provisions.filter((provision) => matchedIds.has(provision.id)),
    unresolved: provisions.filter((provision) => !matchedIds.has(provision.id)),
  };
}
