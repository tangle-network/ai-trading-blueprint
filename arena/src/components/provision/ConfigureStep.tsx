import { Button, Card, CardContent, Input } from '@tangle-network/blueprint-ui/components';
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
  const strategyGroups = [
    {
      label: 'Trading Strategies',
      columns: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
      packs: strategyPacks.filter((p) => !p.id.startsWith('prediction')),
    },
    {
      label: 'Prediction Markets',
      columns: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6',
      packs: strategyPacks.filter((p) => p.id.startsWith('prediction')),
    },
  ];

  return (
    <>
      <Card>
        <CardContent className="space-y-3 pt-5 pb-5">
          <label htmlFor="agent-name" className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary mb-2 block">
            Agent Name
          </label>
          <Input
            id="agent-name"
            placeholder="e.g. Alpha DEX Bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 text-sm"
          />
          <p className="text-sm text-arena-elements-textSecondary">
            This label is shown anywhere the agent appears in the arena, wallet views, and service history.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 pt-5 pb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                Strategy Profile
              </span>
              <p className="mt-1 text-sm text-arena-elements-textSecondary">
                Pick the operating profile you want this agent to run with. Each profile ships different market sources, cadence, and execution assumptions.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAdvanced(true)}
              className="h-10 shrink-0 px-4 text-sm"
            >
              Customize
            </Button>
          </div>

          <div className="arena-panel-inset rounded-2xl p-4 sm:p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-display text-lg font-semibold text-arena-elements-textPrimary">
                    {selectedPack.name}
                  </div>
                  <span className="inline-flex items-center rounded-full bg-violet-500/12 px-2.5 py-1 text-[10px] font-data font-semibold uppercase tracking-[0.18em] text-violet-700 dark:text-violet-400">
                    {selectedPack.providers[0] ?? 'Arena'}
                  </span>
                  {isPrediction && (
                    <span className="inline-flex items-center rounded-full bg-blue-500/12 px-2.5 py-1 text-[10px] font-data font-semibold uppercase tracking-[0.18em] text-blue-700 dark:text-blue-400">
                      Prediction
                    </span>
                  )}
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-arena-elements-textSecondary">
                  {selectedPack.description}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs font-data text-arena-elements-textSecondary sm:min-w-[240px]">
                <div className="rounded-xl bg-arena-elements-background-depth-3/70 px-3 py-2">
                  <div className="uppercase tracking-[0.18em] text-arena-elements-textTertiary">Cadence</div>
                  <div className="mt-1 text-sm font-semibold text-arena-elements-textPrimary">{selectedPack.cron}</div>
                </div>
                <div className="rounded-xl bg-arena-elements-background-depth-3/70 px-3 py-2">
                  <div className="uppercase tracking-[0.18em] text-arena-elements-textTertiary">Providers</div>
                  <div className="mt-1 text-sm font-semibold text-arena-elements-textPrimary">{selectedPack.providers.length}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {strategyGroups.map((group) => (
              <div key={group.label} className="space-y-2.5">
                <span className="text-[11px] font-data uppercase tracking-[0.22em] text-arena-elements-textTertiary block">
                  {group.label}
                </span>
                <div className={`grid gap-3 ${group.columns}`}>
                  {group.packs.map((p) => {
                    const active = strategyType === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setStrategyType(p.id)}
                        className={`min-h-[108px] rounded-xl border px-4 py-3.5 text-left transition-all duration-150 ${
                          active
                            ? 'border-violet-500/45 bg-violet-500/8 shadow-[0_14px_34px_rgba(109,40,217,0.12)] ring-1 ring-violet-500/20'
                            : 'border-arena-elements-borderColor bg-arena-elements-background-depth-3/90 hover:border-arena-elements-borderColorActive/40 hover:bg-arena-elements-item-backgroundHover/80 dark:bg-arena-elements-background-depth-1'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div
                              className={`text-sm font-display font-semibold ${active ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}
                            >
                              {p.name}
                            </div>
                            <div className="mt-1 text-xs font-data uppercase tracking-[0.16em] text-arena-elements-textTertiary">
                              {p.providers.slice(0, 2).join(' / ')}
                            </div>
                          </div>
                          {active && (
                            <div className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-violet-500/14 text-violet-600 dark:text-violet-400">
                              <div className="i-ph:check-bold text-xs" />
                            </div>
                          )}
                        </div>
                        <div className="mt-3 text-sm leading-relaxed text-arena-elements-textSecondary line-clamp-3">
                          {p.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-arena-elements-textTertiary">
            Runtime backend and infrastructure controls are available in Advanced Settings.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-5 pb-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
              Infrastructure Status
            </span>
            <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] font-data font-semibold uppercase tracking-[0.16em] ${
              isInstance
                ? 'bg-blue-500/12 text-blue-700 dark:text-blue-400'
                : serviceInfo?.isActive
                  ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/12 text-amber-700 dark:text-amber-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                isInstance
                  ? 'bg-blue-500'
                  : serviceInfo?.isActive
                    ? 'bg-emerald-500'
                    : 'bg-amber-500'
              }`} />
              {isInstance ? 'Instance mode' : serviceInfo?.isActive ? 'Service active' : 'Needs review'}
            </span>
          </div>
          <div className="arena-panel-inset rounded-xl p-4">
            {isInstance ? (
              <p className="text-sm text-arena-elements-textSecondary">
                Instance service mode with <span className="font-semibold text-arena-elements-textPrimary">{selectedOperators.size}</span> selected operator{selectedOperators.size === 1 ? '' : 's'}.
              </p>
            ) : (
              <p className="text-sm text-arena-elements-textSecondary">
                Service <span className="font-semibold text-arena-elements-textPrimary">#{serviceId}</span>{' '}
                {serviceLoading
                  ? 'is being checked'
                  : serviceError
                    ? 'could not be verified yet'
                    : !serviceInfo
                      ? 'has not been validated yet'
                      : serviceInfo?.isActive
                        ? 'is active'
                        : 'is inactive'}
                {serviceInfo && ` and ${serviceInfo.isPermitted ? 'your wallet is permitted to use it' : 'your wallet is not yet permitted'}`}
                {serviceInfo?.blueprintMismatch && `; it currently points at blueprint #${serviceInfo.blueprintId}`}
                .
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {isPrediction && (
        <Card>
          <CardContent className="space-y-3 pt-5 pb-5">
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
                className="h-12 max-w-36 text-sm"
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
        <Button onClick={goNext} disabled={!canNext} size="lg" className="px-5">
          Next: Provision Agent
        </Button>
      </div>
    </>
  );
}
