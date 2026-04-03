import { Button } from '@tangle-network/blueprint-ui/components';
import { useStore } from '@nanostores/react';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { hydratedBotsStore } from '~/lib/stores/hydratedBots';
import {
  CLOUD_OPERATOR_API_URL,
  INSTANCE_OPERATOR_API_URL,
  OPERATOR_API_URL,
  TEE_OPERATOR_API_URL,
} from '~/lib/operator/meta';

export function OperatorAccessCard({
  title = 'Operator authentication required',
  description = 'Connect your wallet to load operator-managed bot data.',
  apiUrl = OPERATOR_API_URL,
}: {
  title?: string;
  description?: string;
  apiUrl?: string;
}) {
  const operatorAuth = useOperatorAuth(apiUrl);

  return (
    <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
      <div className="i-ph:wallet text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
      <h3 className="font-display font-semibold text-base text-arena-elements-textPrimary mb-2">
        {title}
      </h3>
      <p className="text-sm mb-4">{description}</p>
      <Button
        onClick={() => operatorAuth.authenticate()}
        disabled={operatorAuth.isAuthenticating}
      >
        {operatorAuth.isAuthenticating ? 'Connecting...' : 'Connect Wallet'}
      </Button>
      {operatorAuth.error && (
        <p className="mt-3 text-xs text-crimson-500">{operatorAuth.error}</p>
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
    <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
      <div className="i-ph:warning-circle text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
      <h3 className="font-display font-semibold text-base text-arena-elements-textPrimary mb-2">
        {feature} unavailable
      </h3>
      <p className="text-sm">
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

  const authTargets = [
    { apiUrl: CLOUD_OPERATOR_API_URL, auth: cloudAuth },
    { apiUrl: INSTANCE_OPERATOR_API_URL, auth: instanceAuth },
    { apiUrl: TEE_OPERATOR_API_URL, auth: teeAuth },
  ].filter((target) => target.apiUrl);

  if (!OPERATOR_API_URL || syncState.operatorDataState === 'ready') {
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
          Leaderboards, bot controls, and activation progress use operator-backed data and may stay unverified until the relevant operator session is established.
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
        {isAuthenticating ? 'Connecting...' : 'Authenticate'}
      </Button>
    </div>
  );
}
