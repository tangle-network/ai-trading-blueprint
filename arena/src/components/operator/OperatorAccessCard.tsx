import { useStore } from '@nanostores/react';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { hydratedBotsStore } from '~/lib/stores/hydratedBots';
import {
  CLOUD_OPERATOR_API_URL,
  HAS_TRADING_OPERATOR_API,
  INSTANCE_OPERATOR_API_URL,
  OPERATOR_API_URL,
  TEE_OPERATOR_API_URL,
  useOperatorMeta,
} from '~/lib/operator/meta';

interface AuthTarget {
  apiUrl: string;
  auth: ReturnType<typeof useOperatorAuth>;
  isAvailable: boolean;
}

const operatorActionButtonClass = 'arena-command-link-primary inline-flex h-9 shrink-0 items-center justify-center gap-2 border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]';

export function OperatorAccessCard({
  title = 'Operator authentication required',
  description = 'Sign a message with your connected wallet to load operator-managed bot data.',
  apiUrl = OPERATOR_API_URL,
  apiUrls,
}: {
  title?: string;
  description?: string;
  apiUrl?: string;
  apiUrls?: string[];
}) {
  const operatorAuth = useOperatorAuth(apiUrl);
  const cloudAuth = useOperatorAuth(CLOUD_OPERATOR_API_URL);
  const instanceAuth = useOperatorAuth(INSTANCE_OPERATOR_API_URL);
  const teeAuth = useOperatorAuth(TEE_OPERATOR_API_URL);
  const cloudMeta = useOperatorMeta(CLOUD_OPERATOR_API_URL);
  const instanceMeta = useOperatorMeta(INSTANCE_OPERATOR_API_URL);
  const teeMeta = useOperatorMeta(TEE_OPERATOR_API_URL);
  const knownTargets: AuthTarget[] = [
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
  ].filter((target) => target.apiUrl);

  const selectedTargets = (() => {
    const dedupedApiUrls = Array.from(new Set((apiUrls ?? []).filter(Boolean)));
    if (dedupedApiUrls.length > 0) {
      return dedupedApiUrls.flatMap((url) => {
        const knownTarget = knownTargets.find((target) => target.apiUrl === url);
        if (!knownTarget) {
          return [{ apiUrl: url, auth: operatorAuth, isAvailable: true }];
        }
        return knownTarget.isAvailable ? [knownTarget] : [];
      });
    }
    if (!apiUrl) return [];
    const knownTarget = knownTargets.find((target) => target.apiUrl === apiUrl);
    if (!knownTarget) {
      return [{ apiUrl, auth: operatorAuth, isAvailable: true }];
    }
    return knownTarget.isAvailable ? [knownTarget] : [];
  })();
  const isAuthenticating = selectedTargets.some((target) => target.auth.isAuthenticating);
  const error = selectedTargets.find((target) => target.auth.error)?.auth.error ?? null;

  const authenticate = async () => {
    for (const target of selectedTargets) {
      if (target.auth.isAuthenticated || target.auth.isAuthenticating) continue;
      await target.auth.authenticate();
    }
  };

  return (
    <div className="arena-trace-terminal border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 py-3 text-[var(--arena-terminal-text)]">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-text-muted)]">
          <span className="i-ph:wallet text-lg" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-base font-semibold text-[var(--arena-terminal-text)]">
            {title}
          </h3>
          <p className="mt-0.5 max-w-[64rem] overflow-hidden text-sm leading-5 text-[var(--arena-terminal-text-muted)]">
            {description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void authenticate(); }}
          disabled={isAuthenticating || selectedTargets.length === 0}
          className={operatorActionButtonClass}
        >
          {isAuthenticating ? 'Authenticating…' : 'Authenticate'}
        </button>
      </div>
      {error && (
        <p className="mt-2 pl-0 font-data text-xs text-crimson-500 sm:pl-12">{error}</p>
      )}
    </div>
  );
}

export function UnsupportedFeatureCard({
  feature,
}: {
  feature: string;
}) {
  return (
    <div className="arena-trace-terminal border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 py-3 text-[var(--arena-terminal-text)]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-warning)]">
          <span className="i-ph:warning-circle text-lg" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-semibold text-[var(--arena-terminal-text)]">
            {feature} unavailable
          </h3>
          <p className="mt-0.5 overflow-hidden text-sm leading-5 text-[var(--arena-terminal-text-muted)]">
            This operator does not expose {feature.toLowerCase()}.
          </p>
        </div>
      </div>
    </div>
  );
}

export function OperatorSessionBanner() {
  const syncState = useStore(hydratedBotsStore);
  const cloudAuth = useOperatorAuth(CLOUD_OPERATOR_API_URL);
  const instanceAuth = useOperatorAuth(INSTANCE_OPERATOR_API_URL);
  const teeAuth = useOperatorAuth(TEE_OPERATOR_API_URL);
  const cloudMeta = useOperatorMeta(CLOUD_OPERATOR_API_URL);
  const instanceMeta = useOperatorMeta(INSTANCE_OPERATOR_API_URL);
  const teeMeta = useOperatorMeta(TEE_OPERATOR_API_URL);

  const authTargets = [
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
  ].filter((target) => target.apiUrl && target.isAvailable);

  if (!HAS_TRADING_OPERATOR_API || syncState.operatorDataState === 'ready') {
    return null;
  }

  const isAuthenticating = authTargets.some((target) => target.auth.isAuthenticating);
  const error = authTargets.find((target) => target.auth.error)?.auth.error ?? null;

  const authenticateAll = async () => {
    for (const target of authTargets) {
      if (target.auth.isAuthenticated || target.auth.isAuthenticating) continue;
      await target.auth.authenticate();
    }
  };

  return (
    <div className="arena-trace-terminal flex shrink-0 flex-col gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3 py-2 text-[var(--arena-terminal-text)] sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
          Operator session locked
        </div>
        {error && (
          <p className="mt-1 truncate text-xs text-crimson-500">{error}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => { void authenticateAll(); }}
        disabled={isAuthenticating}
        className={operatorActionButtonClass}
      >
        {isAuthenticating ? 'Connecting…' : 'Authenticate'}
      </button>
    </div>
  );
}
