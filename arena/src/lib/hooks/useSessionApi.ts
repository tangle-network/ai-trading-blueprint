import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Session, Message } from '~/lib/types/session';

async function sessionFetch<T>(
  apiUrl: string,
  token: string,
  path: string,
  opts?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `API error: ${res.status}`);
  }
  return res.json();
}

export function useSessions(apiUrl: string, token: string | null) {
  return useQuery<Session[]>({
    queryKey: ['sessions', apiUrl, token],
    queryFn: () => sessionFetch<Session[]>(apiUrl, token!, '/session/sessions'),
    enabled: !!token,
    staleTime: 30_000,
  });
}

export function useMessages(apiUrl: string, token: string | null, sessionId: string) {
  return useQuery<Message[]>({
    queryKey: ['session-messages', apiUrl, token, sessionId],
    queryFn: async () => {
      const data = await sessionFetch<Message[] | { messages: Message[] }>(
        apiUrl,
        token!,
        `/session/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      return Array.isArray(data) ? data : data.messages ?? [];
    },
    enabled: !!token && !!sessionId,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useSendMessage(apiUrl: string, token: string | null, sessionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (text: string) => {
      return sessionFetch<Message>(apiUrl, token!, `/session/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          parts: [{ type: 'text', text }],
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['session-messages', apiUrl, token, sessionId],
      });
    },
  });
}

export function useAbortExecution(apiUrl: string, token: string | null, sessionId: string) {
  return useMutation({
    mutationFn: async () => {
      return sessionFetch<unknown>(apiUrl, token!, `/session/sessions/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
      });
    },
  });
}

export function useCreateSession(apiUrl: string, token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (title: string) => {
      return sessionFetch<Session>(apiUrl, token!, '/session/sessions', {
        method: 'POST',
        body: JSON.stringify({ title, backend: { type: 'opencode' } }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', apiUrl, token] });
    },
  });
}

export function useDeleteSession(apiUrl: string, token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      return sessionFetch<unknown>(apiUrl, token!, `/session/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', apiUrl, token] });
    },
  });
}

export function useRenameSession(apiUrl: string, token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, title }: { sessionId: string; title: string }) => {
      return sessionFetch<Session>(apiUrl, token!, `/session/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', apiUrl, token] });
    },
  });
}
