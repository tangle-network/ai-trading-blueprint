import { Button, Card, CardContent, Input } from '@tangle/blueprint-ui/components';
import type { Address } from 'viem';
import { strategyPacks, type StrategyPackDef, type TradingBlueprintDef } from '~/lib/blueprints';
import type { ServiceInfo } from '~/routes/provision/types';

interface ConfigureStepProps {
  name: string;
  setName: (v: string) => void;
  strategyType: string;
  setStrategyType: (v: string) => void;
  runtimeBackend: 'docker' | 'firecracker' | 'tee';
  setRuntimeBackend: (v: 'docker' | 'firecracker' | 'tee') => void;
  firecrackerSupported: boolean;
  selectedPack: StrategyPackDef;
  selectedBlueprint: TradingBlueprintDef | undefined;
  serviceInfo: ServiceInfo | null;
  serviceLoading: boolean;
  serviceError: string | null;
  serviceId: string;
  discoveryLoading: boolean;
  selectedOperators: Set<Address>;
  isInstance: boolean;
  setShowInfra: (v: boolean) => void;
  setShowAdvanced: (v: boolean) => void;
  collateralCapPct: string;
  setCollateralCapPct: (v: string) => void;
  canNext: boolean;
  goNext: () => void;
  userAddress: Address | undefined;
}

