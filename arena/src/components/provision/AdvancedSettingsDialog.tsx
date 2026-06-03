import {
  Button, Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, Input, Tabs, TabsList, TabsTrigger, TabsContent,
} from '@tangle-network/blueprint-ui/components';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import type { StrategyPackDef } from '~/lib/blueprints';
import { cronToHuman } from '~/routes/provision/types';
import type { ValidationTrust } from '~/lib/types/bot';

const DEFAULT_POSITION_SIZE_PCT = '10';

interface ExecutionTargetOption {
  id: string;
  label: string;
  description: string;
  modeLabel?: string;
  enabled: boolean;
  chainId?: number;
  protocolChainId?: number;
  rpcUrl?: string;
  vaultAddress?: string;
  assetToken?: string;
  paperTrade?: boolean;
}

interface AdvancedSettingsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedPack: StrategyPackDef;
  fullInstructions: string;
  customExpertKnowledge: string;
  setCustomExpertKnowledge: (v: string) => void;
  customInstructions: string;
  setCustomInstructions: (v: string) => void;
  customCron: string;
  setCustomCron: (v: string) => void;
  customConversationCron: string;
  setCustomConversationCron: (v: string) => void;
  customResearchCron: string;
  setCustomResearchCron: (v: string) => void;
  positionSizePct: string;
  setPositionSizePct: (v: string) => void;
  conversationEnabled: boolean;
  setConversationEnabled: (v: boolean) => void;
  researchEnabled: boolean;
  setResearchEnabled: (v: boolean) => void;
  validatorMode: 'default' | 'custom';
  setValidatorMode: (v: 'default' | 'custom') => void;
  customValidatorIds: string;
  setCustomValidatorIds: (v: string) => void;
  validationTrust: ValidationTrust;
  setValidationTrust: (v: ValidationTrust) => void;
  runtimeBackend: 'docker' | 'firecracker' | 'tee';
  setRuntimeBackend: (v: 'docker' | 'firecracker' | 'tee') => void;
  firecrackerSupported: boolean;
  isTeeBlueprint: boolean;
  executionTargets: ExecutionTargetOption[];
  executionTargetId: string;
  setExecutionTargetId: (v: string) => void;
  selectedExecutionTarget?: ExecutionTargetOption;
  executionChainMessage?: string | null;
  liveModeDisabled?: boolean;
  provisionPaperTrade: boolean;
  setProvisionPaperTrade: (v: boolean) => void;
  onOpenInfrastructure: () => void;
}

