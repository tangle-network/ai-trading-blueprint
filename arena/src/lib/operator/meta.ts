import { useQuery } from '@tanstack/react-query';

const DEFAULT_OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';
export const CLOUD_OPERATOR_API_URL =
  import.meta.env.VITE_CLOUD_OPERATOR_API_URL ?? DEFAULT_OPERATOR_API_URL;
export const INSTANCE_OPERATOR_API_URL =
  import.meta.env.VITE_INSTANCE_OPERATOR_API_URL ?? DEFAULT_OPERATOR_API_URL;
export const TEE_OPERATOR_API_URL =
  import.meta.env.VITE_TEE_OPERATOR_API_URL ?? INSTANCE_OPERATOR_API_URL;
export const OPERATOR_API_URL = CLOUD_OPERATOR_API_URL;

function normalizeOperatorApiUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parseOperatorApiUrls(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .map(normalizeOperatorApiUrl)
          .filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  return trimmed
    .split(/[,\n]/)
    .map(normalizeOperatorApiUrl)
    .filter(Boolean);
}

const EXTRA_OPERATOR_API_URLS = [
  ...parseOperatorApiUrls(import.meta.env.VITE_TRADING_OPERATOR_API_URLS),
  ...parseOperatorApiUrls(import.meta.env.VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS),
];

export const ALL_TRADING_OPERATOR_API_URLS = Array.from(
  new Set(
    [
      CLOUD_OPERATOR_API_URL,
      INSTANCE_OPERATOR_API_URL,
      TEE_OPERATOR_API_URL,
      ...EXTRA_OPERATOR_API_URLS,
    ]
      .map((url) => normalizeOperatorApiUrl(url))
      .filter(Boolean),
  ),
);
export const HAS_TRADING_OPERATOR_API = ALL_TRADING_OPERATOR_API_URLS.length > 0;

export type OperatorDeploymentKind = 'fleet' | 'instance';

export interface OperatorFeatures {
  chat: boolean;
  terminal: boolean;
}

export interface OperatorMeta {
  api_version: string;
  deployment_kind: OperatorDeploymentKind;
  features: OperatorFeatures;
}

const DEFAULT_META: OperatorMeta = {
  api_version: '1',
  deployment_kind: 'fleet',
  features: {
    chat: false,
    terminal: false,
  },
};

export function getOperatorApiUrlForBlueprint(
  blueprintType?: string,
): string {
  switch (blueprintType) {
    case 'trading-instance':
      return INSTANCE_OPERATOR_API_URL;
    case 'trading-tee-instance':
      return TEE_OPERATOR_API_URL;
    case 'trading-cloud':
    default:
      return CLOUD_OPERATOR_API_URL;
  }
}

export function getOperatorKindForBlueprint(
  blueprintType?: string,
): 'cloud' | 'instance' | 'tee' {
  switch (blueprintType) {
    case 'trading-tee-instance':
      return 'tee';
    case 'trading-instance':
      return 'instance';
    case 'trading-cloud':
    default:
      return 'cloud';
  }
}

export function getDeploymentKindForOperatorKind(
  operatorKind: 'cloud' | 'instance' | 'tee' | null | undefined,
): OperatorDeploymentKind {
  return operatorKind === 'cloud' ? 'fleet' : 'instance';
}

export function getExpectedDeploymentKindForBlueprint(
  blueprintType?: string,
): OperatorDeploymentKind {
  switch (blueprintType) {
    case 'trading-instance':
    case 'trading-tee-instance':
      return 'instance';
    case 'trading-cloud':
    default:
      return 'fleet';
  }
}

export function useOperatorMeta(apiUrl = OPERATOR_API_URL) {
  return useQuery<OperatorMeta>({
    queryKey: ['operator-meta', apiUrl],
    queryFn: async () => {
      if (!apiUrl) return DEFAULT_META;
      const res = await fetch(`${apiUrl}/api/meta`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`Failed to load operator metadata: ${res.status}`);
      }
      return res.json() as Promise<OperatorMeta>;
    },
    enabled: !!apiUrl,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function buildBotScopedPath(
  meta: OperatorMeta | undefined,
  botId: string | undefined,
  suffix = '',
): string {
  return buildBotScopedPathForDeploymentKind(meta?.deployment_kind, botId, suffix);
}

export function buildBotScopedPathForDeploymentKind(
  deploymentKind: OperatorDeploymentKind | undefined,
  botId: string | undefined,
  suffix = '',
): string {
  const tail = suffix.startsWith('/') || suffix.length === 0 ? suffix : `/${suffix}`;
  if (deploymentKind === 'instance') {
    return `/api/bot${tail}`;
  }
  if (!botId) {
    throw new Error('botId is required for fleet operator routes');
  }
  return `/api/bots/${encodeURIComponent(botId)}${tail}`;
}

export function isInstanceOperator(meta: OperatorMeta | undefined): boolean {
  return meta?.deployment_kind === 'instance';
}
