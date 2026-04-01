import { useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useOperatorAuth } from './useOperatorAuth';

interface RouteOperatorAutoAuthOptions {
  enabled: boolean;
  routeKey: string;
  apiUrl: string;
}

/**
 * Route-scoped operator auto-auth.
 *
 * Passive operator reads should use cached tokens first. When a route actually
 * requires operator data and no token exists yet, this hook triggers a single
 * interactive wallet-auth attempt per mounted route/address pair.
 */
export function useRouteOperatorAutoAuth({
  enabled,
  routeKey,
  apiUrl,
}: RouteOperatorAutoAuthOptions) {
  const { address, isConnected } = useAccount();
  const operatorAuth = useOperatorAuth(apiUrl);
  const attemptedKeyRef = useRef<string | null>(null);

  const attemptKey = address ? `${routeKey}:${address.toLowerCase()}` : null;

  useEffect(() => {
    if (!isConnected || !attemptKey) {
      attemptedKeyRef.current = null;
      return;
    }

    if (
      attemptedKeyRef.current
      && attemptedKeyRef.current !== attemptKey
      && (!address || !attemptedKeyRef.current.endsWith(address.toLowerCase()))
    ) {
      attemptedKeyRef.current = null;
    }
  }, [address, attemptKey, isConnected]);

  const maybeAuthenticate = useCallback(() => {
    if (!enabled || !apiUrl || !isConnected || !attemptKey) return;
    if (operatorAuth.token || operatorAuth.isAuthenticating) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (attemptedKeyRef.current === attemptKey) return;

    attemptedKeyRef.current = attemptKey;
    void operatorAuth.authenticate();
  }, [
    apiUrl,
    attemptKey,
    enabled,
    isConnected,
    operatorAuth,
  ]);

  useEffect(() => {
    maybeAuthenticate();

    if (typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        maybeAuthenticate();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [maybeAuthenticate]);
}
