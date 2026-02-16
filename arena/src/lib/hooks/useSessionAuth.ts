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

export function useSessionAuth(botId: string, apiUrl: string): SessionAuth {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setToken(null);
      setExpiresAt(0);
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
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      authenticate().catch(() => {
        setToken(null);
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
