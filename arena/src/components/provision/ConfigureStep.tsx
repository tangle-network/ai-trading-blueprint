import { Button } from '@tangle-network/blueprint-ui/components';
import { useRef, type CSSProperties, type ReactNode } from 'react';
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
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  shouldCollapsePaneSize,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls';

const CLOB_COLLATERAL_STRATEGY_IDS = new Set(['volatility', 'mm', 'multi']);

interface ConfigureStepLayout {
  railWidth: number;
  railCollapsed: boolean;
}

const CONFIGURE_STEP_LAYOUT_KEY = 'arena:configure-step-layout';
const DEFAULT_CONFIGURE_STEP_LAYOUT: ConfigureStepLayout = {
  railWidth: 324,
  railCollapsed: false,
};

function normalizeConfigureStepLayout(value: Partial<ConfigureStepLayout>): ConfigureStepLayout {
  return {
    railWidth: clampNumber(
      Number(value.railWidth) || DEFAULT_CONFIGURE_STEP_LAYOUT.railWidth,
      300,
      480,
    ),
    railCollapsed: value.railCollapsed === true,
  };
}

function showsPredictionMarketChoices(
  strategyType: string,
  selectedPack: Pick<StrategyPackDef, 'providers'>,
): boolean {
  if (strategyType.startsWith('prediction')) return true;
  return selectedPack.providers.some((provider) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === 'polymarket' || normalized === 'all protocols';
  });
}

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
  agentProfileName?: string;
  agentProfileObjective?: string;
  isInstance: boolean;
  serviceId: string;
  serviceInfo: ServiceInfo | null;
  serviceLoading: boolean;
  serviceError: string | null;
  selectedOperators: Set<Address>;
  setShowAdvanced: (v: boolean) => void;
  strategyExecutionNotice?: string | null;
  profileLaunchMode?: boolean;
  capabilityFocusLabels?: string[];
  availableProtocolCount?: number;
  executionTargetLabel?: string;
  executionTargetDescription?: string;
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
  agentProfileName,
  agentProfileObjective,
  isInstance,
  serviceId,
  serviceInfo,
  serviceLoading,
  serviceError,
  selectedOperators,
  setShowAdvanced,
  strategyExecutionNotice,
  profileLaunchMode = false,
  capabilityFocusLabels,
  availableProtocolCount,
  executionTargetLabel,
  executionTargetDescription,
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
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    CONFIGURE_STEP_LAYOUT_KEY,
    DEFAULT_CONFIGURE_STEP_LAYOUT,
    normalizeConfigureStepLayout,
  );
  const isHyperliquidStrategy = strategyType === 'hyperliquid_perp';
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
  const primaryPacks = [...strategyPacks]
    .filter((p) => !p.id.startsWith('prediction'))
    .sort(compareStrategyPackPriority);
  const predictionPacks = strategyPacks.filter((p) => p.id.startsWith('prediction'));
  const showPredictionPacks =
    predictionPacks.length > 0 &&
    showsPredictionMarketChoices(strategyType, selectedPack);
  const providerLabel = selectedPack.providers.slice(0, 3).join(', ');
  const capabilitySummaryLabels = capabilityFocusLabels?.length
    ? capabilityFocusLabels
    : [selectedPack.name];
  const inheritedFocusLabel = capabilitySummaryLabels.join(', ');
  const isProfileLaunch = profileLaunchMode || Boolean(agentProfileName || capabilityFocusLabels?.length);
  const accessLabel = availableProtocolCount && availableProtocolCount > 0
    ? `${availableProtocolCount} wired protocols`
    : providerLabel;
  const executionModeLabel = formatExecutionMode(selectedPack.executionMode);
  const selectedAssetLabel =
    isDexStrategy && selectedAssets.length > 0
      ? selectedAssets.map((asset) => asset.symbol).join(' / ')
      : isDexStrategy
        ? 'No Assets'
        : 'Profile Defined';
  const profileLabel = agentProfileName || name || inheritedFocusLabel;
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
  const workspaceStyle = {
    '--configure-rail-width': `${layout.railWidth}px`,
  } as CSSProperties;
  const workspaceGridClass = layout.railCollapsed
    ? 'lg:grid-cols-[minmax(0,1fr)_8px_44px]'
    : 'lg:grid-cols-[minmax(0,1fr)_8px_minmax(300px,var(--configure-rail-width))]';
  const startRailResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    setLayout((current) => ({ ...current, railCollapsed: false }));
    beginWorkspaceResize(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const maxWidth = Math.min(480, Math.max(340, rect.width * 0.4));
        const rawWidth = rect.right - moveEvent.clientX;
        if (shouldCollapsePaneSize(rawWidth)) {
          setLayout((current) => ({
            ...current,
            railCollapsed: true,
          }));
          return;
        }
        const nextWidth = clampNumber(rawWidth, 300, maxWidth);
        setLayout((current) => ({
          ...current,
          railWidth: nextWidth,
          railCollapsed: false,
        }));
      },
    });
  };

  return (
    <div className="arena-trace-terminal flex min-h-full flex-col overflow-hidden bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <div className="grid gap-px bg-[var(--arena-terminal-border)] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)]">
        <LaunchHeaderCell
          icon={<Database className="h-4 w-4" />}
          label="Agent Profile"
          value={profileLabel}
          detail={accessLabel}
        />
        <LaunchHeaderCell
          icon={<WalletCards className="h-4 w-4" />}
          label="Infrastructure"
          value={routeStatus}
          detail={routeDetail}
        />
        <LaunchHeaderCell
          icon={canNext ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
          label="Readiness"
          value={readinessLabel}
          detail={executionModeLabel}
          tone={canNext ? 'ready' : 'pending'}
        />
      </div>

      <div
        ref={workspaceRef}
        className={`grid gap-px bg-[var(--arena-terminal-border)] lg:min-h-0 ${workspaceGridClass}`}
        style={workspaceStyle}
      >
        <div className="grid content-start gap-px lg:col-start-1 lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
          <ProvisionPanel title="Agent Identity">
            <label htmlFor="agent-name" className="block">
              <span className="mb-1.5 block font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                Agent Name
              </span>
              <input
                id="agent-name"
                name="agent-name"
                autoComplete="off"
                spellCheck={false}
                placeholder={isHyperliquidStrategy
                  ? 'e.g. ETH Hyperliquid breakout agent…'
                  : 'e.g. Base USDC/WETH swing bot…'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2 font-mono text-sm text-[var(--arena-terminal-text)] placeholder:text-[var(--arena-terminal-text-subtle)] transition-[border-color,box-shadow] duration-150 hover:border-[var(--arena-terminal-border-hover)] focus-visible:border-[var(--arena-terminal-border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
              />
            </label>
          </ProvisionPanel>

          <ProvisionPanel title={isProfileLaunch ? 'Capability Profile' : 'Activation Adapter'} action={(
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAdvanced(true)}
              className="h-8 gap-2 rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 font-display text-xs text-[var(--arena-terminal-text-secondary)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)]"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              Runtime
            </Button>
          )}>
            {isProfileLaunch ? (
              <div className="grid gap-2.5">
                <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {capabilitySummaryLabels.map((label) => (
                    <CapabilityFocusChip key={label} label={label} />
                  ))}
                </div>
                <div className="grid overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-border)] sm:grid-cols-3">
                  <GuardrailRow
                    label="Runtime Adapter"
                    value={selectedPack.name}
                    compact
                  />
                  <GuardrailRow
                    label="Venue Access"
                    value={accessLabel}
                    compact
                  />
                  <GuardrailRow
                    label="Execution"
                    value={executionModeLabel}
                    compact
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="grid auto-rows-[56px] gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {primaryPacks.map((pack) => (
                    <StrategyPackButton
                      key={pack.id}
                      pack={pack}
                      active={strategyType === pack.id}
                      onClick={() => setStrategyType(pack.id)}
                    />
                  ))}
                </div>
                {showPredictionPacks && (
                  <div className="mt-2.5">
                    <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--arena-terminal-accent)]">
                      <span className="i-ph:newspaper-clipping text-sm" aria-hidden="true" />
                      Prediction Markets
                    </div>
                    <div className="grid auto-rows-[38px] gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
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
              </>
            )}
            {strategyExecutionNotice && (
              <p className="mt-3 rounded-[5px] border border-[color-mix(in_srgb,var(--arena-terminal-warning)_42%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_10%,var(--arena-terminal-panel))] px-3 py-2 font-mono text-xs text-[var(--arena-terminal-warning)]">
                {strategyExecutionNotice}
              </p>
            )}
          </ProvisionPanel>
        </div>

        <WorkspaceResizeHandle
          orientation="vertical"
          className="hidden lg:col-start-2 lg:row-start-1 lg:flex"
          ariaLabel="Resize activation summary"
          title="Drag to resize activation summary"
          onPointerDown={startRailResize}
        />

        {layout.railCollapsed ? (
          <WorkspaceCollapsedPane
            label="Summary"
            icon="i-ph:sidebar-simple"
            orientation="vertical"
            className="hidden lg:col-start-3 lg:row-start-1 lg:flex"
            onClick={() => setLayout((current) => ({ ...current, railCollapsed: false }))}
          />
        ) : (
        <aside className="grid content-start gap-px lg:col-start-3 lg:row-start-1 lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
          <ProvisionPanel
            title="Activation Review"
            action={(
              <WorkspaceControlButton
                label="Minimize activation summary"
                icon="i-ph:minus-bold"
                onClick={() => setLayout((current) => ({ ...current, railCollapsed: true }))}
              />
            )}
          >
            <div className="space-y-2.5">
              <ReviewFocusRows labels={capabilitySummaryLabels} />
              <ReadRow label="Profile" value={profileLabel} />
              <ReadRow label="Adapter" value={selectedPack.name} />
              <ReadRow label="Mode" value={executionModeLabel} />
              <ReadRow label="Access" value={accessLabel} />
              {agentProfileObjective && (
                <ReadRow label="Objective" value={agentProfileObjective} />
              )}
              {executionTargetLabel && (
                <ReadRow label="Target" value={executionTargetLabel} />
              )}
              <ReadRow label="Assets" value={selectedAssetLabel} />
              <div className="rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3">
                <p className="text-sm leading-5 text-[var(--arena-terminal-text-secondary)]">
                  {executionTargetDescription ?? selectedPack.description}
                </p>
              </div>
            </div>
          </ProvisionPanel>

          <Button
            onClick={goNext}
            disabled={!canNext}
            size="lg"
            className="h-11 w-full rounded-[5px] bg-[var(--arena-terminal-accent)] font-display text-sm font-semibold text-[var(--arena-terminal-accent-text)] transition-[background-color,opacity] duration-150 hover:bg-[color-mix(in_srgb,var(--arena-terminal-accent)_82%,var(--arena-terminal-text))] disabled:opacity-45"
          >
            {isProfileLaunch ? 'Review Wallet Request' : 'Review Activation'}
          </Button>

          {isHyperliquidStrategy && (
            <ProvisionPanel title="Hyperliquid Guardrails">
              <div className="grid overflow-hidden border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-border)] sm:grid-cols-2">
                <GuardrailRow
                  label="Account"
                  value="Bot-bound HyperEVM vault"
                  compact
                />
                <GuardrailRow
                  label="Collateral"
                  value="USDC margin, validator checked"
                  compact
                />
                <GuardrailRow
                  label="Orders"
                  value="Native Hyperliquid perps only"
                  compact
                />
                <GuardrailRow
                  label="Exits"
                  value="Reduce-only when closing risk"
                  compact
                />
              </div>
            </ProvisionPanel>
          )}

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
                      className={`grid min-h-[50px] grid-cols-[24px_minmax(0,1fr)_14px] items-center gap-2 rounded-[5px] border px-2 py-1.5 text-left transition-[background-color,border-color,opacity,transform] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
                        selected
                          ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-text)]'
                          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)]'
                      }`}
                      aria-pressed={selected}
                    >
                      <AssetLogo asset={asset} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate font-display text-xs font-semibold">{asset.symbol}</span>
                        <span className="block truncate font-mono text-[10px] text-[var(--arena-terminal-text-muted)]">
                          {isBase ? 'Base' : asset.name}
                        </span>
                      </span>
                      {selected && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--arena-terminal-accent)]" aria-hidden="true" />
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
                        className="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-2 text-xs"
                      >
                        <AssetLogo asset={asset} size="sm" />
                        <span className="font-display font-semibold text-[var(--arena-terminal-text)]">
                          {asset.symbol}
                        </span>
                        <span
                          className={
                            asset.valuationSource === 'uniswap_v3_twap'
                              ? 'font-mono text-[10px] text-[var(--arena-terminal-warning)]'
                              : 'font-mono text-[10px] text-[var(--arena-terminal-text-muted)]'
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
                            className="rounded-[4px] text-[var(--arena-terminal-text-subtle)] transition-colors hover:text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
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
                  className="h-9 w-full rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2 font-mono text-xs text-[var(--arena-terminal-text)] placeholder:text-[var(--arena-terminal-text-subtle)] transition-[border-color,box-shadow] duration-150 hover:border-[var(--arena-terminal-border-hover)] focus-visible:border-[var(--arena-terminal-border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
                  aria-invalid={customAssetError ? 'true' : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={customAssetChecking}
                  onClick={() => void addAssetToUniverse(manualAssetInput)}
                  className="h-9 gap-2 rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 text-xs text-[var(--arena-terminal-text-secondary)] transition-[background-color,border-color,color,opacity] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)]"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {customAssetChecking ? 'Checking…' : 'Add Token'}
                </Button>
              </div>
              {customAssetError && (
                <p className="mt-2 font-mono text-xs text-[var(--arena-terminal-danger)]" aria-live="polite">
                  {customAssetError}
                </p>
              )}

              <label className="mt-2 block">
                <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
                  Base Asset
                </span>
                <select
                  value={effectiveBaseAssetAddress ?? ''}
                  onChange={(event) => setBaseAssetAddress(event.target.value as Address)}
                  disabled={baseAssetChoices.length === 0}
                  className="h-9 w-full rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 font-mono text-xs text-[var(--arena-terminal-text)] disabled:opacity-60"
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
                    ? 'bg-[var(--arena-terminal-accent)]'
                    : routeStatus === 'Checking'
                      ? 'bg-[var(--arena-terminal-warning)]'
                      : 'bg-[var(--arena-terminal-text-subtle)]'
                }`}
                aria-hidden="true"
              />
              <p className="min-w-0 font-mono text-xs leading-5 text-[var(--arena-terminal-text-secondary)]">
                {infrastructureSummary}
              </p>
            </div>
          </ProvisionPanel>

          <ProvisionPanel title="Collateral">
            {supportsClobCollateral ? (
              <label htmlFor="collateral-cap" className="block">
                <span className="mb-2 block font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
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
                    className="h-10 max-w-32 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2 font-mono text-sm text-[var(--arena-terminal-text)] transition-[border-color,box-shadow] duration-150 hover:border-[var(--arena-terminal-border-hover)] focus-visible:border-[var(--arena-terminal-border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
                  />
                  <span className="font-mono text-sm text-[var(--arena-terminal-text-muted)]">%</span>
                </div>
              </label>
            ) : (
              <div className="grid gap-2">
                <GuardrailRow
                  label="Policy"
                  value="Profile-defined"
                />
                <GuardrailRow
                  label="Margin"
                  value={isHyperliquidStrategy ? 'HyperEVM vault' : 'No CLOB cap required'}
                />
              </div>
            )}
          </ProvisionPanel>

        </aside>
        )}
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
    ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]'
    : tone === 'pending'
      ? 'border-[color-mix(in_srgb,var(--arena-terminal-warning)_42%,var(--arena-terminal-border))] bg-[color-mix(in_srgb,var(--arena-terminal-warning)_10%,var(--arena-terminal-panel))] text-[var(--arena-terminal-warning)]'
      : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)]';
  return (
    <div className="flex min-h-[58px] items-center gap-2.5 bg-[var(--arena-terminal-surface)] px-3.5 py-2">
      <span
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border ${iconClassName}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
          {label}
        </div>
        <div className="mt-0.5 truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
          {value}
        </div>
        <div className="truncate font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
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
    <section className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-1.5">
        <h2 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{title}</h2>
        {action}
      </div>
      <div className="p-2.5">{children}</div>
    </section>
  );
}

function formatExecutionMode(mode: StrategyPackDef['executionMode']): string {
  if (mode === 'single-chain') return 'Single Chain';
  if (mode === 'paper-only') return 'Paper Only';
  return 'Multi Route';
}

const STRATEGY_PACK_PRIORITY = [
  'hyperliquid_perp',
  'perp',
  'dex',
  'yield',
  'mm',
  'volatility',
  'multi',
];

function compareStrategyPackPriority(a: StrategyPackDef, b: StrategyPackDef): number {
  const aIndex = STRATEGY_PACK_PRIORITY.indexOf(a.id);
  const bIndex = STRATEGY_PACK_PRIORITY.indexOf(b.id);
  const aRank = aIndex === -1 ? STRATEGY_PACK_PRIORITY.length : aIndex;
  const bRank = bIndex === -1 ? STRATEGY_PACK_PRIORITY.length : bIndex;
  if (aRank !== bRank) return aRank - bRank;
  return a.name.localeCompare(b.name);
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
      title={pack.description}
      className={`grid h-full min-h-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-2 rounded-[5px] border px-2.5 py-1.5 text-left transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
        active
          ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]'
          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)]'
      }`}
    >
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border ${
          active
            ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-accent)]'
            : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text-muted)]'
        }`}
        aria-hidden="true"
      >
        <span className={`${strategyPackIcon(pack)} text-sm`} />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[13px] font-semibold leading-4 text-[var(--arena-terminal-text)]">
          {pack.name}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
          {pack.providers.slice(0, 3).join(', ')}
          {pack.providers.length > 3 ? ` +${pack.providers.length - 3}` : ''}
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
      title={pack.description}
      className={`grid h-full max-w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-[5px] border px-2.5 font-display text-[13px] font-semibold transition-[background-color,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
        active
          ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-text)]'
          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] text-[var(--arena-terminal-text-secondary)] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)]'
      }`}
    >
      <span className={`${strategyPackIcon(pack)} shrink-0 text-sm`} aria-hidden="true" />
      <span className="truncate">{pack.name}</span>
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
      className={`${sizeClassName} flex shrink-0 items-center justify-center rounded-full bg-[var(--arena-terminal-bg)] font-mono font-semibold text-[var(--arena-terminal-accent)] ring-1 ring-[var(--arena-terminal-border)]`}
      aria-hidden="true"
    >
      {fallbackText}
    </span>
  );
}

