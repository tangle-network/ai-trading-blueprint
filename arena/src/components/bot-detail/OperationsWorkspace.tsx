import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Badge } from '@tangle-network/blueprint-ui/components';
import type { Bot } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import { ErrorBoundary } from '~/components/ErrorBoundary';
import { botStatusBadgeVariant, botStatusLabel, formatNumber } from '~/lib/format';
import { WorkspaceNavStrip } from './shared/WorkspacePrimitives';

export type OperationsPanel =
  | 'overview'
  | 'validation'
  | 'revisions'
  | 'controls'
  | 'envelope'
  | 'secrets'
  | 'vault'
  | 'terminal';

interface OperationsWorkspaceProps {
  bot: Bot;
  botName: string;
  isLive: boolean;
  initialPanel?: string | null;
  onPanelChange?: (panel: OperationsPanel) => void;
  hasTerminal: boolean;
  isHyperliquidPerpBot: boolean;
  assetMetadata?: TokenMetadata[];
  onConfigureSecrets?: () => void;
  canCommand?: boolean;
}

interface PanelItem {
  value: OperationsPanel;
  label: string;
  description: string;
  icon: string;
  badge?: string;
}

const ReasoningTab = lazy(() =>
  import('./ReasoningTab').then((module) => ({ default: module.ReasoningTab })));
const RevisionArenaTab = lazy(() =>
  import('./RevisionArenaTab').then((module) => ({ default: module.RevisionArenaTab })));
const ControlsTab = lazy(() =>
  import('./ControlsTab').then((module) => ({ default: module.ControlsTab })));
const EnvelopeTab = lazy(() =>
  import('./EnvelopeTab').then((module) => ({ default: module.EnvelopeTab })));
const SecretsTab = lazy(() =>
  import('./SecretsTab').then((module) => ({ default: module.SecretsTab })));
const TerminalTab = lazy(() =>
  import('./TerminalTab').then((module) => ({ default: module.TerminalTab })));
const HyperliquidVaultTab = lazy(() =>
  import('./HyperliquidVaultTab').then((module) => ({ default: module.HyperliquidVaultTab })));

function isOperationsPanel(value: string | null | undefined): value is OperationsPanel {
  return value === 'overview'
    || value === 'validation'
    || value === 'revisions'
    || value === 'controls'
    || value === 'envelope'
    || value === 'secrets'
    || value === 'vault'
    || value === 'terminal';
}

