import { Button } from '@tangle-network/blueprint-ui/components';
import { useStore } from '@nanostores/react';
import { selectedChainIdStore } from '@tangle-network/blueprint-ui';
import { useAccount } from 'wagmi';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { networks } from '~/lib/contracts/chains';
import { hydratedBotsStore } from '~/lib/stores/hydratedBots';
import {
  CLOUD_OPERATOR_API_URL,
  HAS_TRADING_OPERATOR_API,
  INSTANCE_OPERATOR_API_URL,
  OPERATOR_API_URL,
  TEE_OPERATOR_API_URL,
} from '~/lib/operator/meta';

interface AuthTarget {
  apiUrl: string;
  auth: ReturnType<typeof useOperatorAuth>;
}

function formatOperatorAuthError(error: string | null): string | null {
  if (!error) return null;
  if (error.includes('1003')) {
    return 'Operator auth is being blocked by the current gateway path. The app shell loaded, but the operator challenge endpoint is not reachable from this public origin yet.';
  }
  if (error.includes('Failed to fetch') || error.includes('Challenge failed')) {
    return 'Operator auth could not reach the live challenge endpoint. Verify the operator origin is reachable and the selected network matches the intended testnet.';
  }
  return error;
}

export function OperatorAccessCard({
  title = 'Operator authentication required',
  description = 'Connect your wallet to load operator-managed bot data.',
  apiUrl = OPERATOR_API_URL,
  apiUrls,
}: {
  title?: string;
  description?: string;
  apiUrl?: string;
  apiUrls?: string[];
}) {
  const { address } = useAccount();
  const operatorAuth = useOperatorAuth(apiUrl);
  const cloudAuth = useOperatorAuth(CLOUD_OPERATOR_API_URL);
  const instanceAuth = useOperatorAuth(INSTANCE_OPERATOR_API_URL);
  const teeAuth = useOperatorAuth(TEE_OPERATOR_API_URL);
  const knownTargets: AuthTarget[] = [
    { apiUrl: CLOUD_OPERATOR_API_URL, auth: cloudAuth },
    { apiUrl: INSTANCE_OPERATOR_API_URL, auth: instanceAuth },
    { apiUrl: TEE_OPERATOR_API_URL, auth: teeAuth },
  ].filter((target) => target.apiUrl);

  const selectedTargets = (() => {
    const dedupedApiUrls = Array.from(new Set((apiUrls ?? []).filter(Boolean)));
    if (dedupedApiUrls.length > 0) {
      return dedupedApiUrls.map((url) => (
        knownTargets.find((target) => target.apiUrl === url)
        ?? { apiUrl: url, auth: operatorAuth }
      ));
    }
    if (!apiUrl) return [];
    return [knownTargets.find((target) => target.apiUrl === apiUrl) ?? { apiUrl, auth: operatorAuth }];
  })();
  const isAuthenticating = selectedTargets.some((target) => target.auth.isAuthenticating);
  const error = formatOperatorAuthError(selectedTargets.find((target) => target.auth.error)?.auth.error ?? null);
  const selectedChainId = useStore(selectedChainIdStore);
  const currentNetwork = networks[selectedChainId];
  const ctaLabel = !address ? 'Connect wallet first' : isAuthenticating ? 'Connecting...' : 'Authenticate Wallet';

  const authenticate = async () => {
    if (!address) return;
    for (const target of selectedTargets) {
      if (target.auth.isAuthenticated || target.auth.isAuthenticating) continue;
      await target.auth.authenticate();
    }
  };

  return (
    <div className="glass-card rounded-2xl p-6 sm:p-7 text-arena-elements-textSecondary">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <div className="i-ph:wallet text-xl" />
          </div>
          <h3 className="font-display text-lg font-semibold text-arena-elements-textPrimary">
            {title}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed">
            {description}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-arena-elements-background-depth-3 px-3 py-1.5 text-[11px] font-data uppercase tracking-[0.18em] text-arena-elements-textSecondary">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {currentNetwork?.label ?? 'Unknown network'}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full bg-arena-elements-background-depth-3 px-3 py-1.5 text-[11px] font-data uppercase tracking-[0.18em] text-arena-elements-textSecondary">
              <span className={`h-1.5 w-1.5 rounded-full ${error ? 'bg-amber-500' : 'bg-violet-500'}`} />
              {error ? 'Operator challenge blocked' : 'Operator session required'}
            </span>
          </div>
          {error && (
            <p className="mt-4 max-w-2xl rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {error}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <Button
            onClick={() => { void authenticate(); }}
            disabled={isAuthenticating || !address}
            className="h-11 px-5"
          >
            {ctaLabel}
          </Button>
        </div>
      </div>
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

  if (!HAS_TRADING_OPERATOR_API || syncState.operatorDataState === 'ready') {
    return null;
  }

  const isAuthenticating = authTargets.some((target) => target.auth.isAuthenticating);
  const error = formatOperatorAuthError(authTargets.find((target) => target.auth.error)?.auth.error ?? null);

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