function CapabilityFocusChip({ label }: { label: string }) {
  return (
    <div className="grid min-h-[42px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-2.5 py-1.5">
      <span className="h-2 w-2 rounded-full bg-[var(--arena-terminal-accent)] shadow-[0_0_0_3px_var(--arena-terminal-accent-soft)]" aria-hidden="true" />
      <span className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
        {label}
      </span>
    </div>
  );
}

function ReviewFocusRows({ labels }: { labels: string[] }) {
  return (
    <div className="grid gap-2 border-b border-[var(--arena-terminal-border)] pb-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--arena-terminal-text-subtle)]">
        Focus
      </span>
      <div className="flex flex-wrap gap-1.5">
        {labels.map((label) => (
          <span
            key={label}
            className="inline-flex min-h-6 max-w-full items-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 font-mono text-[11px] text-[var(--arena-terminal-text-secondary)]"
          >
            <span className="truncate">{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-3 border-b border-[var(--arena-terminal-border)] pb-2 last:border-b-0 last:pb-0">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--arena-terminal-text-subtle)]">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-[var(--arena-terminal-text)]">{value}</span>
    </div>
  );
}

function GuardrailRow({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? 'grid min-w-0 gap-1 bg-[var(--arena-terminal-bg)] px-3 py-2'
          : 'grid min-w-0 gap-1.5 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2'
      }
    >
      <span className="font-mono text-[10px] uppercase text-[var(--arena-terminal-text-subtle)]">{label}</span>
      <span className="min-w-0 font-mono text-xs leading-4 text-[var(--arena-terminal-text-secondary)]">{value}</span>
    </div>
  );
}
