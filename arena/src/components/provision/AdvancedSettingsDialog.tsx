import {
  Button, Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, Input, Tabs, TabsList, TabsTrigger, TabsContent,
} from '@tangle/blueprint-ui/components';
import type { StrategyPackDef } from '~/lib/blueprints';
import { cronToHuman } from '~/routes/provision/types';

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
  validatorMode: 'default' | 'custom';
  setValidatorMode: (v: 'default' | 'custom') => void;
  customValidatorIds: string;
  setCustomValidatorIds: (v: string) => void;
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
  validatorMode,
  setValidatorMode,
  customValidatorIds,
  setCustomValidatorIds,
}: AdvancedSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">
            Agent Instructions: {selectedPack.name}
          </DialogTitle>
          <DialogDescription className="text-sm">
            This is the full system prompt injected into the sidecar coding agent. The operator
            binary fills in runtime values (API URL, vault address, etc.) at provision time.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="full" className="flex-1 flex flex-col min-h-0">
          <TabsList>
            <TabsTrigger value="full">Full Instructions</TabsTrigger>
            <TabsTrigger value="expert">Expert Knowledge</TabsTrigger>
            <TabsTrigger value="extra">Custom Instructions</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="full" className="flex-1 mt-3">
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

          <TabsContent value="expert" className="flex-1 mt-3">
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

          <TabsContent value="extra" className="flex-1 mt-3">
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

          <TabsContent value="settings" className="flex-1 mt-3">
            <div className="space-y-5 p-px">
              <div>
                <label htmlFor="cron-schedule" className="text-xs font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
                  Cron Schedule
                </label>
                <Input
                  id="cron-schedule"
                  value={customCron || selectedPack.cron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  className="font-data"
                />
                <p className="text-xs text-arena-elements-textTertiary mt-1.5">
                  6-field cron. Default: {selectedPack.cron} = every{' '}
                  {cronToHuman(selectedPack.cron)}
                </p>
              </div>
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

              {(customCron || validatorMode === 'custom') && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setCustomCron(''); setValidatorMode('default'); setCustomValidatorIds(''); }}
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
