import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Card, CardContent } from '@tangle-network/blueprint-ui/components';
import { zeroAddress } from 'viem';
import { removeProvision, type TrackedProvision } from '~/lib/stores/provisions';
import type { TradingBlueprintDef, StrategyPackDef } from '~/lib/blueprints';
import type { ServiceInfo } from '~/routes/provision/types';
import { PROVISION_PROGRESS_LABELS, cronToHuman, formatCost } from '~/routes/provision/types';
import { TimelineStage, ElapsedTime } from './TimelineStage';
import { getProvisionBotRouteId } from '~/lib/utils/provisionBotRoute';

interface DeployStepProps {
  isInstance: boolean;
  latestDeployment: TrackedProvision | undefined;
  txHash: `0x${string}` | undefined;
  selectedBlueprint: TradingBlueprintDef | undefined;
  selectedPack: StrategyPackDef;
  name: string;
  effectiveCron: string;
  serviceId: string;
  serviceInfo: ServiceInfo | null;
  selectedOperators: Set<string>;
  isConnected: boolean;
  isPending: boolean;
  isNewServicePending: boolean;
  newServiceDeploying: boolean;
  instanceProvisioning: boolean;
  instanceProvisionError: string | null;
  isQuoting: boolean;
  quotes: Array<{ operator: string; totalCost: bigint; details: { totalCost: bigint } }>;
  totalCost: bigint;
  handleSubmit: () => void;
  handleDeployNewService: () => void;
  setShowInfra: (v: boolean) => void;
  refetchQuotes: () => void;
  setStep: (s: 'configure' | 'deploy' | 'secrets') => void;
  goBack: () => void;
  resetTx: () => void;
}

function SummaryRow({
  label,
  value,
  valueClassName = 'text-arena-elements-textPrimary',
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <>
      <span className="text-arena-elements-textTertiary">{label}</span>
      <span className={valueClassName}>{value}</span>
    </>
  );
}

function ProvisionReviewShell({
  eyebrow,
  title,
  description,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-none border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] shadow-none">
      <CardContent className="grid gap-0 p-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4 p-5">
          <div>
            <span className="block font-data text-sm uppercase tracking-wider text-arena-elements-textSecondary">
              {eyebrow}
            </span>
            <h2 className="mt-2 font-display text-xl font-semibold text-arena-elements-textPrimary">
              {title}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-arena-elements-textTertiary">
              {description}
            </p>
          </div>
          {children}
        </div>
        <aside className="border-t border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-5 lg:border-l lg:border-t-0">
          {summary}
        </aside>
      </CardContent>
    </Card>
  );
}

