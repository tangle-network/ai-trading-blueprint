import { useState, useCallback, useEffect, useRef } from 'react';
import { useSignMessage } from 'wagmi';

/**
 * Operator API session auth hook.
 *
 * Uses sandbox-runtime's challenge/response + PASETO token flow:
 * 1. POST /api/auth/challenge → { nonce, message, expires_at }
 * 2. Wallet signs `message` via EIP-191 personal_sign
 * 3. POST /api/auth/session { nonce, signature } → { token, address, expires_at }
 * 4. All subsequent requests use `Authorization: Bearer <token>`
 */

interface OperatorAuth {
  token: string | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  authenticate: () => Promise<string | null>;
  error: string | null;
}

const STORAGE_KEY = 'arena_operator_session';

function loadCachedToken(apiUrl: string): { token: string; expiresAt: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}__${apiUrl}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { token: string; expiresAt: number };
    // Discard if within 60s of expiry
    if (data.expiresAt * 1000 - Date.now() < 60_000) {
      localStorage.removeItem(`${STORAGE_KEY}__${apiUrl}`);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveToken(apiUrl: string, token: string, expiresAt: number) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_KEY}__${apiUrl}`, JSON.stringify({ token, expiresAt }));
  } catch {
    // ignore
  }
}

function clearToken(apiUrl: string) {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(`${STORAGE_KEY}__${apiUrl}`);
}

export function useOperatorAuth(apiUrl: string): OperatorAuth {
  const cached = loadCachedToken(apiUrl);
  const [token, setToken] = useState<string | null>(cached?.token ?? null);
  const [expiresAt, setExpiresAt] = useState<number>(cached?.expiresAt ?? 0);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const { signMessageAsync } = useSignMessage();

  const authenticate = useCallback(async (): Promise<string | null> => {
    if (!apiUrl) return null;
    setIsAuthenticating(true);
    setError(null);

    try {
      // 1. Get challenge
      const challengeRes = await fetch(`${apiUrl}/api/auth/challenge`, {
        method: 'POST',
      });
      if (!challengeRes.ok) {
        throw new Error(`Challenge failed: ${challengeRes.status}`);
      }
      const { nonce, message } = await challengeRes.json();

      // 2. Sign the challenge message
      const signature = await signMessageAsync({ message });

      // 3. Exchange for session token
      const sessionRes = await fetch(`${apiUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, signature }),
      });
      if (!sessionRes.ok) {
        const text = await sessionRes.text();
        throw new Error(text || `Session exchange failed: ${sessionRes.status}`);
      }

      const { token: newToken, expires_at } = await sessionRes.json();
      setToken(newToken);
      setExpiresAt(expires_at);
      saveToken(apiUrl, newToken, expires_at);
      return newToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed';
      setError(msg);
      setToken(null);
      setExpiresAt(0);
      clearToken(apiUrl);
      return null;
    } finally {
      setIsAuthenticating(false);
    }
  }, [apiUrl, signMessageAsync]);

  // Auto-refresh 5 minutes before expiry
  useEffect(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    if (!token || !expiresAt) return;

    const msUntilRefresh = (expiresAt - 300) * 1000 - Date.now();
    if (msUntilRefresh <= 0) {
      setToken(null);
      clearToken(apiUrl);
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      authenticate().catch(() => {
        setToken(null);
        clearToken(apiUrl);
      });
    }, msUntilRefresh);

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [token, expiresAt, authenticate, apiUrl]);

  return {
    token,
    isAuthenticated: token !== null,
    isAuthenticating,
    authenticate,
    error,
  };
}
