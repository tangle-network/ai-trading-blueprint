import { Button, Card, CardContent, Input } from '@tangle/blueprint-ui/components';
import type { Address } from 'viem';
import { strategyPacks, type StrategyPackDef } from '~/lib/blueprints';
import type { ServiceInfo } from '~/routes/provision/types';

interface ConfigureStepProps {
  name: string;
  setName: (v: string) => void;
  strategyType: string;
  setStrategyType: (v: string) => void;
  selectedPack: StrategyPackDef;
  isInstance: boolean;
  serviceId: string;
  serviceInfo: ServiceInfo | null;
  serviceLoading: boolean;
  serviceError: string | null;
  selectedOperators: Set<Address>;
  setShowAdvanced: (v: boolean) => void;
  collateralCapPct: string;
  setCollateralCapPct: (v: string) => void;
  canNext: boolean;
  goNext: () => void;
}

export function ConfigureStep({
  name,
  setName,
  strategyType,
  setStrategyType,
  selectedPack,
  isInstance,
  serviceId,
  serviceInfo,
  serviceLoading,
  serviceError,
  selectedOperators,
  setShowAdvanced,
  collateralCapPct,
  setCollateralCapPct,
  canNext,
  goNext,
}: ConfigureStepProps) {
  const isPrediction = strategyType.startsWith('prediction');
  return (
    <>
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
          <p className="text-xs text-arena-elements-textTertiary">
            Runtime backend and infrastructure controls are available in Advanced Settings.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-4 space-y-2">
          <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
            Infrastructure Status
          </span>
          {isInstance ? (
            <p className="text-xs text-arena-elements-textTertiary">
              Instance service mode with {selectedOperators.size} selected operator{selectedOperators.size === 1 ? '' : 's'}.
            </p>
          ) : (
            <p className="text-xs text-arena-elements-textTertiary">
              Service #{serviceId}:{' '}
              {serviceLoading
                ? 'checking status...'
                : serviceError
                  ? 'status unavailable'
                  : !serviceInfo
                    ? 'not validated yet'
                  : serviceInfo?.isActive
                    ? 'active'
                    : 'inactive'}
              {serviceInfo && `, ${serviceInfo.isPermitted ? 'permitted' : 'not permitted'}`}
              {serviceInfo?.blueprintMismatch && `, wrong blueprint (#${serviceInfo.blueprintId})`}
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
