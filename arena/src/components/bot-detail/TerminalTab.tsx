import { lazy, Suspense } from 'react';
import { AuthBanner } from '~/components/bot-detail/AuthBanner';
import { useWagmiSidecarAuth } from '@tangle/blueprint-ui';
import { getApiUrlForBot } from '~/lib/config/botRegistry';

const TerminalView = lazy(() =>
  import('@tangle/agent-ui/terminal').then((m) => ({ default: m.TerminalView }))
);

interface TerminalTabProps {
  botId: string;
}

function LoadingSpinner() {
  return (
    <div className="glass-card rounded-xl flex items-center justify-center" style={{ height: 'calc(100vh - 400px)', minHeight: '400px' }}>
      <div className="text-center">
        <div className="i-ph:terminal-window text-3xl text-arena-elements-textTertiary mb-3 mx-auto animate-pulse" />
        <p className="text-sm text-arena-elements-textSecondary">Loading terminal...</p>
      </div>
    </div>
  );
}

export function TerminalTab({ botId }: TerminalTabProps) {
  const apiUrl = getApiUrlForBot(botId) ?? '';
  const { token, isAuthenticated, isAuthenticating, authenticate, error: authError } = useWagmiSidecarAuth(botId, apiUrl);

  if (!apiUrl) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:terminal-window text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No API configured for this bot. Terminal requires a running bot API.
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthBanner
        onAuth={authenticate}
        isAuthenticating={isAuthenticating}
        error={authError}
      />
    );
  }

  return (
    <div
      className="glass-card rounded-xl overflow-hidden"
      style={{ height: 'calc(100vh - 400px)', minHeight: '400px' }}
    >
      <Suspense fallback={<LoadingSpinner />}>
        <TerminalView
          apiUrl={apiUrl}
          token={token!}
          title="Trading Agent Terminal"
          subtitle="Connected to sidecar PTY session"
        />
      </Suspense>
    </div>
  );
}