export function ConfigureStep({
  name,
  setName,
  strategyType,
  setStrategyType,
  runtimeBackend,
  setRuntimeBackend,
  firecrackerSupported,
  selectedPack,
  selectedBlueprint,
  serviceInfo,
  serviceLoading,
  serviceError,
  serviceId,
  discoveryLoading,
  selectedOperators,
  isInstance,
  setShowInfra,
  setShowAdvanced,
  collateralCapPct,
  setCollateralCapPct,
  canNext,
  goNext,
  userAddress,
}: ConfigureStepProps) {
  const isPrediction = strategyType.startsWith('prediction');
  const firecrackerBlocked = !firecrackerSupported;
  return (
    <>
      {/* Compact infrastructure bar at top */}
      <button
        type="button"
        onClick={() => setShowInfra(true)}
        className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border border-arena-elements-borderColor/60 hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 transition-colors group"
      >
        <div className="flex items-center gap-3">
          {isInstance ? (
            <>
              <span className="w-2 h-2 rounded-full shrink-0 bg-violet-400" />
              <span className="text-xs font-data text-arena-elements-textSecondary">
                {selectedBlueprint?.name ?? 'Instance'} — New service will be created
                {selectedOperators.size > 0 && ` (${selectedOperators.size} operators)`}
              </span>
            </>
          ) : (
            <>
              {serviceInfo && (
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${serviceInfo.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                />
              )}
              {serviceLoading && (
                <span className="w-2 h-2 rounded-full shrink-0 bg-amber-400 animate-pulse" />
              )}
              <span className="text-xs font-data text-arena-elements-textSecondary">
                Service {serviceId}
                {serviceInfo && serviceInfo.isActive && ` (Active, ${serviceInfo.operators.length} operators)`}
                {serviceInfo && !serviceInfo.isActive && ' (Inactive)'}
                {serviceError && ' (Error)'}
                {serviceLoading && ' (Checking...)'}
                {discoveryLoading && ' (Discovering...)'}
              </span>
              {serviceInfo && !serviceInfo.isPermitted && userAddress && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">Not permitted</span>
              )}
              {serviceInfo?.blueprintMismatch && (
                <span className="text-[11px] text-crimson-600 dark:text-crimson-400">
                  Wrong blueprint (service uses #{serviceInfo.blueprintId})
                </span>
              )}
            </>
          )}
        </div>
        <span className="text-xs font-data text-arena-elements-textTertiary group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
          {isInstance ? 'Configure' : 'Change'}
        </span>
      </button>

      <Card>
        <CardContent className="pt-5 pb-4">
          <label htmlFor="agent-name" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
            Agent Name
          </label>
          <Input
            id="agent-name"
            placeholder="e.g. Alpha DEX Bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-5 space-y-4">
          <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
            Strategy Profile
          </span>
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-2">
              {strategyPacks.filter((p) => !p.id.startsWith('prediction')).map((p) => {
                const active = strategyType === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setStrategyType(p.id)}
                    className={`text-left rounded-lg border px-3.5 py-3 transition-all duration-150 ${
                      active
                        ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                        : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                    }`}
                  >
                    <div
                      className={`text-sm font-display font-semibold mb-0.5 ${active ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}
                    >
                      {p.name}
                    </div>
                    <div className="text-xs font-data text-arena-elements-textTertiary leading-snug line-clamp-2">
                      {p.providers.slice(0, 3).join(', ')}
                      {p.providers.length > 3 ? ` +${p.providers.length - 3}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
            <div>
              <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary block mb-1.5">
                Prediction Markets
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {strategyPacks.filter((p) => p.id.startsWith('prediction')).map((p) => {
                  const active = strategyType === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setStrategyType(p.id)}
                      className={`text-left rounded-lg border px-3.5 py-3 transition-all duration-150 ${
                        active
                          ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                          : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                      }`}
                    >
                      <div
                        className={`text-sm font-display font-semibold mb-0.5 ${active ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}
                      >
                        {p.name}
                      </div>
                      <div className="text-xs font-data text-arena-elements-textTertiary leading-snug line-clamp-2">
                        {p.providers.slice(0, 3).join(', ')}
                        {p.providers.length > 3 ? ` +${p.providers.length - 3}` : ''}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <p className="text-sm text-arena-elements-textSecondary leading-relaxed max-w-lg">
              {selectedPack.description}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAdvanced(true)}
              className="text-sm shrink-0 ml-4"
            >
              Customize
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-4 space-y-2">
          <label htmlFor="runtime-backend" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
            Runtime Backend
          </label>
          <select
            id="runtime-backend"
            value={runtimeBackend}
            onChange={(e) => setRuntimeBackend(e.target.value as 'docker' | 'firecracker' | 'tee')}
            disabled={selectedBlueprint?.isTee}
            className="w-full rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 px-3 py-2 text-sm text-arena-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          >
            <option value="docker">Docker (default)</option>
            <option value="firecracker" disabled={firecrackerBlocked}>
              {firecrackerBlocked ? 'Firecracker (microVM, unavailable)' : 'Firecracker (microVM)'}
            </option>
            <option value="tee">TEE (confidential)</option>
          </select>
          <p className="text-xs text-arena-elements-textTertiary">
            Stored in `strategy_config_json.runtime_backend` and mapped to sandbox runtime metadata.
            {selectedBlueprint?.isTee ? ' TEE blueprint is pinned to tee runtime.' : ''}
          </p>
          {firecrackerBlocked && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Firecracker runtime is currently unavailable and cannot be selected.
            </p>
          )}
        </CardContent>
      </Card>

      {isPrediction && (
        <Card>
          <CardContent className="pt-5 pb-4">
            <label htmlFor="collateral-cap" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
              CLOB Collateral Cap (%)
            </label>
            <div className="flex items-center gap-3">
              <Input
                id="collateral-cap"
                type="number"
                placeholder="0"
                value={collateralCapPct}
                onChange={(e) => setCollateralCapPct(e.target.value)}
                min={0}
                max={100}
                step={1}
                className="max-w-32"
              />
              <span className="text-sm text-arena-elements-textTertiary">%</span>
            </div>
            <p className="text-xs text-arena-elements-textTertiary mt-2">
              Max percentage of vault assets that can be released for off-chain CLOB trading. Leave at 0 to disable collateral release.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={goNext} disabled={!canNext} size="lg">
          Next: Provision Agent
        </Button>
      </div>
    </>
  );
}