function OperationsPanelLoading({ label }: { label?: string }) {
  return (
    <div className="flex min-h-[280px] items-center justify-center rounded-[5px] border border-[#273035] bg-[#0f1a1f]">
      <div className="text-center">
        <div className="i-ph:spinner-gap mx-auto text-2xl text-[#949e9c] animate-spin" />
        <div className="mt-3 font-data text-xs uppercase tracking-wider text-[#949e9c]">
          Loading {label ?? 'panel'}
        </div>
      </div>
    </div>
  );
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return 'n/a';
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function formatLastVerified(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return 'Not verified';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function validationTrustLabel(value: Bot['validationTrust']): string {
  switch (value) {
    case 'envelope':
      return 'Envelope';
    case 'self_operated':
      return 'Self-operated';
    case 'per_trade':
    default:
      return 'Per trade';
  }
}

function operatorKindLabel(value: Bot['operatorKind']): string {
  switch (value) {
    case 'cloud':
      return 'Fleet';
    case 'instance':
      return 'Instance';
    case 'tee':
      return 'TEE';
    case null:
    case undefined:
    default:
      return 'Unknown';
  }
}

function runtimeModeLabel(bot: Bot): string {
  if (bot.paperTrade === true) return 'Paper';
  if (bot.paperTrade === false) return 'Live';
  return 'Unknown';
}

function StatCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
}) {
  return (
    <div className="min-w-0 rounded-[5px] border border-[#273035] bg-[#0f1a1f] px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-data font-semibold uppercase tracking-wider text-[#949e9c]">
        <span className={`${icon} text-sm`} aria-hidden="true" />
        {label}
      </div>
      <div className="mt-2 truncate font-data text-xl font-bold tracking-tight text-[#f6fefd]">
        {value}
      </div>
      <div className="mt-1 truncate text-sm text-[#949e9c]">
        {detail}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[#273035] py-2 last:border-b-0">
      <span className="shrink-0 text-sm text-[#949e9c]">{label}</span>
      <span className="min-w-0 truncate text-right font-data text-sm font-semibold text-[#f6fefd]" title={value}>
        {value}
      </span>
    </div>
  );
}

function ActionCard({
  title,
  description,
  icon,
  tone,
  onClick,
}: {
  title: string;
  description: string;
  icon: string;
  tone: 'amber' | 'violet' | 'emerald' | 'neutral';
  onClick: () => void;
}) {
  const toneClass = {
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    violet: 'border-[#50d2c1]/24 bg-[#123f3a]/54 text-[#50d2c1]',
    emerald: 'border-emerald-500/24 bg-emerald-500/10 text-emerald-300',
    neutral: 'border-[#273035] bg-[#0f1a1f] text-[#d2dad7]',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-[112px] min-w-0 flex-col items-start rounded-[5px] border px-3 py-3 text-left transition-colors hover:bg-[#16242a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${toneClass}`}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <span className={`${icon} text-lg`} aria-hidden="true" />
        <span className="i-ph:arrow-up-right text-sm opacity-60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
      <div className="mt-3 font-display text-base font-semibold text-[#f6fefd]">
        {title}
      </div>
      <div className="mt-1 text-sm leading-snug text-[#949e9c]">
        {description}
      </div>
    </button>
  );
}

function readNumberField(record: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    const value = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseFloat(raw)
        : null;
    if (value != null && Number.isFinite(value)) return value;
  }
  return null;
}

function readPositionFraction(strategyConfig: Record<string, unknown> | undefined): number | null {
  const sizing = strategyConfig?.position_sizing;
  if (!sizing || typeof sizing !== 'object') return null;
  return readNumberField(sizing as Record<string, unknown>, ['fraction', 'max_fraction', 'pct']);
}

function formatGuardrailPercent(value: number | null): string {
  if (value == null) return 'Unset';
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  return `${formatNumber(percent, { maximumFractionDigits: percent >= 10 ? 0 : 1 })}%`;
}

function GuardrailTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-[5px] border border-[#273035] bg-[#0b1418] px-3 py-2.5">
      <div className="truncate font-data text-[10px] font-semibold uppercase tracking-wider text-[#949e9c]">
        {label}
      </div>
      <div className="mt-1 truncate font-data text-lg font-bold text-[#f6fefd]">
        {value}
      </div>
      <div className="mt-1 truncate text-sm text-[#949e9c]">
        {detail}
      </div>
    </div>
  );
}

