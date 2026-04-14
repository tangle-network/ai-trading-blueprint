import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

interface OperatorSession {
  token: string;
  expiresAt: number;
}

interface OperatorAuthState {
  session: OperatorSession | null;
  inflight: Promise<string | null> | null;
  isAuthenticating: boolean;
  error: string | null;
}

interface OperatorAuth {
  token: string | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  authCacheKey: string | null;
  authenticate: () => Promise<string | null>;
  clearCachedToken: () => void;
  error: string | null;
  getCachedToken: () => string | null;
  getToken: (forceRefresh?: boolean) => Promise<string | null>;
}

const EMPTY_STATE: OperatorAuthState = {
  session: null,
  inflight: null,
  isAuthenticating: false,
  error: null,
};

const authRegistry = new Map<string, OperatorAuthState>();
const authListeners = new Map<string, Set<() => void>>();
const SESSION_STORAGE_PREFIX = 'arena.operator_auth.';

function isMissingWagmiProviderError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'WagmiProviderNotFoundError' ||
    error.message.includes('WagmiProvider')
  );
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function makeCacheKey(address: string, baseUrl: string): string {
  return `${normalizeAddress(address)}::${baseUrl}`;
}

function getPersistedSessionKey(key: string): string {
  return `${SESSION_STORAGE_PREFIX}${key}`;
}

function isSessionValid(session: OperatorSession | null): session is OperatorSession {
  if (!session) return false;
  return session.expiresAt * 1000 > Date.now() + 60_000;
}

function getState(key: string): OperatorAuthState {
  return authRegistry.get(key) ?? EMPTY_STATE;
}

function setState(key: string, next: OperatorAuthState) {
  authRegistry.set(key, next);
  persistSession(key, next.session);
  authListeners.get(key)?.forEach((listener) => listener());
}

function subscribeToKey(key: string, listener: () => void): () => void {
  const listeners = authListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  authListeners.set(key, listeners);
  return () => {
    const current = authListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      authListeners.delete(key);
    }
  };
}

function clearPersistedSession(key: string) {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.removeItem(getPersistedSessionKey(key));
  } catch {
    // Best-effort cleanup only.
  }
}

function readPersistedSession(key: string): OperatorSession | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(getPersistedSessionKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OperatorSession>;
    if (typeof parsed?.token !== 'string' || typeof parsed?.expiresAt !== 'number') {
      clearPersistedSession(key);
      return null;
    }
    const session = {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
    };
    if (!isSessionValid(session)) {
      clearPersistedSession(key);
      return null;
    }
    return session;
  } catch {
    clearPersistedSession(key);
    return null;
  }
}

function persistSession(key: string, session: OperatorSession | null) {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    if (session && isSessionValid(session)) {
      window.sessionStorage.setItem(getPersistedSessionKey(key), JSON.stringify(session));
    } else {
      window.sessionStorage.removeItem(getPersistedSessionKey(key));
    }
  } catch {
    // Best-effort persistence only.
  }
}

export function useOperatorAuth(apiUrl: string): OperatorAuth {
  let address: string | undefined;
  let signMessageAsync: ReturnType<typeof useSignMessage>['signMessageAsync'] | undefined;

  try {
    ({ address } = useAccount());
  } catch (error) {
    if (!isMissingWagmiProviderError(error)) throw error;
  }

  try {
    ({ signMessageAsync } = useSignMessage());
  } catch (error) {
    if (!isMissingWagmiProviderError(error)) throw error;
  }

  const cacheKey = address ? makeCacheKey(address, apiUrl) : null;

  const subscribe = useCallback((listener: () => void) => {
    if (!cacheKey) return () => {};
    return subscribeToKey(cacheKey, listener);
  }, [cacheKey]);

  const getSnapshot = useCallback(() => {
    if (!cacheKey) return EMPTY_STATE;
    return getState(cacheKey);
  }, [cacheKey]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const persistedSession = cacheKey ? readPersistedSession(cacheKey) : null;
  const effectiveSession = isSessionValid(state.session) ? state.session : persistedSession;

  useEffect(() => {
    if (!cacheKey || !persistedSession) return;
    const current = getState(cacheKey);
    if (isSessionValid(current.session) || current.inflight || current.isAuthenticating) {
      return;
    }
    setState(cacheKey, {
      ...current,
      session: persistedSession,
      error: null,
    });
  }, [cacheKey, persistedSession]);

  const getCachedToken = useCallback((): string | null => {
    return effectiveSession?.token ?? null;
  }, [effectiveSession?.token]);

  const clearCachedToken = useCallback(() => {
    if (!cacheKey) return;
    setState(cacheKey, EMPTY_STATE);
    clearPersistedSession(cacheKey);
  }, [cacheKey]);

  const getToken = useCallback(async (forceRefresh = false): Promise<string | null> => {
    if (!address || !cacheKey || !apiUrl || !signMessageAsync) return null;

    const current = getState(cacheKey);
    if (!forceRefresh && isSessionValid(current.session)) return current.session.token;
    if (!forceRefresh) {
      const persisted = readPersistedSession(cacheKey);
      if (persisted) {
        setState(cacheKey, {
          ...current,
          session: persisted,
          inflight: null,
          isAuthenticating: false,
          error: null,
        });
        return persisted.token;
      }
    }
    if (current.inflight) return current.inflight;
    if (forceRefresh) {
      setState(cacheKey, { ...current, session: null, error: null });
    }

    const promise = (async () => {
      try {
        const challengeRes = await fetch(`${apiUrl}/api/auth/challenge`, {
          method: 'POST',
        });
        if (!challengeRes.ok) {
          throw new Error(`Challenge failed: ${await challengeRes.text()}`);
        }

        const { message, nonce } = await challengeRes.json();
        const signature = await signMessageAsync({ message });

        const sessionRes = await fetch(`${apiUrl}/api/auth/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce, signature }),
        });
        if (!sessionRes.ok) {
          throw new Error(`Session creation failed: ${await sessionRes.text()}`);
        }

        const { token, expires_at } = await sessionRes.json();
        setState(cacheKey, {
          session: { token, expiresAt: expires_at },
          inflight: null,
          isAuthenticating: false,
          error: null,
        });
        return token as string;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Auth failed';
        setState(cacheKey, {
          ...getState(cacheKey),
          session: null,
          inflight: null,
          isAuthenticating: false,
          error: message,
        });
        return null;
      }
    })();

    setState(cacheKey, {
      ...getState(cacheKey),
      inflight: promise,
      isAuthenticating: true,
      error: null,
    });

    return promise;
  }, [address, apiUrl, cacheKey, signMessageAsync]);

  return {
    authCacheKey: cacheKey,
    token: effectiveSession?.token ?? null,
    isAuthenticated: effectiveSession !== null,
    isAuthenticating: state.isAuthenticating,
    authenticate: () => getToken(false),
    clearCachedToken,
    error: state.error,
    getCachedToken,
    getToken,
  };
}
