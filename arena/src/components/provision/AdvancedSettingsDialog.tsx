import {
  Button, Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, Input, Tabs, TabsList, TabsTrigger, TabsContent,
} from '@tangle-network/blueprint-ui/components';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import type { StrategyPackDef } from '~/lib/blueprints';
import { cronToHuman } from '~/routes/provision/types';

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
  conversationEnabled: boolean;
  setConversationEnabled: (v: boolean) => void;
  researchEnabled: boolean;
  setResearchEnabled: (v: boolean) => void;
  validatorMode: 'default' | 'custom';
  setValidatorMode: (v: 'default' | 'custom') => void;
  customValidatorIds: string;
  setCustomValidatorIds: (v: string) => void;
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
  uniswapEnvelopeEnabled?: boolean;
  setUniswapEnvelopeEnabled?: (v: boolean) => void;
  uniswapEnvelopeMaxDurationSecs?: string;
  setUniswapEnvelopeMaxDurationSecs?: (v: string) => void;
  uniswapEnvelopeMaxSingleAmountIn?: string;
  setUniswapEnvelopeMaxSingleAmountIn?: (v: string) => void;
  uniswapEnvelopeMaxTotalAmountIn?: string;
  setUniswapEnvelopeMaxTotalAmountIn?: (v: string) => void;
  uniswapEnvelopeMaxSlippageBps?: string;
  setUniswapEnvelopeMaxSlippageBps?: (v: string) => void;
  uniswapEnvelopeLimitError?: string | null;
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
  conversationEnabled,
  setConversationEnabled,
  researchEnabled,
  setResearchEnabled,
  validatorMode,
  setValidatorMode,
  customValidatorIds,
  setCustomValidatorIds,
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
  uniswapEnvelopeEnabled = false,
  setUniswapEnvelopeEnabled = () => {},
  uniswapEnvelopeMaxDurationSecs = '3600',
  setUniswapEnvelopeMaxDurationSecs = () => {},
  uniswapEnvelopeMaxSingleAmountIn = '',
  setUniswapEnvelopeMaxSingleAmountIn = () => {},
  uniswapEnvelopeMaxTotalAmountIn = '',
  setUniswapEnvelopeMaxTotalAmountIn = () => {},
  uniswapEnvelopeMaxSlippageBps = '100',
  setUniswapEnvelopeMaxSlippageBps = () => {},
  uniswapEnvelopeLimitError = null,
  onOpenInfrastructure,
}: AdvancedSettingsDialogProps) {
  const effectiveRuntimeBackend = isTeeBlueprint ? 'tee' : runtimeBackend;
  const canResetRuntime = !isTeeBlueprint && runtimeBackend !== 'docker';
  const supportsUniswapEnvelope = selectedPack.providers.some((provider) =>
    provider.toLowerCase().includes('uniswap'),
  );
  const defaultUniswapEnvelopeEnabled = supportsUniswapEnvelope && !provisionPaperTrade;
  const requireUniswapEnvelopeLimits =
    supportsUniswapEnvelope && uniswapEnvelopeEnabled && !provisionPaperTrade;
  const defaultConversationCron =
    selectedPack.conversationCron ?? '0 1,6,11,16,21,26,31,36,41,46,51,56 * * * *';
  const defaultResearchCron =
    selectedPack.researchCron ?? '0 2 0,2,4,6,8,10,12,14,16,18,20,22 * * *';
  const canResetSettings = !!(
    customCron ||
    customConversationCron ||
    customResearchCron ||
    !conversationEnabled ||
    !researchEnabled ||
    validatorMode === 'custom' ||
    uniswapEnvelopeEnabled ||
    canResetRuntime
  );

  function InfoTooltip({ label, children }: { label: string; children: string }) {
    return (
      <Tooltip.Provider delayDuration={150}>
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
      </Tooltip.Provider>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col overflow-hidden border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2 dark:bg-arena-elements-background-depth-4 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">
            Advanced Configuration: {selectedPack.name}
          </DialogTitle>
          <DialogDescription className="text-sm">
            Configure runtime, infrastructure, scheduling, and agent instruction overlays.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="settings" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <TabsList>
            <TabsTrigger value="full">Full Instructions</TabsTrigger>
            <TabsTrigger value="expert">Expert Knowledge</TabsTrigger>
            <TabsTrigger value="extra">Custom Instructions</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="full" className="flex-1 min-h-0 mt-3 overflow-y-auto pr-1">
            <div className="space-y-3">
              <p className="text-xs text-arena-elements-textSecondary">
                Read-only. Edit the "Expert Knowledge" tab to modify the strategy section. Values
                in {'{{'}braces{'}}'} are filled by the operator at runtime.
              </p>
              <pre className="w-full min-h-64 max-h-[50vh] overflow-auto rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed whitespace-pre-wrap">
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
                className="w-full min-h-56 max-h-[50vh] rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed focus:outline-none focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/10 transition-all resize-y"
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
                className="w-full min-h-40 max-h-[50vh] rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-4 py-3 text-sm font-data text-arena-elements-textSecondary leading-relaxed focus:outline-none focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/10 transition-all resize-y"
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
                  className="w-full rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-3 py-2 text-sm font-data text-arena-elements-textPrimary disabled:opacity-60 disabled:cursor-not-allowed"
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
                  className="w-full rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 px-3 py-2 text-sm font-data text-arena-elements-textPrimary"
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
                  <div className="mt-3 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-2 px-3 py-3 text-xs font-data text-arena-elements-textSecondary space-y-1.5">
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
                  className="inline-flex rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-1 p-1"
                  role="group"
                >
                  <button
                    type="button"
                    aria-pressed={!provisionPaperTrade}
                    disabled={liveModeDisabled}
                    onClick={() => {
                      if (!liveModeDisabled) setProvisionPaperTrade(false);
                    }}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      !provisionPaperTrade
                        ? 'bg-violet-500 text-white shadow-sm'
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
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      provisionPaperTrade
                        ? 'bg-violet-500 text-white shadow-sm'
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
              {supportsUniswapEnvelope && (
                <div className="pt-4 border-t border-arena-elements-dividerColor">
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg p-2.5 hover:bg-arena-elements-background-depth-2 transition-colors">
                    <input
                      type="checkbox"
                      checked={uniswapEnvelopeEnabled}
                      disabled={provisionPaperTrade}
                      onChange={(event) => setUniswapEnvelopeEnabled(event.target.checked)}
                      className="mt-0.5 accent-violet-600"
                    />
                    <div>
                      <span className="text-sm font-medium text-arena-elements-textPrimary">
                        Uniswap envelope mode
                      </span>
                      <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                        Validator-approved DEX limits for live swaps.
                      </p>
                    </div>
                  </label>
                  {uniswapEnvelopeEnabled && !provisionPaperTrade && (
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-arena-elements-textSecondary">
                        Envelope spend limits
                        <InfoTooltip label="Envelope spend limits">
                          Required for live envelope mode: max single caps one swap; max total caps all approved envelope swaps.
                        </InfoTooltip>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          value={uniswapEnvelopeMaxDurationSecs}
                          onChange={(event) => setUniswapEnvelopeMaxDurationSecs(event.target.value)}
                          placeholder="Max duration seconds"
                          className="font-data text-sm"
                        />
                        <Input
                          value={uniswapEnvelopeMaxSlippageBps}
                          onChange={(event) => setUniswapEnvelopeMaxSlippageBps(event.target.value)}
                          placeholder="Max slippage bps"
                          className="font-data text-sm"
                        />
                        <Input
                          value={uniswapEnvelopeMaxSingleAmountIn}
                          onChange={(event) => setUniswapEnvelopeMaxSingleAmountIn(event.target.value)}
                          inputMode="decimal"
                          placeholder="Max single ETH amount"
                          required={requireUniswapEnvelopeLimits}
                          aria-invalid={!!uniswapEnvelopeLimitError}
                          className={`font-data text-sm ${
                            uniswapEnvelopeLimitError
                              ? 'border-crimson-400 focus-visible:ring-crimson-400'
                              : ''
                          }`}
                        />
                        <Input
                          value={uniswapEnvelopeMaxTotalAmountIn}
                          onChange={(event) => setUniswapEnvelopeMaxTotalAmountIn(event.target.value)}
                          inputMode="decimal"
                          placeholder="Max total ETH amount"
                          required={requireUniswapEnvelopeLimits}
                          aria-invalid={!!uniswapEnvelopeLimitError}
                          className={`font-data text-sm ${
                            uniswapEnvelopeLimitError
                              ? 'border-crimson-400 focus-visible:ring-crimson-400'
                              : ''
                          }`}
                        />
                      </div>
                      {uniswapEnvelopeLimitError && (
                        <p className="text-xs text-crimson-300">{uniswapEnvelopeLimitError}</p>
                      )}
                    </div>
                  )}
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
                    <InfoTooltip label="Schedule defaults">
                      {selectedPack.scheduleReason ??
                        'Defaults balance owner messages, research, and trading capacity.'}
                    </InfoTooltip>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <label htmlFor="cron-schedule" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary">
                        Trading
                      </label>
                      <InfoTooltip label="Trading schedule">
                        How often the bot checks markets and may act. Faster schedules react sooner but use more AI capacity.
                      </InfoTooltip>
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
                        <InfoTooltip label="Conversation schedule">
                          How often the bot checks owner messages. AI is only used when a message needs a response.
                        </InfoTooltip>
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
                        <InfoTooltip label="Research schedule">
                          How often the bot reviews performance and looks for improvements. Less frequent research leaves more room for trading.
                        </InfoTooltip>
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
                    setUniswapEnvelopeEnabled(defaultUniswapEnvelopeEnabled);
                    setUniswapEnvelopeMaxDurationSecs('3600');
                    setUniswapEnvelopeMaxSingleAmountIn('');
                    setUniswapEnvelopeMaxTotalAmountIn('');
                    setUniswapEnvelopeMaxSlippageBps('100');
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