function OperationsOverview({
  bot,
  panels,
  hasTerminal,
  isHyperliquidPerpBot,
  canCommand,
  onSelectPanel,
}: {
  bot: Bot;
  panels: PanelItem[];
  hasTerminal: boolean;
  isHyperliquidPerpBot: boolean;
  canCommand: boolean;
  onSelectPanel: (panel: OperationsPanel) => void;
}) {
  const needsSecrets = bot.secretsConfigured === false || bot.status === 'needs_config';
  const envelopeMode = bot.validationTrust === 'envelope';
  const activePanelValues = new Set(panels.map((panel) => panel.value));
  const maxDrawdown = readNumberField(bot.riskParams, ['max_drawdown_pct', 'max_drawdown']);
  const stopLoss = readNumberField(bot.riskParams, ['stop_loss_pct', 'stop_loss']);
  const positionCap = readNumberField(bot.riskParams, ['max_position_size_pct', 'max_position_pct'])
    ?? readPositionFraction(bot.strategyConfig);
  const maxLifetime = bot.maxLifetimeDays != null && bot.maxLifetimeDays > 0
    ? `${bot.maxLifetimeDays}d`
    : 'Open';
  const actionCards = [
    canCommand && needsSecrets && activePanelValues.has('secrets')
      ? {
          title: 'Configure Secrets',
          description: 'Provider keys are still required before the operator can run this agent.',
          icon: 'i-ph:key',
          tone: 'amber' as const,
          panel: 'secrets' as OperationsPanel,
        }
      : null,
    canCommand && envelopeMode && activePanelValues.has('envelope')
      ? {
          title: 'Review Envelope',
          description: 'Execution is governed by a signed allowance and policy envelope.',
          icon: 'i-ph:signature',
          tone: 'amber' as const,
          panel: 'envelope' as OperationsPanel,
        }
      : null,
    {
      title: 'Inspect Validation',
      description: 'See validator signatures, simulation state, and recent approval evidence.',
      icon: 'i-ph:shield-check',
      tone: 'violet' as const,
      panel: 'validation' as OperationsPanel,
    },
    canCommand && activePanelValues.has('controls')
      ? {
          title: 'Runtime Controls',
          description: 'Change trading posture, trigger a run, or wind down the agent lifecycle.',
          icon: 'i-ph:sliders-horizontal',
          tone: bot.controlAvailable ? 'emerald' as const : 'neutral' as const,
          panel: 'controls' as OperationsPanel,
        }
      : null,
    isHyperliquidPerpBot && activePanelValues.has('vault')
      ? {
          title: 'Vault Wiring',
          description: 'Check Hyperliquid balances, accounting freshness, and withdrawal state.',
          icon: 'i-ph:bank',
          tone: 'neutral' as const,
          panel: 'vault' as OperationsPanel,
        }
      : null,
    canCommand && hasTerminal && activePanelValues.has('terminal')
      ? {
          title: 'Terminal Access',
          description: 'Open owner-only runtime logs and process inspection.',
          icon: 'i-ph:terminal-window',
          tone: 'neutral' as const,
          panel: 'terminal' as OperationsPanel,
        }
      : null,
  ].filter((card): card is NonNullable<typeof card> => Boolean(card));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 lg:grid-cols-4">
        <StatCard
          label="Runtime"
          value={botStatusLabel(bot.status)}
          detail={bot.tradingActive ? 'Trading loop active' : 'Trading loop idle'}
          icon="i-ph:pulse"
        />
        <StatCard
          label="Execution"
          value={runtimeModeLabel(bot)}
          detail={validationTrustLabel(bot.validationTrust)}
          icon="i-ph:swap"
        />
        <StatCard
          label="Control"
          value={canCommand && bot.controlAvailable ? 'Available' : 'Viewer'}
          detail={canCommand ? `${operatorKindLabel(bot.operatorKind)} operator` : 'Public access'}
          icon="i-ph:sliders-horizontal"
        />
        <StatCard
          label="Secrets"
          value={bot.secretsConfigured ? 'Configured' : 'Needed'}
          detail={bot.sandboxState ?? bot.lifecycleStatus ?? 'Runtime state unknown'}
          icon="i-ph:key"
        />
      </div>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-[#949e9c]">
                Operational State
              </div>
              <h3 className="mt-1 font-display text-xl font-semibold tracking-tight text-[#f6fefd]">
                Safety and runtime map
              </h3>
            </div>
            <Badge variant={botStatusBadgeVariant(bot.status)} className="font-data text-xs">
              {botStatusLabel(bot.status)}
            </Badge>
          </div>

          <div className="grid gap-2 2xl:grid-cols-2">
            {actionCards.map((card) => (
              <ActionCard
                key={card.title}
                title={card.title}
                description={card.description}
                icon={card.icon}
                tone={card.tone}
                onClick={() => onSelectPanel(card.panel)}
              />
            ))}
          </div>

          <div className="mt-3 rounded-[5px] border border-[#273035] bg-[#0b1418] p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-[#949e9c]">
                Guardrails
              </div>
              <span className="font-data text-xs text-[#949e9c]">
                {runtimeModeLabel(bot)}
              </span>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <GuardrailTile
                label="Max DD"
                value={formatGuardrailPercent(maxDrawdown)}
                detail="loss ceiling"
              />
              <GuardrailTile
                label="Position Cap"
                value={formatGuardrailPercent(positionCap)}
                detail="capital fraction"
              />
              <GuardrailTile
                label="Stop Loss"
                value={formatGuardrailPercent(stopLoss)}
                detail="per position"
              />
              <GuardrailTile
                label="Runtime"
                value={maxLifetime}
                detail={bot.windDownStartedAt ? 'wind-down started' : 'mandate window'}
              />
            </div>
          </div>
        </section>

        <aside className="rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-4">
          <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-[#949e9c]">
            Identity
          </div>
          <h3 className="mt-1 font-display text-lg font-semibold text-[#f6fefd]">
            Agent references
          </h3>
          <div className="mt-3">
            <DetailRow label="Bot ID" value={bot.id} />
            <DetailRow label="Operator" value={shortAddress(bot.operatorAddress)} />
            <DetailRow label="Submitter" value={shortAddress(bot.submitterAddress)} />
            <DetailRow label="Vault" value={shortAddress(bot.vaultAddress)} />
            <DetailRow label="Service" value={bot.serviceId > 0 ? String(bot.serviceId) : 'n/a'} />
            <DetailRow label="Call" value={bot.callId && bot.callId > 0 ? String(bot.callId) : 'n/a'} />
            <DetailRow label="Sandbox" value={bot.sandboxId ?? 'n/a'} />
            <DetailRow label="Chain" value={bot.chainId ? String(bot.chainId) : 'n/a'} />
            <DetailRow label="Verified" value={formatLastVerified(bot.lastVerifiedAt)} />
          </div>
        </aside>
      </div>

    </div>
  );
}

export function OperationsWorkspace({
  bot,
  botName,
  isLive,
  initialPanel,
  onPanelChange,
  hasTerminal,
  isHyperliquidPerpBot,
  assetMetadata,
  onConfigureSecrets,
  canCommand = false,
}: OperationsWorkspaceProps) {
  const panels = useMemo<PanelItem[]>(() => {
    const items: PanelItem[] = [
      {
        value: 'overview',
        label: 'Overview',
        description: 'Runtime, policy, access, and audit state',
        icon: 'i-ph:activity',
      },
      {
        value: 'validation',
        label: 'Validation',
        description: 'Validator evidence and simulation results',
        icon: 'i-ph:shield-check',
      },
      {
        value: 'revisions',
        label: 'Revisions',
        description: 'Self-improvement candidates and promotion state',
        icon: 'i-ph:git-branch',
      },
    ];

    if (canCommand) {
      items.push(
        {
          value: 'controls',
          label: 'Controls',
          description: 'Runtime posture, risk, and lifecycle actions',
          icon: 'i-ph:sliders-horizontal',
        },
        {
          value: 'envelope',
          label: 'Envelope',
          description: 'Signed execution policy and allowance guardrails',
          icon: 'i-ph:signature',
          badge: bot.validationTrust === 'envelope' ? 'policy' : undefined,
        },
        {
          value: 'secrets',
          label: 'Secrets',
          description: 'Owner-only provider keys and runtime environment',
          icon: 'i-ph:key',
        },
      );
    }

    if (isHyperliquidPerpBot) {
      items.push({
        value: 'vault',
        label: 'Vault',
        description: 'Hyperliquid balances and vault wiring',
        icon: 'i-ph:bank',
      });
    }

    if (canCommand && hasTerminal) {
      items.push({
        value: 'terminal',
        label: 'Terminal',
        description: 'Owner-only process and log inspection',
        icon: 'i-ph:terminal-window',
      });
    }

    return items;
  }, [bot.validationTrust, canCommand, hasTerminal, isHyperliquidPerpBot]);

  const requestedPanel = isOperationsPanel(initialPanel) ? initialPanel : null;
  const [activePanel, setActivePanel] = useState<OperationsPanel>(
    requestedPanel ?? 'overview',
  );
  const panelNavItems = useMemo(
    () => panels.map((panel) => ({
      value: panel.value,
      label: panel.label,
      icon: panel.icon,
      badge: panel.badge ? <Badge variant="amber" className="text-[10px]">{panel.badge}</Badge> : undefined,
    })),
    [panels],
  );

  useEffect(() => {
    if (requestedPanel) setActivePanel(requestedPanel);
  }, [requestedPanel]);

  useEffect(() => {
    if (!panels.some((panel) => panel.value === activePanel)) {
      setActivePanel(panels[0]?.value ?? 'validation');
    }
  }, [activePanel, panels]);

  const effectiveActivePanel = panels.some((panel) => panel.value === activePanel)
    ? activePanel
    : panels[0]?.value ?? 'overview';
  const activeItem = panels.find((panel) => panel.value === effectiveActivePanel) ?? panels[0];
  const selectPanel = (panel: OperationsPanel) => {
    setActivePanel(panel);
    onPanelChange?.(panel);
  };

  const content = (() => {
    switch (effectiveActivePanel) {
      case 'overview':
        return (
          <OperationsOverview
            bot={bot}
            panels={panels}
            hasTerminal={hasTerminal}
            isHyperliquidPerpBot={isHyperliquidPerpBot}
            canCommand={canCommand}
            onSelectPanel={selectPanel}
          />
        );
      case 'validation':
        return (
          <ReasoningTab
            botId={bot.id}
            botName={botName}
            isLive={isLive}
            chainId={bot.chainId}
            operatorApiUrl={bot.operatorApiUrl}
            operatorKind={bot.operatorKind}
            verificationState={bot.verificationState}
            assetMetadata={assetMetadata}
          />
        );
      case 'revisions':
        return (
          <RevisionArenaTab
            botId={bot.id}
            operatorApiUrl={bot.operatorApiUrl}
            operatorKind={bot.operatorKind}
            verificationState={bot.verificationState}
          />
        );
      case 'controls':
        return <ControlsTab bot={bot} onConfigureSecrets={onConfigureSecrets} />;
      case 'envelope':
        return <EnvelopeTab bot={bot} />;
      case 'secrets':
        return <SecretsTab bot={bot} />;
      case 'vault':
        return isHyperliquidPerpBot ? <HyperliquidVaultTab bot={bot} /> : null;
      case 'terminal':
        return hasTerminal ? (
          <TerminalTab
            botId={bot.id}
            botName={botName}
            operatorApiUrl={bot.operatorApiUrl}
            operatorKind={bot.operatorKind}
            verificationState={bot.verificationState}
          />
        ) : null;
    }
  })();
  const terminalOperationsClass = [
    '[&_.text-arena-elements-textPrimary]:!text-[#f6fefd]',
    '[&_.text-arena-elements-textSecondary]:!text-[#d2dad7]',
    '[&_.text-arena-elements-textTertiary]:!text-[#949e9c]',
    '[&_.glass-card]:!border-[#273035]',
    '[&_.glass-card]:!bg-[#0f1a1f]',
  ].join(' ');

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418] ${terminalOperationsClass}`}>
      <div className="shrink-0 border-b border-[#273035] bg-[#0f1a1f] px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-[#949e9c]">
              Operations
            </div>
            <h2 className="mt-0.5 truncate font-display text-xl font-semibold tracking-tight text-[#f6fefd]">
              {activeItem?.label ?? 'Runtime State'}
            </h2>
            {activeItem?.description && (
              <p className="mt-0.5 truncate text-sm text-[#949e9c]">
                {activeItem.description}
              </p>
            )}
          </div>
          <WorkspaceNavStrip
            items={panelNavItems}
            activeValue={effectiveActivePanel}
            onSelect={selectPanel}
            ariaLabel="Operations panels"
            className="border-[#273035] bg-[#273035] p-0.5"
            buttonClassName="h-9"
          />
        </div>
      </div>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ErrorBoundary>
            <Suspense fallback={<OperationsPanelLoading label={activeItem?.label} />}>
              {content}
            </Suspense>
          </ErrorBoundary>
        </div>
      </section>
    </div>
  );
}
