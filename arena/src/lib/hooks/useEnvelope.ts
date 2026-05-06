/**
 * TanStack Query hooks for the v3 envelope CRUD endpoints.
 *
 *   GET    /envelope     → current SignedEnvelope (or null)
 *   PUT    /envelope     → store new envelope (verifies binding + nonce)
 *   DELETE /envelope     → clear stored envelope
 *
 * All routes are bot-scoped via the operator API's auth middleware.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignedEnvelope } from '~/lib/types/envelope';
import { useOperatorAuth } from './useOperatorAuth';
import {
  operatorFetchWithAuth,
  operatorJsonWithAuth,
  OperatorAuthRequiredError,
} from '~/lib/operator/fetch';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
  OPERATOR_API_URL,
} from '~/lib/operator/meta';
import type { BotOperatorKind } from '~/lib/types/bot';

type EnvelopeQueryKey = readonly ['envelope', string, string];

function envelopeQueryKey(botId: string, apiUrl: string): EnvelopeQueryKey {
  return ['envelope', botId, apiUrl] as const;
}

interface UseEnvelopeArgs {
  botId: string;
  operatorKind: BotOperatorKind | undefined;
  apiUrl?: string;
}

/** Read the current envelope for a bot. Returns `null` when none is stored. */
export function useEnvelope({ botId, operatorKind, apiUrl = OPERATOR_API_URL }: UseEnvelopeArgs) {
  const auth = useOperatorAuth(apiUrl);
  return useQuery<SignedEnvelope | null, Error, SignedEnvelope | null, EnvelopeQueryKey>({
    queryKey: envelopeQueryKey(botId, apiUrl),
    enabled: auth.isAuthenticated && botId.length > 0,
    queryFn: async () => {
      if (!auth.isAuthenticated) throw new OperatorAuthRequiredError();
      if (!operatorKind) throw new Error('Bot operator kind not yet resolved');
      const path = buildBotScopedPathForDeploymentKind(
        getDeploymentKindForOperatorKind(operatorKind),
        botId,
        '/envelope',
      );
      return operatorJsonWithAuth<SignedEnvelope | null>(apiUrl, path, auth);
    },
    staleTime: 15_000,
  });
}

/** PUT a freshly signed envelope. Resets the cached query on success. */
export function usePutEnvelope({ botId, operatorKind, apiUrl = OPERATOR_API_URL }: UseEnvelopeArgs) {
  const auth = useOperatorAuth(apiUrl);
  const qc = useQueryClient();
  return useMutation<SignedEnvelope, Error, SignedEnvelope>({
    mutationFn: async (envelope) => {
      if (!auth.isAuthenticated) throw new OperatorAuthRequiredError();
      if (!operatorKind) throw new Error('Bot operator kind not yet resolved');
      const path = buildBotScopedPathForDeploymentKind(
        getDeploymentKindForOperatorKind(operatorKind),
        botId,
        '/envelope',
      );
      const res = await operatorFetchWithAuth(apiUrl, path, auth, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PUT /envelope ${res.status}: ${text}`);
      }
      return res.json() as Promise<SignedEnvelope>;
    },
    onSuccess: (env) => {
      qc.setQueryData(envelopeQueryKey(botId, apiUrl), env);
    },
  });
}

/** DELETE the stored envelope. Optimistically clears the cache. */
export function useDeleteEnvelope({ botId, operatorKind, apiUrl = OPERATOR_API_URL }: UseEnvelopeArgs) {
  const auth = useOperatorAuth(apiUrl);
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!auth.isAuthenticated) throw new OperatorAuthRequiredError();
      if (!operatorKind) throw new Error('Bot operator kind not yet resolved');
      const path = buildBotScopedPathForDeploymentKind(
        getDeploymentKindForOperatorKind(operatorKind),
        botId,
        '/envelope',
      );
      const res = await operatorFetchWithAuth(apiUrl, path, auth, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new Error(`DELETE /envelope ${res.status}: ${text}`);
      }
    },
    onSuccess: () => {
      qc.setQueryData(envelopeQueryKey(botId, apiUrl), null);
    },
  });
}
