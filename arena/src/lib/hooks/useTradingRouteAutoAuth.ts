import { useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useOperatorAuth } from './useOperatorAuth';
import {
  CLOUD_OPERATOR_API_URL,
  INSTANCE_OPERATOR_API_URL,
  TEE_OPERATOR_API_URL,
  useOperatorMeta,
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
  const cloudMeta = useOperatorMeta(CLOUD_OPERATOR_API_URL);
  const instanceMeta = useOperatorMeta(INSTANCE_OPERATOR_API_URL);
  const teeMeta = useOperatorMeta(TEE_OPERATOR_API_URL);
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
      {
        apiUrl: CLOUD_OPERATOR_API_URL,
        auth: cloudAuth,
        isAvailable: Boolean(CLOUD_OPERATOR_API_URL) && !!cloudMeta.data,
      },
      {
        apiUrl: INSTANCE_OPERATOR_API_URL,
        auth: instanceAuth,
        isAvailable: Boolean(INSTANCE_OPERATOR_API_URL) && !!instanceMeta.data,
      },
      {
        apiUrl: TEE_OPERATOR_API_URL,
        auth: teeAuth,
        isAvailable: Boolean(TEE_OPERATOR_API_URL) && !!teeMeta.data,
      },
    ];

    for (const target of targets) {
      if (!target.apiUrl || !target.isAvailable) continue;
      if (target.auth.token || target.auth.isAuthenticating) continue;

      const attemptKey = `${routeKey}:${address.toLowerCase()}:${target.apiUrl}`;
      if (attemptedKeysRef.current.has(attemptKey)) continue;

      attemptedKeysRef.current.add(attemptKey);
      void target.auth.authenticate();
    }
  }, [
    address,
    cloudAuth,
    cloudMeta.data,
    enabled,
    instanceAuth,
    instanceMeta.data,
    isConnected,
    routeKey,
    teeAuth,
    teeMeta.data,
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
