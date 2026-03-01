import { useWagmiSidecarAuth } from '@tangle/agent-ui';

interface OperatorAuth {
  token: string | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  authenticate: () => Promise<string | null>;
  clearCachedToken: () => void;
  error: string | null;
}

const OPERATOR_RESOURCE_ID = 'arena_operator';

export function useOperatorAuth(apiUrl: string): OperatorAuth {
  const auth = useWagmiSidecarAuth(OPERATOR_RESOURCE_ID, apiUrl);
  return {
    token: auth.token,
    isAuthenticated: auth.isAuthenticated,
    isAuthenticating: auth.isAuthenticating,
    authenticate: auth.authenticate,
    clearCachedToken: auth.clearCachedToken,
    error: auth.error,
  };
}
