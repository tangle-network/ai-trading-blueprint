import { useAccount } from 'wagmi';
import { Button } from '@tangle/blueprint-ui/components';

interface AuthBannerProps {
  onAuth: () => void;
  isAuthenticating: boolean;
  error: string | null;
}

export function AuthBanner({ onAuth, isAuthenticating, error }: AuthBannerProps) {
  const { isConnected } = useAccount();

  return (
    <div className="glass-card rounded-xl p-6 text-center">
      <div className="i-ph:lock-key text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
      <h3 className="font-display font-semibold text-lg mb-2">Authenticate to continue</h3>
      <p className="text-sm text-arena-elements-textSecondary mb-4">
        {isConnected
          ? 'Sign a message to verify you own this bot.'
          : 'Connect your wallet to interact with this bot\'s agent.'}
      </p>
      {error && (
        <p className="text-sm text-crimson-400 mb-3">{error}</p>
      )}
      <Button
        onClick={onAuth}
        disabled={!isConnected || isAuthenticating}
        variant="default"
      >
        {isAuthenticating ? (
          <>
            <span className="i-ph:arrow-clockwise text-sm animate-spin mr-1.5" />
            Signing...
          </>
        ) : isConnected ? (
          <>
            <span className="i-ph:signature text-sm mr-1.5" />
            Connect &amp; Sign
          </>
        ) : (
          'Connect Wallet First'
        )}
      </Button>
    </div>
  );
}
