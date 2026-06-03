import { Button } from '@tangle-network/blueprint-ui/components';
import type { ReactNode } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Plus,
  SlidersHorizontal,
  WalletCards,
  X,
} from 'lucide-react';
import type { Address } from 'viem';
import {
  strategyUsesDexAssetUniverse,
  type DexAssetSelection,
} from '~/lib/assetUniverse';
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
  addAssetToUniverse?: (value: string) => boolean | Promise<boolean>;
  removeAssetFromUniverse?: (address: Address) => void;
  manualAssetInput?: string;
  setManualAssetInput?: (v: string) => void;
  customAssetChecking?: boolean;
  customAssetError?: string | null;
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
  customAssetChecking = false,
  customAssetError = null,
  collateralCapPct,
  setCollateralCapPct,
  canNext,
  goNext,
}: ConfigureStepProps) {
  const supportsClobCollateral = strategySupportsClobCollateral(strategyType, selectedPack);
  const isDexStrategy = strategyUsesDexAssetUniverse(strategyType);
  const effectiveBaseAssetAddress =
    baseAssetAddress ?? selectedAssetAddresses[0] ?? assetOptions[0]?.address;
  const selectedAssetSet = new Set(
    selectedAssetAddresses.map((address) => address.toLowerCase()),
  );
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
  const baseAssetChoices = selectedAssets;
  const primaryPacks = strategyPacks.filter((p) => !p.id.startsWith('prediction'));
  const predictionPacks = strategyPacks.filter((p) => p.id.startsWith('prediction'));
  const providerLabel = selectedPack.providers.slice(0, 3).join(', ');
  const executionModeLabel = formatExecutionMode(selectedPack.executionMode);
  const selectedAssetLabel =
    isDexStrategy && selectedAssets.length > 0
      ? selectedAssets.map((asset) => asset.symbol).join(' / ')
      : isDexStrategy
        ? 'No Assets'
        : 'Strategy Defined';
  const infrastructureSummary = isInstance
    ? `Instance service mode with ${selectedOperators.size} selected operator${selectedOperators.size === 1 ? '' : 's'}.`
    : `Service #${serviceId}: ${
        serviceLoading
          ? 'checking status…'
          : serviceError
            ? 'status unavailable'
            : !serviceInfo
              ? 'not validated yet'
              : serviceInfo?.isActive
                ? 'active'
                : 'inactive'
      }${serviceInfo ? `, ${serviceInfo.isPermitted ? 'permitted' : 'not permitted'}` : ''}${serviceInfo?.blueprintMismatch ? `, wrong blueprint (#${serviceInfo.blueprintId})` : ''}`;
  const routeStatus = serviceError || serviceInfo?.blueprintMismatch
    ? 'Needs Review'
    : serviceLoading
      ? 'Checking'
      : serviceInfo?.isActive && serviceInfo.isPermitted
        ? 'Online'
        : isInstance && selectedOperators.size > 0
          ? 'Operator Selected'
          : 'Draft';
  const readinessLabel = canNext ? 'Ready' : 'Needs Setup';
  const routeDetail = isInstance
    ? `${selectedOperators.size} operator${selectedOperators.size === 1 ? '' : 's'} selected`
    : `Service #${serviceId}`;

  return (
    <div className="arena-trace-terminal overflow-hidden rounded-[7px] border border-[#273035] bg-[#081013] text-[#f6fefd]">
      <div className="grid gap-px bg-[#273035] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)]">
        <LaunchHeaderCell
          icon={<Database className="h-4 w-4" />}
          label="Strategy"
          value={selectedPack.name}
          detail={providerLabel}
        />
        <LaunchHeaderCell
          icon={<WalletCards className="h-4 w-4" />}
          label="Route"
          value={routeStatus}
          detail={routeDetail}
        />
        <LaunchHeaderCell
          icon={canNext ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
          label="Risk"
          value={readinessLabel}
          detail={executionModeLabel}
          tone={canNext ? 'ready' : 'pending'}
        />
      </div>

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <ProvisionPanel title="Command">
            <label htmlFor="agent-name" className="block">
              <span className="mb-1.5 block font-display text-sm font-semibold text-[#f6fefd]">
                Agent Name
              </span>
              <input
                id="agent-name"
                name="agent-name"
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. Base USDC/WETH swing bot…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-10 w-full rounded-[5px] border border-[#273035] bg-[#081013] px-3.5 py-2 font-mono text-sm text-[#f6fefd] placeholder:text-[#697371] transition-[border-color,box-shadow] duration-150 hover:border-[#3a464a] focus-visible:border-[#50d2c1]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/35"
              />
            </label>
          </ProvisionPanel>

          <ProvisionPanel title="Strategy" action={(
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAdvanced(true)}
              className="h-8 gap-2 rounded-[5px] border-[#273035] bg-[#0f1a1f] px-3 font-display text-xs text-[#d2dad7] transition-[background-color,border-color,color] duration-150 hover:border-[#50d2c1]/50 hover:bg-[#143c38] hover:text-[#f6fefd]"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              Customize
            </Button>
          )}>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {primaryPacks.map((pack) => (
                <StrategyPackButton
                  key={pack.id}
                  pack={pack}
                  active={strategyType === pack.id}
                  onClick={() => setStrategyType(pack.id)}
                />
              ))}
            </div>
            {predictionPacks.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[#50d2c1]">
                  <span className="i-ph:newspaper-clipping text-sm" aria-hidden="true" />
                  Prediction Markets
                </div>
                <div className="flex flex-wrap gap-2">
                  {predictionPacks.map((pack) => (
                    <PredictionPackButton
                      key={pack.id}
                      pack={pack}
                      active={strategyType === pack.id}
                      onClick={() => setStrategyType(pack.id)}
                    />
                  ))}
                </div>
              </div>
            )}
            {strategyExecutionNotice && (
              <p className="mt-3 rounded-[5px] border border-[#6f5723] bg-[#201808] px-3 py-2 font-mono text-xs text-[#f2c066]">
                {strategyExecutionNotice}
              </p>
            )}
          </ProvisionPanel>
        </div>

        <aside className="space-y-3">
          <ProvisionPanel title="Launch Summary">
            <div className="space-y-3">
              <ReadRow label="Pack" value={selectedPack.name} />
              <ReadRow label="Mode" value={executionModeLabel} />
              <ReadRow label="Venue" value={providerLabel} />
              <ReadRow label="Assets" value={selectedAssetLabel} />
              <div className="rounded-[5px] border border-[#273035] bg-[#081013] p-3">
                <p className="text-sm leading-5 text-[#d2dad7]">
                  {selectedPack.description}
                </p>
              </div>
            </div>
          </ProvisionPanel>

          {isDexStrategy && (
            <ProvisionPanel title="Assets">
              <div className="grid grid-cols-2 gap-2">
                {assetOptions.map((asset) => {
                  const selected = selectedAssetSet.has(asset.address.toLowerCase());
                  const isBase =
                    effectiveBaseAssetAddress != null &&
                    asset.address.toLowerCase() === effectiveBaseAssetAddress.toLowerCase();
                  return (
                    <button
                      key={asset.address}
                      type="button"
                      onClick={() => {
                        if (selected) {
                          removeAssetFromUniverse(asset.address);
                        } else {
                          void addAssetToUniverse(asset.address);
                        }
                      }}
                      className={`grid min-h-[50px] grid-cols-[24px_minmax(0,1fr)_14px] items-center gap-2 rounded-[5px] border px-2 py-1.5 text-left transition-[background-color,border-color,opacity,transform] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
                        selected
                          ? 'border-[#50d2c1]/70 bg-[#143c38] text-[#f6fefd]'
                          : 'border-[#273035] bg-[#0f1a1f] text-[#d2dad7] hover:border-[#50d2c1]/40 hover:bg-[#132329]'
                      }`}
                      aria-pressed={selected}
                    >
                      <AssetLogo asset={asset} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate font-display text-xs font-semibold">{asset.symbol}</span>
                        <span className="block truncate font-mono text-[10px] text-[#949e9c]">
                          {isBase ? 'Base' : asset.name}
                        </span>
                      </span>
                      {selected && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#50d2c1]" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>

              {selectedAssets.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {selectedAssets.map((asset) => {
                    const isBase =
                      effectiveBaseAssetAddress != null &&
                      asset.address.toLowerCase() === effectiveBaseAssetAddress.toLowerCase();
                    return (
                      <span
                        key={asset.address}
                        className="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-[#273035] bg-[#0f1a1f] px-2 text-xs"
                      >
                        <AssetLogo asset={asset} size="sm" />
                        <span className="font-display font-semibold text-[#f6fefd]">
                          {asset.symbol}
                        </span>
                        <span
                          className={
                            asset.valuationSource === 'uniswap_v3_twap'
                              ? 'font-mono text-[10px] text-[#f2c066]'
                              : 'font-mono text-[10px] text-[#949e9c]'
                          }
                          title={
                            asset.valuationSource === 'uniswap_v3_twap'
                              ? 'No Chainlink feed: priced from a Uniswap V3 TWAP. Higher oracle-manipulation risk than Chainlink-priced assets.'
                              : undefined
                          }
                        >
                          {isBase
                            ? 'Base'
                            : asset.known || asset.valuationSource === 'chainlink'
                              ? 'Chainlink'
                              : asset.valuationSource === 'uniswap_v3_twap'
                                ? 'TWAP'
                                : 'Check'}
                        </span>
                        {!isBase && (
                          <button
                            type="button"
                            onClick={() => removeAssetFromUniverse(asset.address)}
                            className="rounded-[4px] text-[#697371] transition-colors hover:text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                            aria-label={`Remove ${asset.symbol}`}
                            title={`Remove ${asset.symbol}`}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="mt-2 grid gap-2">
                <label htmlFor="custom-token-address" className="sr-only">
                  Token Address
                </label>
                <input
                  id="custom-token-address"
                  name="custom-token-address"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x token address…"
                  value={manualAssetInput}
                  onChange={(event) => setManualAssetInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addAssetToUniverse(manualAssetInput);
                    }
                  }}
                  className="h-9 w-full rounded-[5px] border border-[#273035] bg-[#081013] px-3 py-2 font-mono text-xs text-[#f6fefd] placeholder:text-[#697371] transition-[border-color,box-shadow] duration-150 hover:border-[#3a464a] focus-visible:border-[#50d2c1]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/35"
                  aria-invalid={customAssetError ? 'true' : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={customAssetChecking}
                  onClick={() => void addAssetToUniverse(manualAssetInput)}
                  className="h-9 gap-2 rounded-[5px] border-[#273035] bg-[#0f1a1f] px-3 text-xs text-[#d2dad7] transition-[background-color,border-color,color,opacity] duration-150 hover:border-[#50d2c1]/50 hover:bg-[#143c38] hover:text-[#f6fefd]"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {customAssetChecking ? 'Checking…' : 'Add Token'}
                </Button>
              </div>
              {customAssetError && (
                <p className="mt-2 font-mono text-xs text-[#ff7f7f]" aria-live="polite">
                  {customAssetError}
                </p>
              )}

              <label className="mt-2 block">
                <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#697371]">
                  Base Asset
                </span>
                <select
                  value={effectiveBaseAssetAddress ?? ''}
                  onChange={(event) => setBaseAssetAddress(event.target.value as Address)}
                  disabled={baseAssetChoices.length === 0}
                  className="h-9 w-full rounded-[5px] border border-[#273035] bg-[#081013] px-3 font-mono text-xs text-[#f6fefd] disabled:opacity-60"
                >
                  {baseAssetChoices.map((asset) => (
                    <option key={asset.address} value={asset.address}>
                      {asset.symbol} - {asset.name}
                    </option>
                  ))}
                </select>
              </label>
            </ProvisionPanel>
          )}

          <ProvisionPanel title="Operator Route">
            <div className="flex items-start gap-3">
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                  routeStatus === 'Online' || routeStatus === 'Operator Selected'
                    ? 'bg-[#50d2c1]'
                    : routeStatus === 'Checking'
                      ? 'bg-[#f2c066]'
                      : 'bg-[#697371]'
                }`}
                aria-hidden="true"
              />
              <p className="min-w-0 font-mono text-xs leading-5 text-[#d2dad7]">
                {infrastructureSummary}
              </p>
            </div>
          </ProvisionPanel>

          {supportsClobCollateral && (
            <ProvisionPanel title="Collateral">
              <label htmlFor="collateral-cap" className="block">
                <span className="mb-2 block font-display text-sm font-semibold text-[#f6fefd]">
                  CLOB Collateral Cap (%)
                </span>
                <div className="flex items-center gap-3">
                  <input
                    id="collateral-cap"
                    name="collateral-cap"
                    aria-label="CLOB Collateral Cap (%)"
                    type="number"
                    inputMode="numeric"
                    value={collateralCapPct}
                    onChange={(e) => setCollateralCapPct(e.target.value)}
                    min={0}
                    max={100}
                    step={1}
                    className="h-10 max-w-32 rounded-[5px] border border-[#273035] bg-[#081013] px-3 py-2 font-mono text-sm text-[#f6fefd] transition-[border-color,box-shadow] duration-150 hover:border-[#3a464a] focus-visible:border-[#50d2c1]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/35"
                  />
                  <span className="font-mono text-sm text-[#949e9c]">%</span>
                </div>
              </label>
            </ProvisionPanel>
          )}

          <Button
            onClick={goNext}
            disabled={!canNext}
            size="lg"
            className="h-12 w-full rounded-[5px] bg-[#50d2c1] font-display text-sm font-semibold text-[#06100e] transition-[background-color,opacity,transform] duration-150 hover:bg-[#7ce6d9] active:scale-[0.98] disabled:opacity-45"
          >
            Review Provision
          </Button>
        </aside>
      </div>
    </div>
  );
}

function LaunchHeaderCell({
  icon,
  label,
  value,
  detail,
  tone = 'default',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'ready' | 'pending';
}) {
  const iconClassName = tone === 'ready'
    ? 'border-[#1d5b52] bg-[#143c38] text-[#50d2c1]'
    : tone === 'pending'
      ? 'border-[#6f5723] bg-[#201808] text-[#f2c066]'
      : 'border-[#273035] bg-[#0f1a1f] text-[#d2dad7]';
  return (
    <div className="flex min-h-[66px] items-center gap-3 bg-[#0b1418] px-4 py-2.5">
      <span
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[5px] border ${iconClassName}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#697371]">
          {label}
        </div>
        <div className="mt-0.5 truncate font-display text-base font-semibold text-[#f6fefd]">
          {value}
        </div>
        <div className="truncate font-mono text-xs text-[#949e9c]">
          {detail}
        </div>
      </div>
    </div>
  );
}

function ProvisionPanel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[7px] border border-[#273035] bg-[#0b1418]">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-[#273035] px-4 py-2">
        <h2 className="font-display text-sm font-semibold text-[#f6fefd]">{title}</h2>
        {action}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function formatExecutionMode(mode: StrategyPackDef['executionMode']): string {
  if (mode === 'single-chain') return 'Single Chain';
  if (mode === 'paper-only') return 'Paper Only';
  return 'Multi Route';
}

function strategyPackIcon(pack: StrategyPackDef): string {
  if (pack.id.startsWith('prediction')) return 'i-ph:newspaper-clipping';
  if (pack.id === 'hyperliquid_perp' || pack.id === 'perp') return 'i-ph:chart-line-up';
  if (pack.id === 'yield') return 'i-ph:bank';
  if (pack.id === 'mm') return 'i-ph:currency-circle-dollar';
  if (pack.id === 'volatility') return 'i-ph:wave-sine';
  if (pack.id === 'multi') return 'i-ph:strategy';
  return 'i-ph:swap';
}

function StrategyPackButton({
  pack,
  active,
  onClick,
}: {
  pack: StrategyPackDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid min-h-[58px] grid-cols-[26px_minmax(0,1fr)] gap-2 rounded-[5px] border px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
        active
          ? 'border-[#50d2c1]/70 bg-[#143c38] shadow-[inset_3px_0_0_rgba(80,210,193,0.9)]'
          : 'border-[#273035] bg-[#0f1a1f] hover:border-[#50d2c1]/40 hover:bg-[#132329]'
      }`}
    >
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border ${
          active
            ? 'border-[#50d2c1]/40 bg-[#081013] text-[#50d2c1]'
            : 'border-[#273035] bg-[#081013] text-[#949e9c]'
        }`}
        aria-hidden="true"
      >
        <span className={`${strategyPackIcon(pack)} text-sm`} />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-sm font-semibold leading-4 text-[#f6fefd]">
          {pack.name}
        </span>
        <span className="mt-0.5 block line-clamp-1 font-mono text-[11px] text-[#949e9c]">
          {pack.providers.slice(0, 3).join(', ')}
          {pack.providers.length > 3 ? ` +${pack.providers.length - 3}` : ''}
        </span>
        <span className="mt-1 inline-flex rounded-[4px] border border-[#273035] bg-[#081013] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[#697371]">
          {formatExecutionMode(pack.executionMode)}
        </span>
      </span>
    </button>
  );
}

function PredictionPackButton({
  pack,
  active,
  onClick,
}: {
  pack: StrategyPackDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 max-w-full items-center gap-2 rounded-[5px] border px-2.5 font-display text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
        active
          ? 'border-[#50d2c1]/70 bg-[#143c38] text-[#f6fefd]'
          : 'border-[#273035] bg-[#0f1a1f] text-[#d2dad7] hover:border-[#50d2c1]/40 hover:bg-[#132329]'
      }`}
    >
      <span className={`${strategyPackIcon(pack)} shrink-0 text-sm`} aria-hidden="true" />
      <span className="truncate">{pack.name}</span>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#697371]">
        {pack.executionMode === 'paper-only' ? 'Paper' : 'Live'}
      </span>
    </button>
  );
}

function AssetLogo({
  asset,
  size = 'md',
}: {
  asset: DexAssetSelection;
  size?: 'sm' | 'md';
}) {
  const isSmall = size === 'sm';
  const sizeClassName = isSmall ? 'h-5 w-5 text-[9px]' : 'h-7 w-7 text-[10px]';
  const pixelSize = isSmall ? 20 : 28;
  const fallbackText = asset.symbol.trim().slice(0, 3).toUpperCase() || '?';

  if (asset.logoUri) {
    return (
      <img
        src={asset.logoUri}
        alt=""
        width={pixelSize}
        height={pixelSize}
        loading="lazy"
        decoding="async"
        className={`${sizeClassName} shrink-0 rounded-full bg-white object-cover ring-1 ring-white/10`}
      />
    );
  }

  return (
    <span
      className={`${sizeClassName} flex shrink-0 items-center justify-center rounded-full bg-[#081013] font-mono font-semibold text-[#50d2c1] ring-1 ring-[#273035]`}
      aria-hidden="true"
    >
      {fallbackText}
    </span>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-3 border-b border-[#273035] pb-2 last:border-b-0 last:pb-0">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#697371]">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-[#f6fefd]">{value}</span>
    </div>
  );
}
