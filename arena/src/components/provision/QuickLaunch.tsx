import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Card, CardContent } from '@tangle-network/blueprint-ui/components';
import type { Address } from 'viem';
import type { TrackedProvision } from '~/lib/stores/provisions';
import type { CreateStrategyDraft } from '~/lib/createStrategyDraft';
import { ACTIVATION_LABELS } from '~/lib/config/aiProviders';
import { PROVISION_PROGRESS_LABELS, formatCost } from '~/routes/provision/types';
import { TimelineStage, ElapsedTime } from './TimelineStage';
import { OperatorPicker, type OperatorPickerOption } from './OperatorPicker';
import { truncateAddress } from '~/lib/format';
import { getProvisionBotRouteId } from '~/lib/utils/provisionBotRoute';

export interface QuickLaunchProps {
  draft: CreateStrategyDraft;
  packName: string;
  /** Plain-language instance framing (shared / dedicated / dedicated + TEE). */
  instanceLabel?: string;
  executionTargetLabel?: string;
  /** Service path: an active, permitted service was discovered on-chain. */
  serviceReady: boolean;
  serviceId: string;
  serviceOperators: Address[];
  /** Quote path: the effective operator and its signed quote total. */
  quoteOperator?: Address;
  quoteCost?: bigint;
  /** Every discovered operator for the runtime, priced where quoted. */
  operatorOptions?: OperatorPickerOption[];
  /** Cheapest quoted operator — the default pick. */
  cheapestOperator?: Address;
  onSelectOperator?: (address: Address) => void;
  /** Pre-launch auto-resolution still in flight (discovery/quoting). */
  resolving: boolean;
  resolutionDetail: string | null;
  launchReady: boolean;
  running: boolean;
  error: string | null;
  isWalletPending: boolean;
  newServiceDeploying: boolean;
  instanceProvisioning: boolean;
  isSubmittingSecrets: boolean;
  activationPhase: string | null;
  latestDeployment: TrackedProvision | undefined;
  txHash: `0x${string}` | undefined;
  onLaunch: () => void;
  onAdvanced: () => void;
  onRetry: () => void;
  onReset: () => void;
}

function ContractRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <span className="text-arena-elements-textTertiary">{label}</span>
      <span className="min-w-0 break-words text-right text-arena-elements-textPrimary">
        {value}
      </span>
    </>
  );
}

