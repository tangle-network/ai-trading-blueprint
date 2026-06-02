import { zeroAddress } from 'viem';
import type { UserService } from '~/lib/hooks/useUserServices';
import type { TrackedProvision } from '~/lib/stores/provisions';
import type { Bot } from '~/lib/types/bot';
import { doesProvisionMatchBot } from './botProvisionReconciliation';

function normalizeAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return normalized === zeroAddress ? null : normalized;
}

export function isBotCallableByWallet(bot: Bot, walletAddress: string | undefined | null): boolean {
  const wallet = normalizeAddress(walletAddress);
  const submitter = normalizeAddress(bot.submitterAddress);

  return Boolean(wallet && submitter && wallet === submitter);
}

export function isBotCommandableByWallet(bot: Bot, walletAddress: string | undefined | null): boolean {
  if (!isBotCallableByWallet(bot, walletAddress)) return false;
  if (bot.source !== 'operator') return false;
  if (bot.verificationState === 'unverified') return false;
  return bot.status !== 'archived' && bot.status !== 'unknown';
}

export function isBotOwnedByWallet(
  bot: Bot,
  {
    walletAddress,
    services = [],
    provisions = [],
  }: {
    walletAddress: string | undefined | null;
    services?: Pick<UserService, 'serviceId' | 'vaultAddresses'>[];
    provisions?: TrackedProvision[];
  },
): boolean {
  if (isBotCallableByWallet(bot, walletAddress)) return true;
  const wallet = normalizeAddress(walletAddress);
  const operator = normalizeAddress(bot.operatorAddress);
  if (wallet && operator && wallet === operator) return true;

  const serviceIds = new Set(services.map((service) => service.serviceId));
  if (serviceIds.has(bot.serviceId)) return true;

  const serviceVaults = new Set(
    services.flatMap((service) =>
      service.vaultAddresses.map((address) => address.toLowerCase()),
    ),
  );
  const botVault = normalizeAddress(bot.vaultAddress);
  if (botVault && serviceVaults.has(botVault)) return true;

  return provisions.some((provision) =>
    provision.phase !== 'failed' && doesProvisionMatchBot(provision, bot),
  );
}
