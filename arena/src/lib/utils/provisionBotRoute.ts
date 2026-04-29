import { isAddress, zeroAddress } from 'viem';
import type { TrackedProvision } from '~/lib/stores/provisions';

export function getProvisionBotRouteId(
  provision: Pick<TrackedProvision, 'botId' | 'vaultAddress' | 'sandboxId'>,
): string | undefined {
  if (provision.botId) return provision.botId;

  const vaultAddress = provision.vaultAddress?.toLowerCase();
  if (vaultAddress && isAddress(vaultAddress) && vaultAddress !== zeroAddress) {
    return vaultAddress;
  }

  return provision.sandboxId;
}