export function QuickLaunch({
  draft,
  packName,
  instanceLabel,
  executionTargetLabel,
  serviceReady,
  serviceId,
  serviceOperators,
  quoteOperator,
  quoteCost,
  operatorOptions,
  cheapestOperator,
  onSelectOperator,
  resolving,
  resolutionDetail,
  launchReady,
  running,
  error,
  isWalletPending,
  newServiceDeploying,
  instanceProvisioning,
  isSubmittingSecrets,
  activationPhase,
  latestDeployment,
  txHash,
  onLaunch,
  onAdvanced,
  onRetry,
  onReset,
}: QuickLaunchProps) {
  const phase = latestDeployment?.phase;
  const launched = Boolean(
    running ||
    txHash ||
    newServiceDeploying ||
    instanceProvisioning ||
    isSubmittingSecrets ||
    latestDeployment,
  );
  const failed = phase === 'failed';
  const live = phase === 'active';
  const awaitingSecrets = phase === 'awaiting_secrets';
  const botRouteId = latestDeployment
    ? getProvisionBotRouteId(latestDeployment)
    : undefined;

  // The operator line is the picker while the launch is still re-targetable;
  // once launched (or on the existing-service path) it collapses back into a
  // static contract row.
  const showOperatorPicker =
    !launched &&
    !serviceReady &&
    onSelectOperator != null &&
    (operatorOptions?.some((option) => option.quoteCost != null) ?? false);

  const operatorValue = serviceReady
    ? serviceOperators.length > 0
      ? serviceOperators.length === 1
        ? truncateAddress(serviceOperators[0])
        : `${truncateAddress(serviceOperators[0])} +${serviceOperators.length - 1}`
      : `Service #${serviceId}`
    : !showOperatorPicker && quoteOperator
      ? truncateAddress(quoteOperator)
      : null;
  const costValue = serviceReady
    ? 'Network fee only'
    : showOperatorPicker
      ? null
      : quoteCost != null && quoteCost > 0n
        ? `${formatCost(quoteCost)} runtime quote`
        : quoteCost === 0n && quoteOperator
          ? 'Free runtime quote'
          : null;
  const launchLabel = running
    ? 'Launching…'
    : serviceReady
      ? 'Launch · network fee only'
      : quoteCost != null && quoteOperator
        ? `Launch · ${formatCost(quoteCost)}`
        : 'Launch';

  const mandate = draft.agentProfile?.objective?.description;
  const contractRows: Array<{ label: string; value: ReactNode }> = ([
    draft.market ? { label: 'Market', value: draft.market } : null,
    {
      label: 'Venue',
      value: draft.venue || executionTargetLabel || packName,
    },
    draft.sizing ? { label: 'Sizing', value: draft.sizing } : null,
    draft.drawdown ? { label: 'Risk', value: draft.drawdown } : null,
    draft.mode ? { label: 'Mode', value: draft.mode } : null,
    instanceLabel || executionTargetLabel
      ? {
          label: 'Instance',
          value: [instanceLabel, executionTargetLabel].filter(Boolean).join(' · '),
        }
      : null,
    operatorValue ? { label: 'Operator', value: operatorValue } : null,
    costValue ? { label: 'Cost', value: costValue } : null,
  ] as Array<{ label: string; value: ReactNode } | null>).filter(
    (row): row is { label: string; value: ReactNode } => row !== null,
  );

  // Stage statuses are derived only from real launch state — wallet pending,
  // tracked provision phase, and the secrets submission flags.
  const submitted = Boolean(txHash) || (phase != null && phase !== 'pending_confirmation');
  const submitStatus: 'pending' | 'active' | 'done' | 'error' =
    isWalletPending || newServiceDeploying
      ? 'active'
      : submitted
        ? 'done'
        : failed
          ? 'error'
          : running
            ? 'active'
            : 'pending';
  const provisioningActive =
    instanceProvisioning || phase === 'job_submitted' || phase === 'job_processing';
  const provisioningDone = awaitingSecrets || live || isSubmittingSecrets;
  const activationActive = isSubmittingSecrets || awaitingSecrets;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <Card className="rounded-none border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] shadow-none">
        <CardContent className="grid gap-0 p-0 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4 p-5">
            <div>
              <span className="block font-data text-sm uppercase tracking-wider text-arena-elements-textSecondary">
                Launch contract
              </span>
              <h2 className="mt-2 font-display text-xl font-semibold text-arena-elements-textPrimary">
                {draft.name}
              </h2>
              {mandate && (
                <p className="mt-2 max-w-2xl text-sm text-arena-elements-textTertiary">
                  {mandate}
                </p>
              )}
            </div>

            {!launched && (
              <div className="space-y-3">
                {showOperatorPicker && operatorOptions && onSelectOperator && (
                  <OperatorPicker
                    options={operatorOptions}
                    selected={quoteOperator}
                    cheapest={cheapestOperator}
                    onSelect={onSelectOperator}
                  />
                )}
                {resolving && resolutionDetail && (
                  <div
                    className="flex items-center gap-2 text-sm text-arena-elements-textTertiary"
                    role="status"
                  >
                    <div className="h-3 w-3 shrink-0 rounded-full border-2 border-[var(--arena-terminal-accent)] border-t-transparent motion-safe:animate-spin" />
                    {resolutionDetail}
                  </div>
                )}
                {error && (
                  <div className="border border-[color-mix(in_srgb,var(--arena-terminal-warning)_36%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_10%,var(--arena-terminal-panel))] p-3 text-sm text-arena-elements-textSecondary">
                    {error}
                  </div>
                )}
                <Button
                  size="lg"
                  className="w-full"
                  disabled={!launchReady || running}
                  onClick={onLaunch}
                >
                  {launchLabel}
                </Button>
              </div>
            )}

            {launched && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <span className="block font-data text-sm uppercase tracking-wider text-arena-elements-textSecondary">
                    {live ? 'Agent live' : failed ? 'Launch failed' : 'Launching'}
                  </span>
                  {latestDeployment && !live && !failed && (
                    <ElapsedTime since={latestDeployment.createdAt} />
                  )}
                </div>

                <div className="relative pl-7">
                  <div className="absolute bottom-[8px] left-[8px] top-[8px] w-px bg-arena-elements-borderColor/60" />
                  <TimelineStage
                    label="Transaction sent"
                    description={
                      newServiceDeploying
                        ? 'Runtime service is being created from the operator quote'
                        : isWalletPending
                          ? 'Confirm the launch transaction in your wallet'
                          : 'Launch transaction confirmed on-chain'
                    }
                    status={submitStatus}
                    isFirst
                  />
                  <TimelineStage
                    label="Operator provisioning"
                    description={
                      provisioningActive
                        ? PROVISION_PROGRESS_LABELS[latestDeployment?.progressPhase ?? ''] ??
                          'An operator is provisioning the agent sidecar'
                        : provisioningDone
                          ? 'Sidecar and vault route provisioned'
                          : 'An operator picks up the job and provisions the sidecar'
                    }
                    status={
                      failed
                        ? 'error'
                        : provisioningDone
                          ? 'done'
                          : provisioningActive
                            ? 'active'
                            : 'pending'
                    }
                  />
                  <TimelineStage
                    label="Activation"
                    description={
                      isSubmittingSecrets && activationPhase
                        ? ACTIVATION_LABELS[activationPhase] ?? activationPhase
                        : 'Operator-managed AI keys are bound to the agent'
                    }
                    status={
                      failed
                        ? 'error'
                        : live
                          ? 'done'
                          : activationActive
                            ? 'active'
                            : 'pending'
                    }
                  />
                  <TimelineStage
                    label="Live"
                    description="The agent runs in its sidecar and the vault route is active"
                    status={failed ? 'error' : live ? 'done' : 'pending'}
                    isLast
                  />
                </div>

                {error && !live && !failed && (
                  <div className="space-y-2 border border-[color-mix(in_srgb,var(--arena-terminal-warning)_36%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_10%,var(--arena-terminal-panel))] p-3">
                    <p className="text-sm text-arena-elements-textSecondary">{error}</p>
                    {!running && (
                      <Button size="sm" variant="outline" onClick={onRetry}>
                        {awaitingSecrets ? 'Retry activation' : 'Retry'}
                      </Button>
                    )}
                  </div>
                )}

                {failed && (
                  <div className="space-y-2 border border-crimson-500/20 bg-crimson-500/5 p-3">
                    {latestDeployment?.errorMessage && (
                      <p className="text-sm text-crimson-400">
                        {latestDeployment.errorMessage}
                      </p>
                    )}
                    <Button size="sm" variant="outline" onClick={onReset}>
                      Try again
                    </Button>
                  </div>
                )}

                {live && botRouteId && (
                  <Link
                    to={`/arena/bot/${encodeURIComponent(botRouteId)}/performance`}
                    className="inline-flex items-center gap-1.5 font-display text-sm font-medium text-[var(--arena-terminal-accent)] hover:underline"
                  >
                    View Bot &rarr;
                  </Link>
                )}

                {txHash && (
                  <div className="truncate font-data text-xs text-arena-elements-textTertiary">
                    TX: {txHash}
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="border-t border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-5 lg:border-l lg:border-t-0">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-data text-sm">
              {contractRows.map((row) => (
                <ContractRow key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          </aside>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onAdvanced}
          className="font-display text-sm font-medium text-arena-elements-textSecondary underline-offset-4 hover:text-arena-elements-textPrimary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
        >
          Advanced setup
        </button>
      </div>
    </div>
  );
}
