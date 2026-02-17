import { useState, useCallback, useEffect, useRef } from 'react';
import { useSignMessage } from 'wagmi';

interface SessionAuth {
  token: string | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  authenticate: () => Promise<void>;
  error: string | null;
}

interface ChallengeResponse {
  challenge: string;
  nonce: string;
}

interface VerifyResponse {
  token: string;
  expires_at: number;
}

function sessionStorageKey(botId: string, apiUrl: string): string {
  return `arena_session_${botId}__${apiUrl}`;
}

function loadSession(botId: string, apiUrl: string): { token: string; expiresAt: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(sessionStorageKey(botId, apiUrl));
    if (!raw) return null;
    const data = JSON.parse(raw) as { token: string; expiresAt: number };
    // Discard if within 60s of expiry
    if (data.expiresAt * 1000 - Date.now() < 60_000) {
      localStorage.removeItem(sessionStorageKey(botId, apiUrl));
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveSession(botId: string, apiUrl: string, token: string, expiresAt: number) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(sessionStorageKey(botId, apiUrl), JSON.stringify({ token, expiresAt }));
  } catch {
    // storage full — ignore
  }
}

function clearSession(botId: string, apiUrl: string) {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(sessionStorageKey(botId, apiUrl));
}

export function useSessionAuth(botId: string, apiUrl: string): SessionAuth {
  const cached = loadSession(botId, apiUrl);
  const [token, setToken] = useState<string | null>(cached?.token ?? null);
  const [expiresAt, setExpiresAt] = useState<number>(cached?.expiresAt ?? 0);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const { signMessageAsync } = useSignMessage();

  const authenticate = useCallback(async () => {
    setIsAuthenticating(true);
    setError(null);

    try {
      // 1. Get challenge
      const challengeRes = await fetch(`${apiUrl}/session/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_id: botId }),
      });

      if (!challengeRes.ok) {
        throw new Error(`Challenge failed: ${challengeRes.status}`);
      }

      const { challenge, nonce }: ChallengeResponse = await challengeRes.json();

      // 2. Sign the challenge with wallet
      const signature = await signMessageAsync({ message: challenge });

      // 3. Verify the signature
      const verifyRes = await fetch(`${apiUrl}/session/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, signature }),
      });

      if (!verifyRes.ok) {
        const text = await verifyRes.text();
        throw new Error(text || `Verify failed: ${verifyRes.status}`);
      }

      const { token: newToken, expires_at }: VerifyResponse = await verifyRes.json();
      setToken(newToken);
      setExpiresAt(expires_at);
      saveSession(botId, apiUrl, newToken, expires_at);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setToken(null);
      setExpiresAt(0);
      clearSession(botId, apiUrl);
    } finally {
      setIsAuthenticating(false);
    }
  }, [botId, apiUrl, signMessageAsync]);

  // Auto-refresh token 5 minutes before expiry
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    if (!token || !expiresAt) return;

    const msUntilRefresh = (expiresAt - 300) * 1000 - Date.now();
    if (msUntilRefresh <= 0) {
      // Already expired or about to expire
      setToken(null);
      clearSession(botId, apiUrl);
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      authenticate().catch(() => {
        setToken(null);
        clearSession(botId, apiUrl);
      });
    }, msUntilRefresh);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [token, expiresAt, authenticate]);

  return {
    token,
    isAuthenticated: token !== null,
    isAuthenticating,
    authenticate,
    error,
  };
}
