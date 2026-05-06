import { Button, Card, CardContent, Input } from '@tangle-network/blueprint-ui/components';
import { Plus, X } from 'lucide-react';
import type { Address } from 'viem';
import type { DexAssetSelection } from '~/lib/assetUniverse';
import { strategyPacks, type StrategyPackDef } from '~/lib/blueprints';
import { truncateAddress } from '~/lib/format';
import type { ServiceInfo } from '~/routes/provision/types';

const CLOB_COLLATERAL_STRATEGY_IDS = new Set(['volatility', 'mm', 'multi']);

export function strategySupportsClobCollateral(
  strategyType: string,
  selectedPack: Pick<StrategyPackDef, 'providers'>,
): boolean {
  if (strategyType.startsWith('prediction')) return true;
  if (CLOB_COLLATERAL_STRATEGY_IDS.has(strategyType)) return true;
  return selectedPack.providers.some((provider) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === 'polymarket' || normalized === 'all protocols';
  });
}

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
  strategyExecutionNotice?: string | null;
  assetOptions?: DexAssetSelection[];
  baseAssetAddress?: Address;
  setBaseAssetAddress?: (v: Address) => void;
  selectedAssetAddresses?: Address[];
  addAssetToUniverse?: (value: string) => boolean;
  removeAssetFromUniverse?: (address: Address) => void;
  manualAssetInput?: string;
  setManualAssetInput?: (v: string) => void;
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
  strategyExecutionNotice,
  assetOptions = [],
  baseAssetAddress,
  setBaseAssetAddress = () => {},
  selectedAssetAddresses = [],
  addAssetToUniverse = () => false,
  removeAssetFromUniverse = () => {},
  manualAssetInput = '',
  setManualAssetInput = () => {},
  collateralCapPct,
  setCollateralCapPct,
  canNext,
  goNext,
}: ConfigureStepProps) {
  const supportsClobCollateral = strategySupportsClobCollateral(strategyType, selectedPack);
  const isDexStrategy = strategyType === 'dex';
  const effectiveBaseAssetAddress =
    baseAssetAddress ?? selectedAssetAddresses[0] ?? assetOptions[0]?.address;
  const selectedAssets = selectedAssetAddresses
    .map((address) => {
      const option = assetOptions.find(
        (asset) => asset.address.toLowerCase() === address.toLowerCase(),
      );
      return option ?? {
        address,
        symbol: truncateAddress(address),
        name: 'Custom asset',
        decimals: 18,
        known: false,
      };
    });
  const baseAssetChoices = [...assetOptions];
  for (const asset of selectedAssets) {
    if (
      !baseAssetChoices.some(
        (choice) => choice.address.toLowerCase() === asset.address.toLowerCase(),
      )
    ) {
      baseAssetChoices.push(asset);
    }
  }
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

      {isDexStrategy && (
        <Card>
          <CardContent className="pt-5 pb-5 space-y-4">
            <div>
              <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
                Asset Universe
              </span>
              <p className="text-xs text-arena-elements-textTertiary mt-1">
                The bot can swap and hold only these selected Uniswap assets. Live valuation uses Chainlink.
              </p>
            </div>

            <label className="block">
              <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary block mb-1.5">
                Base Asset
              </span>
              <select
                value={effectiveBaseAssetAddress ?? ''}
                onChange={(event) => setBaseAssetAddress(event.target.value as Address)}
                className="w-full rounded-md border border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 px-3 py-2 text-sm text-arena-elements-textPrimary"
              >
                {baseAssetChoices.map((asset) => (
                  <option key={asset.address} value={asset.address}>
                    {asset.symbol} - {asset.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-arena-elements-textTertiary mt-1.5 block">
                The base asset is included automatically.
              </span>
            </label>

            <div className="space-y-2">
              <span className="text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary block">
                Allowed Assets
              </span>
              <div className="flex flex-wrap gap-2">
                {selectedAssets.map((asset) => {
                  const isBase =
                    effectiveBaseAssetAddress != null &&
                    asset.address.toLowerCase() === effectiveBaseAssetAddress.toLowerCase();
                  return (
                    <span
                      key={asset.address}
                      className="inline-flex items-center gap-2 rounded-md border border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 px-2.5 py-1.5 text-sm"
                    >
                      <span className="font-medium text-arena-elements-textPrimary">
                        {asset.symbol}
                      </span>
                      <span className="text-xs text-arena-elements-textTertiary">
                        {asset.known ? 'Chainlink ready' : 'Chainlink feed required'}
                      </span>
                      {!isBase && (
                        <button
                          type="button"
                          onClick={() => removeAssetFromUniverse(asset.address)}
                          className="text-arena-elements-textTertiary hover:text-arena-elements-textPrimary"
                          aria-label={`Remove ${asset.symbol}`}
                          title={`Remove ${asset.symbol}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input
                  placeholder="Type WETH, DAI, WBTC, or a token address"
                  value={manualAssetInput}
                  onChange={(event) => setManualAssetInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addAssetToUniverse(manualAssetInput);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => addAssetToUniverse(manualAssetInput)}
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
          {strategyExecutionNotice && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {strategyExecutionNotice}
            </p>
          )}
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

      {supportsClobCollateral && (
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
