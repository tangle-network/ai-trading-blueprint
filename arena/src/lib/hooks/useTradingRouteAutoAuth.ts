import { useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useOperatorAuth } from './useOperatorAuth';
import {
  CLOUD_OPERATOR_API_URL,
  INSTANCE_OPERATOR_API_URL,
  TEE_OPERATOR_API_URL,
} from '~/lib/operator/meta';

interface TradingRouteAutoAuthOptions {
  enabled: boolean;
  routeKey: string;
}

export function useTradingRouteAutoAuth({
  enabled,
  routeKey,
}: TradingRouteAutoAuthOptions) {
  const { address, isConnected } = useAccount();
  const cloudAuth = useOperatorAuth(CLOUD_OPERATOR_API_URL);
  const instanceAuth = useOperatorAuth(INSTANCE_OPERATOR_API_URL);
  const teeAuth = useOperatorAuth(TEE_OPERATOR_API_URL);
  const attemptedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isConnected || !address) {
      attemptedKeysRef.current.clear();
    }
  }, [address, isConnected]);

  const maybeAuthenticate = useCallback(() => {
    if (!enabled || !isConnected || !address) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    const targets = [
      { apiUrl: CLOUD_OPERATOR_API_URL, auth: cloudAuth },
      { apiUrl: INSTANCE_OPERATOR_API_URL, auth: instanceAuth },
      { apiUrl: TEE_OPERATOR_API_URL, auth: teeAuth },
    ];

    for (const target of targets) {
      if (!target.apiUrl) continue;
      if (target.auth.token || target.auth.isAuthenticating) continue;

      const attemptKey = `${routeKey}:${address.toLowerCase()}:${target.apiUrl}`;
      if (attemptedKeysRef.current.has(attemptKey)) continue;

      attemptedKeysRef.current.add(attemptKey);
      void target.auth.authenticate();
    }
  }, [
    address,
    cloudAuth,
    enabled,
    instanceAuth,
    isConnected,
    routeKey,
    teeAuth,
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
