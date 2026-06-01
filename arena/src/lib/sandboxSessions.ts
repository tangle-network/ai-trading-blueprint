import type { Session } from '@tangle-network/sandbox-ui/types';

export function normalizeSessionList(value: unknown): Session[] {
  if (Array.isArray(value)) return value as Session[];
  if (!value || typeof value !== 'object') return [];

  const sessions = (value as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? (sessions as Session[]) : [];
}
