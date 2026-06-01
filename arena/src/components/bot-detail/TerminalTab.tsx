import { OperatorTerminalView } from '~/components/operator/OperatorTerminalView';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import type { BotOperatorKind, BotVerificationState } from '~/lib/types/bot';

interface TerminalTabProps {
  botId: string;
  botName: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  verificationState?: BotVerificationState;
}

export function TerminalTab({
  botId,
  botName,
  operatorApiUrl,
  operatorKind,
  verificationState,
}: TerminalTabProps) {
  const baseApiUrl = operatorApiUrl ?? '';
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
  const resourcePath = baseApiUrl
    ? buildBotScopedPathForDeploymentKind(deploymentKind, botId)
    : '';
  const { token, isAuthenticated } = useOperatorAuth(baseApiUrl);

  if (!baseApiUrl || !operatorKind) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:terminal-window text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        Terminal is not ready yet for this operator.
      </div>
    );
  }

  if (verificationState === 'unverified') {
    return (
      <OperatorAccessCard
        title="Terminal unavailable"
        description="Live shell access stays disabled until this bot has been freshly verified against the operator."
        apiUrl={baseApiUrl}
      />
    );
  }

  if (!isAuthenticated || !token) {
    return (
      <OperatorAccessCard
        title="Owner-only terminal"
        description="The live shell is hidden unless the connected wallet owns this bot. Sign with the owner wallet to inspect logs and processes."
        apiUrl={baseApiUrl}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl border border-arena-elements-dividerColor/70 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-semibold text-arena-elements-textPrimary">
              Operator Terminal
            </h3>
            <p className="mt-1 text-sm text-arena-elements-textSecondary">
              Inspect logs, verify processes, and debug {botName} from the live sidecar shell.
            </p>
          </div>
          <div className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
            {deploymentKind === 'fleet' ? 'Cloud relay' : 'Instance relay'}
          </div>
        </div>
      </div>

      <OperatorTerminalView
        apiUrl={baseApiUrl}
        resourcePath={resourcePath}
        token={token}
        title={`${botName} shell`}
        subtitle="Secure shell via trading operator relay"
      />
    </div>
  );
}
