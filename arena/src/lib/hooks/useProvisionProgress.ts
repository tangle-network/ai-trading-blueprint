import { useQuery } from '@tanstack/react-query';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

export interface ProvisionProgress {
  call_id: number;
  service_id: number;
  phase: string;
  detail: string;
  bot_id: string | null;
  sandbox_id: string | null;
  started_at: number;
  updated_at: number;
}

/**
 * Polls the operator API for provision progress during active provisioning.
 * Returns the current phase and detail so the dashboard can show intermediate steps.
 */
export function useProvisionProgress(callId: number | undefined, enabled: boolean) {
  return useQuery<ProvisionProgress | null>({
    queryKey: ['provision-progress', callId],
    queryFn: async () => {
      if (!OPERATOR_API_URL || callId == null) return null;
      const res = await fetch(`${OPERATOR_API_URL}/api/provisions/${callId}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: enabled && !!OPERATOR_API_URL && callId != null,
    refetchInterval: 2_000,
  });
}

/**
 * Fetch all active provisions from the operator API.
 */
export function useProvisionsList(enabled: boolean) {
  return useQuery<ProvisionProgress[]>({
    queryKey: ['provisions-list'],
    queryFn: async () => {
      if (!OPERATOR_API_URL) return [];
      const res = await fetch(`${OPERATOR_API_URL}/api/provisions`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.provisions ?? [];
    },
    enabled: enabled && !!OPERATOR_API_URL,
    refetchInterval: 3_000,
  });
}

export { OPERATOR_API_URL };
