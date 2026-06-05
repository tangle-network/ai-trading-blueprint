import { Link } from 'react-router';
import type { MutableRefObject } from 'react';
import { Button, Card, CardContent } from '@tangle-network/blueprint-ui/components';
import { SecretsProviderFields, type SecretsEnvVar } from '~/components/secrets/SecretsProviderFields';
import { zeroAddress } from 'viem';
import type { TrackedProvision } from '~/lib/stores/provisions';
import {
  ACTIVATION_LABELS,
  type AiProvider,
} from '~/lib/config/aiProviders';
import { getProvisionBotRouteId } from '~/lib/utils/provisionBotRoute';
import type { ValidationTrust } from '~/lib/types/bot';

interface SecretsStepProps {
  latestDeployment: TrackedProvision;
  isInstance: boolean;
  aiProvider: AiProvider;
  setAiProvider: (v: AiProvider) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  extraEnvs: SecretsEnvVar[];
  setExtraEnvs: (v: SecretsEnvVar[]) => void;
  envIdRef: MutableRefObject<number>;
  useOperatorKey: boolean;
  setUseOperatorKey: (v: boolean) => void;
  isSubmittingSecrets: boolean;
  activationPhase: string | null;
  secretsLookupError: string | null;
  handleSubmitSecrets: () => void;
  setStep: (s: 'deploy' | 'configure') => void;
  resetTx: () => void;
  defaultProvider: AiProvider;
  /**
   * Trust mode the bot is being provisioned with. When `envelope`, the
   * post-activation "View Bot" link routes operators to the Envelope tab so
   * they can sign and submit the first envelope.
   */
  validationTrust?: ValidationTrust;
}

export function SecretsStep({
  latestDeployment,
  aiProvider,
  setAiProvider,
  apiKey,
  setApiKey,
  extraEnvs,
  setExtraEnvs,
  envIdRef,
  useOperatorKey,
  setUseOperatorKey,
  isSubmittingSecrets,
  activationPhase,
  secretsLookupError,
  handleSubmitSecrets,
  setStep,
  resetTx,
  defaultProvider,
  validationTrust,
}: SecretsStepProps) {
  const botRouteId = getProvisionBotRouteId(latestDeployment);
  const isEnvelopeMode = validationTrust === 'envelope';
  const botDetailHref = botRouteId
    ? `/arena/bot/${encodeURIComponent(botRouteId)}${isEnvelopeMode ? '/operations?panel=envelope' : '/performance'}`
    : null;
  const viewBotLabel = isEnvelopeMode
    ? 'Sign Envelope to Enable Trading →'
    : 'View Bot →';

  return (
    <>
      {/* Deployment success summary */}
      <div className="rounded-[6px] border border-[#1d5b52] bg-[#0b1418] p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
          <span className="text-sm font-display font-semibold text-emerald-400">
            Infrastructure Deployed
          </span>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm font-data">
          {latestDeployment.sandboxId && (
            <>
              <span className="text-arena-elements-textTertiary">Sandbox</span>
              <span className="text-arena-elements-textPrimary truncate">{latestDeployment.sandboxId}</span>
            </>
          )}
          {latestDeployment.vaultAddress && latestDeployment.vaultAddress !== zeroAddress && (
            <>
              <span className="text-arena-elements-textTertiary">Vault</span>
              <span className="text-arena-elements-textPrimary truncate">{latestDeployment.vaultAddress}</span>
            </>
          )}
          {latestDeployment.callId != null && (
            <>
              <span className="text-arena-elements-textTertiary">Call ID</span>
              <span className="text-arena-elements-textPrimary">{latestDeployment.callId}</span>
            </>
          )}
        </div>
      </div>

      {/* Secrets form */}
      <Card className="rounded-[6px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
        <CardContent className="pt-5 pb-5 space-y-4">
          <div>
            <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
              Configure API Keys
            </span>
            <p className="text-xs text-arena-elements-textTertiary mt-1">
              Your agent needs an AI provider key to operate. Keys are sent directly to the operator over HTTPS — never stored on-chain.
            </p>
          </div>

          {secretsLookupError && (
            <div className="rounded-[5px] border border-amber-500/20 bg-amber-500/5 p-2 text-sm text-amber-500">
              {secretsLookupError}
            </div>
          )}

          {/* Use operator key toggle */}
          <button
            type="button"
            onClick={() => setUseOperatorKey(!useOperatorKey)}
            className={`w-full flex items-center gap-3 rounded-[5px] border p-3 text-left transition-[background-color,border-color,box-shadow] duration-150 ${
              useOperatorKey
                ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] ring-1 ring-[color-mix(in_srgb,var(--arena-terminal-accent)_24%,transparent)]'
                : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] hover:border-[var(--arena-terminal-border-hover)]'
            }`}
          >
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
              useOperatorKey ? 'border-[var(--arena-terminal-accent)] bg-[var(--arena-terminal-accent)]' : 'border-arena-elements-textTertiary'
            }`}>
              {useOperatorKey && (
                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            <div>
              <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
                Use operator-provided key
              </span>
              <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                Skip API key entry — the operator has pre-configured keys for this agent.
              </p>
            </div>
          </button>

          {!useOperatorKey && (
            <SecretsProviderFields
              provider={aiProvider}
              setProvider={setAiProvider}
              apiKey={apiKey}
              setApiKey={setApiKey}
              extraEnvs={extraEnvs}
              setExtraEnvs={setExtraEnvs}
              envIdRef={envIdRef}
              defaultProvider={defaultProvider}
              variant="card"
            />
          )}

          {/* Activation progress */}
          {isSubmittingSecrets && activationPhase && (
            <div className="flex items-center gap-2 rounded-[5px] border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
              <span className="text-sm font-data text-amber-400">
                {ACTIVATION_LABELS[activationPhase] ?? activationPhase}
              </span>
            </div>
          )}

          <Button
            onClick={handleSubmitSecrets}
            className="w-full"
            size="lg"
            disabled={(!useOperatorKey && !apiKey.trim()) || isSubmittingSecrets}
          >
            {isSubmittingSecrets ? 'Signing & Configuring...' : useOperatorKey ? 'Sign & Activate (Operator Key)' : 'Sign & Activate Agent'}
          </Button>
        </CardContent>
      </Card>

      {latestDeployment.phase === 'active' && (
        <div className="space-y-3 rounded-[6px] border border-[#1d5b52] bg-[#0b1418] p-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-display font-semibold text-emerald-400">
              Agent Activated Successfully
            </span>
          </div>
          {isEnvelopeMode && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Envelope mode: this bot won't trade until an envelope is signed
              and submitted on the Envelope tab.
            </p>
          )}
          {botDetailHref ? (
            <Link
              to={botDetailHref}
              className="inline-flex items-center gap-1.5 text-sm font-display font-medium text-[var(--arena-terminal-accent)] hover:underline"
            >
              {viewBotLabel}
            </Link>
          ) : null}
        </div>
      )}

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setStep('deploy')}
          disabled={isSubmittingSecrets}
        >
          Back
        </Button>
        {latestDeployment.phase === 'active' && (
          <Button
            variant="outline"
            onClick={() => {
              resetTx();
              setStep('configure');
            }}
          >
            Provision Another Agent
          </Button>
        )}
      </div>
    </>
  );
}
