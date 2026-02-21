import { useSignMessage } from 'wagmi';
import { useSidecarAuth } from '@tangle/agent-ui';

/**
 * Thin adapter wiring wagmi's wallet signing to agent-ui's generic sidecar auth.
 */
export function useWagmiSidecarAuth(resourceId: string, apiUrl: string) {
  const { signMessageAsync } = useSignMessage();
  return useSidecarAuth({
    resourceId,
    apiUrl,
    signMessage: (msg: string) => signMessageAsync({ message: msg }),
  });
}