export function DeployStep({
  isInstance,
  latestDeployment,
  txHash,
  selectedBlueprint,
  selectedPack,
  name,
  effectiveCron,
  serviceId,
  serviceInfo,
  selectedOperators,
  isConnected,
  isPending,
  isNewServicePending,
  newServiceDeploying,
  instanceProvisioning,
  instanceProvisionError,
  isQuoting,
  quotes,
  totalCost,
  handleSubmit,
  handleDeployNewService,
  setShowInfra,
  refetchQuotes,
  setStep,
  goBack,
  resetTx,
}: DeployStepProps) {
  const botRouteId = latestDeployment
    ? getProvisionBotRouteId(latestDeployment)
    : undefined;
  const hasServiceBlocker =
    !serviceInfo?.isActive ||
    !serviceInfo?.isPermitted ||
    serviceInfo?.blueprintMismatch;
  const instanceActivationDisabled =
    !isConnected ||
    isNewServicePending ||
    newServiceDeploying ||
    instanceProvisioning;
  const instanceActivationLabel = !isConnected
    ? 'Connect Wallet'
    : isNewServicePending
      ? 'Confirm in Wallet...'
      : newServiceDeploying
        ? 'Waiting for Service Activation...'
        : instanceProvisioning
          ? 'Provisioning Instance Bot...'
          : `Activate Instance (${formatCost(totalCost)})`;
  const runtimeSubmitLabel = !isConnected
    ? 'Connect Wallet'
    : serviceInfo?.blueprintMismatch
      ? `Wrong Blueprint (service uses #${serviceInfo.blueprintId})`
      : !serviceInfo?.isActive
        ? 'Service Not Active'
        : !serviceInfo?.isPermitted
          ? 'Not Permitted on Service'
          : isPending
            ? 'Confirm in Wallet...'
            : 'Provision Runtime';

  return (
    <>
      {/* Instance blueprint: create service -> auto-provision */}
      {isInstance && !latestDeployment && (
        <ProvisionReviewShell
          eyebrow="Activate Instance"
          title="Create an operator-managed paper agent"
          description="This submits the service request, binds the vault route, and starts the sidecar that can run this agent profile under the selected operator."
          summary={(
            <div className="space-y-3">
              <div className="font-display text-sm font-semibold text-arena-elements-textPrimary">
                Request summary
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm font-data">
                <SummaryRow label="Blueprint" value={selectedBlueprint?.name ?? 'Instance'} />
                <SummaryRow label="Agent" value={name} />
                <SummaryRow label="Adapter" value={selectedPack.name} />
                <SummaryRow label="Frequency" value={`Every ${cronToHuman(effectiveCron)}`} />
                <SummaryRow
                  label="Operators"
                  value={
                    selectedOperators.size > 0
                      ? `${selectedOperators.size} selected`
                      : 'None — select in Infrastructure Settings'
                  }
                />
              </div>
            </div>
          )}
        >
          <div className="space-y-3">
            {selectedOperators.size === 0 && (
              <div className="border border-[color-mix(in_srgb,var(--arena-terminal-warning)_36%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_10%,var(--arena-terminal-panel))] p-3 text-sm text-arena-elements-textSecondary">
                Pick at least one operator before activation.
              </div>
            )}

            {selectedOperators.size === 0 && (
              <Button
                variant="outline"
                onClick={() => setShowInfra(true)}
                className="w-full"
              >
                Select Operators
              </Button>
            )}

            {selectedOperators.size > 0 && quotes.length === 0 && !isQuoting && (
              <Button
                variant="outline"
                onClick={() => {
                  setShowInfra(true);
                  refetchQuotes();
                }}
                className="w-full"
              >
                Get Operator Quotes
              </Button>
            )}

            {isQuoting && (
              <div className="text-center text-sm text-arena-elements-textTertiary animate-pulse py-2">
                Fetching operator quotes...
              </div>
            )}

            {quotes.length > 0 && (
              <Button
                onClick={handleDeployNewService}
                className="w-full"
                size="lg"
                disabled={instanceActivationDisabled}
              >
                {instanceActivationLabel}
              </Button>
            )}

            {instanceProvisionError && (
              <div className="text-sm text-crimson-400 p-3 bg-crimson-500/5 border border-crimson-500/20">
                {instanceProvisionError}
              </div>
            )}
          </div>
        </ProvisionReviewShell>
      )}

      {/* Fleet blueprint: standard submitJob flow */}
      {!isInstance && !txHash && (
        <ProvisionReviewShell
          eyebrow="Provision Runtime"
          title="Submit this agent profile to the active service"
          description={`This sends the job to Service ${serviceId}. The operator provisions the sidecar and starts the agent with the selected mandate, cadence, and runtime config.`}
          summary={(
            <div className="space-y-3">
              <div className="font-display text-sm font-semibold text-arena-elements-textPrimary">
                Request summary
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm font-data">
                <SummaryRow label="Service" value={`#${serviceId}`} />
                <SummaryRow label="Agent" value={name} />
                <SummaryRow label="Adapter" value={selectedPack.name} />
                <SummaryRow label="Frequency" value={`Every ${cronToHuman(effectiveCron)}`} />
                <SummaryRow
                  label="On-chain call"
                  value={`submitJob(serviceId=${serviceId}, jobIndex=0, ...)`}
                  valueClassName="text-arena-elements-textPrimary font-data text-xs"
                />
              </div>
            </div>
          )}
        >
          <div className="space-y-3">
            {hasServiceBlocker && (
              <div className="border border-[color-mix(in_srgb,var(--arena-terminal-warning)_36%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_10%,var(--arena-terminal-panel))] p-3 text-sm text-arena-elements-textSecondary">
                The selected service must be active, permitted, and attached to the chosen blueprint before the wallet call can proceed.
              </div>
            )}
            <Button
              onClick={handleSubmit}
              className="w-full"
              size="lg"
              disabled={!isConnected || isPending || hasServiceBlocker}
            >
              {runtimeSubmitLabel}
            </Button>
          </div>
        </ProvisionReviewShell>
      )}

      {txHash && (
        <Card className="overflow-hidden rounded-none border-arena-elements-borderColor/60 bg-[var(--arena-terminal-surface)] shadow-none">
          <CardContent className="pt-5 pb-5 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                {latestDeployment && !['active', 'awaiting_secrets', 'failed'].includes(latestDeployment.phase) && (
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                )}
                {latestDeployment?.phase === 'awaiting_secrets' && (
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                )}
                {latestDeployment?.phase === 'active' && (
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                )}
                {latestDeployment?.phase === 'failed' && (
                  <div className="w-2 h-2 rounded-full bg-crimson-400" />
                )}
                <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                  Agent Provisioning
                </span>
              </div>
              {latestDeployment && !['active', 'awaiting_secrets', 'failed'].includes(latestDeployment.phase) && (
                <ElapsedTime since={latestDeployment.createdAt} />
              )}
            </div>

            {/* Vertical timeline */}
            <div className="relative pl-7">
              {/* Connecting line */}
              <div className="absolute left-[8px] top-[8px] bottom-[8px] w-px bg-arena-elements-borderColor/60 overflow-hidden">
                {latestDeployment && ['pending_confirmation', 'job_submitted', 'job_processing'].includes(latestDeployment.phase) && (
                  <div className="absolute inset-0 w-full animate-shimmer bg-gradient-to-b from-transparent via-amber-400/50 to-transparent" style={{ backgroundSize: '100% 200%' }} />
                )}
                {latestDeployment && ['awaiting_secrets', 'active'].includes(latestDeployment.phase) && (
                  <div className="absolute inset-0 w-full bg-gradient-to-b from-emerald-400/40 to-emerald-400/10" />
                )}
              </div>

              <TimelineStage
                label="Transaction Sent"
                description="Waiting for your submitJob transaction to be confirmed on-chain"
                status={
                  latestDeployment?.phase === 'pending_confirmation'
                    ? 'active'
                    : latestDeployment?.phase === 'job_submitted' ||
                        latestDeployment?.phase === 'job_processing' ||
                        latestDeployment?.phase === 'awaiting_secrets' ||
                        latestDeployment?.phase === 'active'
                      ? 'done'
                      : latestDeployment?.phase === 'failed'
                        ? 'error'
                        : 'active'
                }
                isFirst
              />
              <TimelineStage
                label="Operator Processing"
                description={
                  latestDeployment?.phase === 'job_submitted' || latestDeployment?.phase === 'job_processing'
                    ? (PROVISION_PROGRESS_LABELS[latestDeployment?.progressPhase ?? ''] ?? 'Waiting for an operator to pick up your job...')
                    : latestDeployment?.phase === 'awaiting_secrets' || latestDeployment?.phase === 'active'
                      ? 'Infrastructure provisioned successfully'
                      : 'An operator will detect your job and provision a sidecar container'
                }
                status={
                  latestDeployment?.phase === 'job_submitted' ||
                  latestDeployment?.phase === 'job_processing'
                    ? 'active'
                    : latestDeployment?.phase === 'awaiting_secrets' ||
                        latestDeployment?.phase === 'active'
                      ? 'done'
                      : latestDeployment?.phase === 'failed'
                        ? 'error'
                        : 'pending'
                }
              />
              <TimelineStage
                label="Configure API Keys"
                description="Infrastructure deployed. Provide your API keys on the dashboard to activate the agent."
                status={
                  latestDeployment?.phase === 'awaiting_secrets'
                    ? 'active'
                    : latestDeployment?.phase === 'active'
                      ? 'done'
                      : latestDeployment?.phase === 'failed'
                        ? 'error'
                        : 'pending'
                }
              />
              <TimelineStage
                label="Agent Live"
                description="Your trading agent is running inside its sidecar and the vault is deployed on-chain"
                status={
                  latestDeployment?.phase === 'active'
                    ? 'done'
                    : latestDeployment?.phase === 'failed'
                      ? 'error'
                      : 'pending'
                }
                isLast
              />
            </div>

            {latestDeployment?.phase === 'failed' && latestDeployment.errorMessage && (
              <div className="text-sm text-crimson-400 p-3 bg-crimson-500/5 border border-crimson-500/20">
                {latestDeployment.errorMessage}
              </div>
            )}

            {latestDeployment?.phase === 'awaiting_secrets' && (
              <div className="p-3.5 bg-emerald-500/5 border border-emerald-500/30 space-y-2">
                <div className="text-sm font-display font-medium text-emerald-400">
                  Infrastructure Deployed — Ready for Activation
                </div>
                <p className="text-sm text-arena-elements-textSecondary">
                  Your sidecar and vault are ready. Provide your API keys to start trading.
                </p>
                <Button
                  size="sm"
                  onClick={() => setStep('secrets')}
                  className="mt-1"
                >
                  Next: Activate Agent &rarr;
                </Button>
              </div>
            )}

            {latestDeployment?.phase === 'active' && (
              <div className="p-3.5 bg-emerald-700/5 border border-emerald-700/30 dark:bg-emerald-500/5 dark:border-emerald-500/30 space-y-2">
                <div className="text-sm font-display font-medium text-arena-elements-icon-success">
                  Agent Provisioned Successfully
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm font-data">
                  {latestDeployment.vaultAddress &&
                    latestDeployment.vaultAddress !== zeroAddress && (
                      <>
                        <span className="text-arena-elements-textTertiary">Vault</span>
                        <span className="text-arena-elements-textPrimary truncate">
                          {latestDeployment.vaultAddress}
                        </span>
                      </>
                    )}
                  {latestDeployment.sandboxId && (
                    <>
                      <span className="text-arena-elements-textTertiary">Sandbox</span>
                      <span className="text-arena-elements-textPrimary truncate">
                        {latestDeployment.sandboxId}
                      </span>
                    </>
                  )}
                  {latestDeployment.workflowId != null && (
                    <>
                      <span className="text-arena-elements-textTertiary">Workflow</span>
                      <span className="text-arena-elements-textPrimary">
                        {latestDeployment.workflowId}
                      </span>
                    </>
                  )}
                  {latestDeployment.callId != null && (
                    <>
                      <span className="text-arena-elements-textTertiary">Call ID</span>
                      <span className="text-arena-elements-textPrimary">
                        {latestDeployment.callId}
                      </span>
                    </>
                  )}
                </div>
                {botRouteId ? (
                  <Link
                    to={`/arena/bot/${encodeURIComponent(botRouteId)}/performance`}
                    className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-violet-700 dark:text-violet-400 hover:underline mt-1"
                  >
                    View Bot &rarr;
                  </Link>
                ) : null}
              </div>
            )}

            <div className="text-xs font-data text-arena-elements-textTertiary truncate">
              TX: {txHash}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={goBack} disabled={!!txHash}>
          Back
        </Button>
        {txHash && !latestDeployment?.phase?.match(/active|awaiting_secrets|failed/) && (
          <span className="text-sm text-arena-elements-textTertiary animate-pulse self-center">
            Waiting for operator...
          </span>
        )}
        {latestDeployment?.phase === 'awaiting_secrets' && (
          <Button
            onClick={() => setStep('secrets')}
          >
            Next: Activate &rarr;
          </Button>
        )}
        {latestDeployment?.phase === 'active' && (
          <Button
            variant="outline"
            onClick={() => {
              resetTx();
              setStep('configure');
            }}
          >
            Activate Another Agent
          </Button>
        )}
        {latestDeployment?.phase === 'failed' && (
          <Button
            variant="outline"
            onClick={() => {
              removeProvision(latestDeployment.id);
              resetTx();
              setStep('deploy');
            }}
          >
            Try Again
          </Button>
        )}
      </div>
    </>
  );
}
