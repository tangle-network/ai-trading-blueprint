import { Button } from '@tangle/blueprint-ui/components';
import { OPERATOR_API_URL } from '~/lib/operator/meta';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';

export function OperatorAccessCard({
  title = 'Operator authentication required',
  description = 'Connect your wallet to load operator-managed bot data.',
}: {
  title?: string;
  description?: string;
}) {
  const operatorAuth = useOperatorAuth(OPERATOR_API_URL);

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
  const operatorAuth = useOperatorAuth(OPERATOR_API_URL);

  if (operatorAuth.isAuthenticated || !OPERATOR_API_URL) {
    return null;
  }

  return (
    <div className="glass-card rounded-xl p-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1">
        <div className="font-display font-semibold text-sm text-arena-elements-textPrimary">
          Sign once to load operator-managed data
        </div>
        <p className="text-sm text-arena-elements-textSecondary mt-1">
          Leaderboards, bot controls, and activation progress use the operator API and require a wallet session.
        </p>
      </div>
      <Button
        onClick={() => operatorAuth.authenticate()}
        disabled={operatorAuth.isAuthenticating}
        size="sm"
      >
        {operatorAuth.isAuthenticating ? 'Connecting...' : 'Authenticate'}
      </Button>
    </div>
  );
}
