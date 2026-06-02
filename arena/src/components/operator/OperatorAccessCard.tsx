import { Button } from '@tangle-network/blueprint-ui/components';
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
    <div className="glass-card rounded-xl text-center py-16 px-6 text-arena-elements-textSecondary">
      <div className="i-ph:wallet text-4xl mb-4 mx-auto text-arena-elements-textTertiary" />
      <h3 className="font-display font-semibold text-xl text-arena-elements-textPrimary mb-2">
        {title}
      </h3>
      <p className="mx-auto max-w-2xl text-base mb-5">{description}</p>
      <Button
        onClick={() => { void authenticate(); }}
        disabled={isAuthenticating}
      >
        {isAuthenticating ? 'Authenticating…' : 'Authenticate'}
      </Button>
      {error && (
        <p className="mt-3 text-sm text-crimson-500">{error}</p>
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
    <div className="glass-card rounded-xl text-center py-16 px-6 text-arena-elements-textSecondary">
      <div className="i-ph:warning-circle text-4xl mb-4 mx-auto text-arena-elements-textTertiary" />
      <h3 className="font-display font-semibold text-xl text-arena-elements-textPrimary mb-2">
        {feature} unavailable
      </h3>
      <p className="mx-auto max-w-2xl text-base">
        This operator does not currently expose {feature.toLowerCase()} through the frontend contract.
      </p>
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
    <div className="glass-card rounded-xl p-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1">
        <div className="font-display font-semibold text-sm text-arena-elements-textPrimary">
          Sign once to load operator-managed data
        </div>
        <p className="text-sm text-arena-elements-textSecondary mt-1">
          Arena rankings, agent controls, and activation progress use operator-backed data and may stay unverified until the relevant operator session is established.
        </p>
        {error && (
          <p className="text-xs text-crimson-500 mt-2">{error}</p>
        )}
      </div>
      <Button
        onClick={() => { void authenticateAll(); }}
        disabled={isAuthenticating}
        size="sm"
      >
        {isAuthenticating ? 'Connecting…' : 'Authenticate'}
      </Button>
    </div>
  );
}