export function AdvancedSettingsDialog({
  open,
  onOpenChange,
  selectedPack,
  fullInstructions,
  customExpertKnowledge,
  setCustomExpertKnowledge,
  customInstructions,
  setCustomInstructions,
  customCron,
  setCustomCron,
  customConversationCron,
  setCustomConversationCron,
  customResearchCron,
  setCustomResearchCron,
  positionSizePct,
  setPositionSizePct,
  conversationEnabled,
  setConversationEnabled,
  researchEnabled,
  setResearchEnabled,
  validatorMode,
  setValidatorMode,
  customValidatorIds,
  setCustomValidatorIds,
  validationTrust,
  setValidationTrust,
  runtimeBackend,
  setRuntimeBackend,
  firecrackerSupported,
  isTeeBlueprint,
  executionTargets,
  executionTargetId,
  setExecutionTargetId,
  selectedExecutionTarget,
  executionChainMessage,
  liveModeDisabled = false,
  provisionPaperTrade,
  setProvisionPaperTrade,
  onOpenInfrastructure,
}: AdvancedSettingsDialogProps) {
  const effectiveRuntimeBackend = isTeeBlueprint ? 'tee' : runtimeBackend;
  const canResetRuntime = !isTeeBlueprint && runtimeBackend !== 'docker';
  const defaultConversationCron =
    selectedPack.conversationCron ?? '0 1,6,11,16,21,26,31,36,41,46,51,56 * * * *';
  const defaultResearchCron =
    selectedPack.researchCron ?? '0 2 0,2,4,6,8,10,12,14,16,18,20,22 * * *';
  const showPositionSizing = selectedPack.id === 'hyperliquid_perp';
  const canResetSettings = !!(
    customCron ||
    customConversationCron ||
    customResearchCron ||
    !conversationEnabled ||
    !researchEnabled ||
    validatorMode === 'custom' ||
    validationTrust !== 'per_trade' ||
    (showPositionSizing && positionSizePct !== DEFAULT_POSITION_SIZE_PCT) ||
    canResetRuntime
  );

  function ScheduleTooltip({ label, children }: { label: string; children: string }) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-arena-elements-textTertiary hover:text-arena-elements-textPrimary"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={8}
            className="z-[100] max-w-xs rounded-md border border-arena-elements-borderColor bg-arena-elements-background-depth-2 px-3 py-2 text-xs text-arena-elements-textSecondary shadow-lg"
          >
            {children}
            <Tooltip.Arrow className="fill-[var(--arena-elements-background-depth-2)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="arena-trace-terminal flex max-h-[85vh] flex-col overflow-hidden rounded-[7px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text)] shadow-[var(--arena-terminal-shadow-lg)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">
            Advanced Configuration: {selectedPack.name}
          </DialogTitle>
          <DialogDescription className="text-sm">
            Configure runtime, infrastructure, scheduling, and agent instruction overlays.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="settings" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <TabsList className="rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] p-1">
            <TabsTrigger value="full" className="rounded-[4px]">Full Instructions</TabsTrigger>
            <TabsTrigger value="expert" className="rounded-[4px]">Expert Knowledge</TabsTrigger>
            <TabsTrigger value="extra" className="rounded-[4px]">Custom Instructions</TabsTrigger>
            <TabsTrigger value="settings" className="rounded-[4px]">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="full" className="flex-1 min-h-0 mt-3 overflow-y-auto pr-1">
            <div className="space-y-3">
              <p className="text-xs text-arena-elements-textSecondary">
                Read-only. Edit the "Expert Knowledge" tab to modify the strategy section. Values
                in {'{{'}braces{'}}'} are filled by the operator at runtime.
              </p>
              <pre className="w-full min-h-64 max-h-[50vh] overflow-auto rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed whitespace-pre-wrap">
                {fullInstructions}
              </pre>
            </div>
          </TabsContent>

          <TabsContent value="expert" className="flex-1 min-h-0 mt-3 overflow-y-auto pr-1">
            <div className="space-y-3 p-px">
              <p className="text-xs text-arena-elements-textSecondary">
                Injected under "Expert Strategy Knowledge". Edit protocol APIs, contracts, or
                methodology.
              </p>
              <textarea
                value={customExpertKnowledge || selectedPack.expertKnowledge}
                onChange={(e) => setCustomExpertKnowledge(e.target.value)}
                className="w-full min-h-56 max-h-[50vh] rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-[#50d2c1]/60 focus:ring-2 focus:ring-[#50d2c1]/20 resize-y"
              />
              {customExpertKnowledge && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCustomExpertKnowledge('')}
                  className="text-xs"
                >
                  Reset to Default
                </Button>
              )}
            </div>
          </TabsContent>

          <TabsContent value="extra" className="flex-1 min-h-0 mt-3 overflow-y-auto pr-1">
            <div className="space-y-3 p-px">
              <p className="text-xs text-arena-elements-textSecondary">
                Additional instructions appended to the agent profile.
              </p>
              <textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                className="w-full min-h-40 max-h-[50vh] rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-[#50d2c1]/60 focus:ring-2 focus:ring-[#50d2c1]/20 resize-y"
                placeholder={`Examples:\n- Only trade ETH/USDC pairs\n- Max position: 5% of portfolio\n- Focus on Asian session hours\n- Avoid news events`}
              />
            </div>
          </TabsContent>

          <TabsContent value="settings" className="flex-1 min-h-0 mt-3 overflow-y-auto pr-1">
            <div className="space-y-5 p-px">
              <div>
                <label htmlFor="runtime-backend" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Runtime Backend
                </label>
                <select
                  id="runtime-backend"
                  value={effectiveRuntimeBackend}
                  disabled={isTeeBlueprint}
                  onChange={(e) => setRuntimeBackend(e.target.value as 'docker' | 'firecracker' | 'tee')}
                  className="w-full rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2 text-sm font-data text-arena-elements-textPrimary disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <option value="docker">Docker (default)</option>
                  <option value="firecracker" disabled={!firecrackerSupported}>
                    {firecrackerSupported ? 'Firecracker (microVM)' : 'Firecracker (microVM, unavailable)'}
                  </option>
                  <option value="tee">TEE (confidential)</option>
                </select>
                {isTeeBlueprint && (
                  <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                    TEE blueprints are pinned to TEE runtime.
                  </p>
                )}
                {!isTeeBlueprint && !firecrackerSupported && (
                  <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                    Firecracker runtime is not enabled for this deployment.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="execution-chain" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Execution Chain
                </label>
                <select
                  id="execution-chain"
                  value={executionTargetId}
                  disabled={executionTargets.length === 0}
                  onChange={(e) => setExecutionTargetId(e.target.value)}
                  className="w-full rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2 text-sm font-data text-arena-elements-textPrimary"
                >
                  {executionTargets.map((target) => (
                    <option key={target.id} value={target.id} disabled={!target.enabled}>
                      {target.label}{target.enabled ? '' : ' — unavailable'}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                  {executionChainMessage ?? 'Choose where strategies run. The selected chain sets the default trading mode, but you can override it below.'}
                </p>
                {selectedExecutionTarget && (
                  <div className="mt-3 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] px-3 py-3 text-xs font-data text-arena-elements-textSecondary space-y-1.5">
                    <div className="flex justify-between gap-3">
                      <span>Mode</span>
                      <span className="text-arena-elements-textPrimary">
                        {selectedExecutionTarget.modeLabel ?? (selectedExecutionTarget.enabled ? 'Execution target' : 'Unavailable')}
                      </span>
                    </div>
                    {selectedExecutionTarget.chainId != null && (
                      <div className="flex justify-between gap-3">
                        <span>Chain ID</span>
                        <span className="text-arena-elements-textPrimary">{selectedExecutionTarget.chainId}</span>
                      </div>
                    )}
                    {selectedExecutionTarget.protocolChainId != null && selectedExecutionTarget.protocolChainId !== selectedExecutionTarget.chainId && (
                      <div className="flex justify-between gap-3">
                        <span>Protocol Chain</span>
                        <span className="text-arena-elements-textPrimary">{selectedExecutionTarget.protocolChainId}</span>
                      </div>
                    )}
                    {selectedExecutionTarget.rpcUrl && (
                      <div className="flex justify-between gap-3">
                        <span>RPC URL</span>
                        <span className="text-arena-elements-textPrimary truncate">{selectedExecutionTarget.rpcUrl}</span>
                      </div>
                    )}
                    {selectedExecutionTarget.vaultAddress && (
                      <div className="flex justify-between gap-3">
                        <span>Vault / Factory</span>
                        <span className="text-arena-elements-textPrimary truncate">{selectedExecutionTarget.vaultAddress}</span>
                      </div>
                    )}
                    {selectedExecutionTarget.assetToken && (
                      <div className="flex justify-between gap-3">
                        <span>Asset</span>
                        <span className="text-arena-elements-textPrimary truncate">{selectedExecutionTarget.assetToken}</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-3">
                      <span>Default Mode</span>
                      <span className="text-arena-elements-textPrimary">
                        {selectedExecutionTarget.paperTrade ? 'Paper' : 'Live'}
                      </span>
                    </div>
                    <div>{selectedExecutionTarget.description}</div>
                  </div>
                )}
              </div>
              <div>
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Trading Mode
                </span>
                <div
                  aria-label="Trading mode"
                  className="inline-flex rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-1"
                  role="group"
                >
                  <button
                    type="button"
                    aria-pressed={!provisionPaperTrade}
                    disabled={liveModeDisabled}
                    onClick={() => {
                      if (!liveModeDisabled) setProvisionPaperTrade(false);
                    }}
                    className={`rounded-[4px] px-3 py-1.5 text-xs font-medium transition-colors ${
                      !provisionPaperTrade
                        ? 'bg-[#50d2c1] text-[#06100e]'
                        : liveModeDisabled
                          ? 'text-arena-elements-textTertiary cursor-not-allowed opacity-60'
                          : 'text-arena-elements-textSecondary hover:text-arena-elements-textPrimary'
                    }`}
                  >
                    Live
                  </button>
                  <button
                    type="button"
                    aria-pressed={provisionPaperTrade}
                    onClick={() => setProvisionPaperTrade(true)}
                    className={`rounded-[4px] px-3 py-1.5 text-xs font-medium transition-colors ${
                      provisionPaperTrade
                        ? 'bg-[#50d2c1] text-[#06100e]'
                        : 'text-arena-elements-textSecondary hover:text-arena-elements-textPrimary'
                    }`}
                  >
                    Paper
                  </button>
                </div>
                <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                  {provisionPaperTrade
                    ? 'Paper mode validates and simulates trades without on-chain execution.'
                    : 'Live mode may execute trades on-chain using the bot vault.'}
                </p>
              </div>
              {showPositionSizing && (
                <div>
                  <label htmlFor="position-size-pct" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                    Max Position Size
                  </label>
                  <div className="flex items-center gap-3">
                    <Input
                      id="position-size-pct"
                      type="number"
                      min="1"
                      max="100"
                      step="0.5"
                      value={positionSizePct}
                      onChange={(e) => setPositionSizePct(e.target.value)}
                      className="w-32 font-data"
                    />
                    <span className="text-sm font-data text-arena-elements-textSecondary">% per new trade</span>
                  </div>
                  <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                    Default: 10%. Allowed range: 1% to 100%.
                  </p>
                </div>
              )}
              <div>
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Infrastructure
                </span>
                <p className="text-xs text-arena-elements-textTertiary mb-2.5">
                  Configure service mode, operator selection, and quote management.
                </p>
                <Button type="button" variant="outline" size="sm" onClick={onOpenInfrastructure}>
                  Open Infrastructure Settings
                </Button>
              </div>
              <Tooltip.Provider delayDuration={150}>
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
                      Schedules
                    </span>
                    <ScheduleTooltip label="Schedule defaults">
                      {selectedPack.scheduleReason ??
                        'Defaults balance owner messages, research, and trading capacity.'}
                    </ScheduleTooltip>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <label htmlFor="cron-schedule" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
                        Trading
                      </label>
                      <ScheduleTooltip label="Trading schedule">
                        How often the bot checks markets and may act. Faster schedules react sooner but use more AI capacity.
                      </ScheduleTooltip>
                    </div>
                    <Input
                      id="cron-schedule"
                      value={customCron || selectedPack.cron}
                      onChange={(e) => setCustomCron(e.target.value)}
                      className="font-data"
                    />
                    <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                      Default: {selectedPack.cron} = every {cronToHuman(selectedPack.cron)}
                    </p>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <label htmlFor="conversation-cron-schedule" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
                          Conversation
                        </label>
                        <ScheduleTooltip label="Conversation schedule">
                          How often the bot checks owner messages. AI is only used when a message needs a response.
                        </ScheduleTooltip>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-arena-elements-textSecondary">
                        <input
                          type="checkbox"
                          checked={conversationEnabled}
                          onChange={(e) => setConversationEnabled(e.target.checked)}
                          className="accent-violet-600"
                        />
                        Enabled
                      </label>
                    </div>
                    <Input
                      id="conversation-cron-schedule"
                      value={customConversationCron || defaultConversationCron}
                      onChange={(e) => setCustomConversationCron(e.target.value)}
                      disabled={!conversationEnabled}
                      className="font-data disabled:opacity-60"
                    />
                    <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                      Default: {defaultConversationCron} = every {cronToHuman(defaultConversationCron)}
                    </p>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <label htmlFor="research-cron-schedule" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
                          Research
                        </label>
                        <ScheduleTooltip label="Research schedule">
                          How often the bot reviews performance and looks for improvements. Less frequent research leaves more room for trading.
                        </ScheduleTooltip>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-arena-elements-textSecondary">
                        <input
                          type="checkbox"
                          checked={researchEnabled}
                          onChange={(e) => setResearchEnabled(e.target.checked)}
                          className="accent-violet-600"
                        />
                        Enabled
                      </label>
                    </div>
                    <Input
                      id="research-cron-schedule"
                      value={customResearchCron || defaultResearchCron}
                      onChange={(e) => setCustomResearchCron(e.target.value)}
                      disabled={!researchEnabled}
                      className="font-data disabled:opacity-60"
                    />
                    <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                      Default: {defaultResearchCron} = every {cronToHuman(defaultResearchCron)}
                    </p>
                  </div>
                </div>
              </Tooltip.Provider>
              <div>
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Max Turns
                </span>
                <span className="text-sm font-data text-arena-elements-textPrimary">
                  {selectedPack.maxTurns} per iteration
                </span>
              </div>
              <div>
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Timeout
                </span>
                <span className="text-sm font-data text-arena-elements-textPrimary">
                  {selectedPack.timeoutMs / 1000}s per iteration
                </span>
              </div>
              <div>
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Providers
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {selectedPack.providers.map((p) => (
                    <span
                      key={p}
                      className="text-xs font-data px-2 py-1 rounded bg-violet-500/10 text-violet-700 dark:text-violet-400"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              {/* Validator Configuration */}
              <div className="pt-4 border-t border-arena-elements-dividerColor">
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3 block">
                  Validator Configuration
                </span>
                <div className="space-y-2">
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                    <input
                      type="radio"
                      name="validator-mode"
                      checked={validatorMode === 'default'}
                      onChange={() => setValidatorMode('default')}
                      className="mt-0.5 accent-violet-600"
                    />
                    <div>
                      <span className="text-sm font-medium text-arena-elements-textPrimary">
                        Default validators
                      </span>
                      <span className="ml-1.5 text-xs text-arena-elements-textTertiary">(recommended)</span>
                      <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                        {(import.meta.env.VITE_VALIDATOR_SERVICE_ID ?? '0') !== '0'
                          ? `Uses validator service ${import.meta.env.VITE_VALIDATOR_SERVICE_ID} for AI trade scoring`
                          : 'Paper-trade mode (no validator configured)'}
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                    <input
                      type="radio"
                      name="validator-mode"
                      checked={validatorMode === 'custom'}
                      onChange={() => setValidatorMode('custom')}
                      className="mt-0.5 accent-violet-600"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-arena-elements-textPrimary">
                        Specific validator service IDs
                      </span>
                      <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                        Choose which on-chain validator services score your trades
                      </p>
                      {validatorMode === 'custom' && (
                        <Input
                          value={customValidatorIds}
                          onChange={(e) => setCustomValidatorIds(e.target.value)}
                          placeholder="e.g. 1, 3, 7"
                          className="mt-2 font-data text-sm"
                        />
                      )}
                    </div>
                  </label>
                </div>
              </div>

              {/* Validation Trust */}
              <div className="pt-4 border-t border-arena-elements-dividerColor">
                <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-3 block">
                  Validation Trust
                </span>
                <p className="text-xs text-arena-elements-textTertiary mb-2.5">
                  Choose how trade authorization flows. The default is safest;
                  Envelope mode is faster for trusted operators with M-of-N
                  off-chain approvals.
                </p>
                <div className="space-y-2" role="radiogroup" aria-label="Validation trust">
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                    <input
                      type="radio"
                      name="validation-trust"
                      value="per_trade"
                      checked={validationTrust === 'per_trade'}
                      onChange={() => setValidationTrust('per_trade')}
                      className="mt-0.5 accent-violet-600"
                    />
                    <div>
                      <span className="text-sm font-medium text-arena-elements-textPrimary">
                        Per-trade
                      </span>
                      <span className="ml-1.5 text-xs text-arena-elements-textTertiary">(default)</span>
                      <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                        Every trade requires fresh validator signatures. Safest
                        for untrusted or public operators.
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                    <input
                      type="radio"
                      name="validation-trust"
                      value="envelope"
                      checked={validationTrust === 'envelope'}
                      onChange={() => setValidationTrust('envelope')}
                      className="mt-0.5 accent-violet-600"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-arena-elements-textPrimary">
                        Envelope
                      </span>
                      <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                        Trade authorization comes from a signed envelope (M-of-N
                        off-chain approvals). Trades within the envelope execute
                        instantly.
                      </p>
                      {validationTrust === 'envelope' && (
                        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                          After provisioning, you'll be redirected to the
                          Envelope tab to sign the first envelope. The bot won't
                          trade until an envelope is on file.
                        </div>
                      )}
                    </div>
                  </label>
                  <Tooltip.Provider delayDuration={150}>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <label
                          aria-disabled="true"
                          className="flex items-start gap-3 rounded-lg p-2.5 cursor-not-allowed opacity-60"
                        >
                          <input
                            type="radio"
                            name="validation-trust"
                            value="self_operated"
                            checked={false}
                            disabled
                            readOnly
                            className="mt-0.5 accent-violet-600"
                          />
                          <div>
                            <span className="text-sm font-medium text-arena-elements-textPrimary">
                              Self-operated
                            </span>
                            <span className="ml-1.5 text-xs text-arena-elements-textTertiary">
                              (unavailable)
                            </span>
                            <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                              Local policy only. Not yet exposed in the dApp.
                            </p>
                          </div>
                        </label>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          side="top"
                          sideOffset={8}
                          className="z-[100] max-w-xs rounded-md border border-arena-elements-borderColor bg-arena-elements-background-depth-2 px-3 py-2 text-xs text-arena-elements-textSecondary shadow-lg"
                        >
                          Self-operated mode is reserved for trusted operators
                          running their own infrastructure and is not yet
                          provisionable from the dApp.
                          <Tooltip.Arrow className="fill-[var(--arena-elements-background-depth-2)]" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                </div>
              </div>

              {canResetSettings && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCustomCron('');
                    setCustomConversationCron('');
                    setCustomResearchCron('');
                    setConversationEnabled(true);
                    setResearchEnabled(true);
                    setValidatorMode('default');
                    setCustomValidatorIds('');
                    setValidationTrust('per_trade');
                    setPositionSizePct(DEFAULT_POSITION_SIZE_PCT);
                    if (!isTeeBlueprint) setRuntimeBackend('docker');
                  }}
                  className="text-xs"
                >
                  Reset to Defaults
                </Button>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <div className="pt-3 border-t border-arena-elements-dividerColor">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
