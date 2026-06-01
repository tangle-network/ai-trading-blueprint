import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Badge } from '@tangle-network/blueprint-ui/components';
import type { Bot } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import { ErrorBoundary } from '~/components/ErrorBoundary';
import { botStatusBadgeVariant, botStatusLabel } from '~/lib/format';

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
  hasTerminal: boolean;
  isHyperliquidPerpBot: boolean;
  assetMetadata?: TokenMetadata[];
  onConfigureSecrets?: () => void;
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
    <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/42">
      <div className="text-center">
        <div className="i-ph:spinner-gap mx-auto text-2xl text-arena-elements-textTertiary animate-spin" />
        <div className="mt-3 font-data text-xs uppercase tracking-wider text-arena-elements-textTertiary">
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

function yesNo(value: boolean | null | undefined): string {
  return value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
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
    <div className="min-w-0 rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/54 px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-data font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
        <span className={`${icon} text-sm`} aria-hidden="true" />
        {label}
      </div>
      <div className="mt-2 truncate font-data text-xl font-bold tracking-tight text-arena-elements-textPrimary">
        {value}
      </div>
      <div className="mt-1 truncate text-sm text-arena-elements-textSecondary">
        {detail}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-arena-elements-dividerColor/50 py-2 last:border-b-0">
      <span className="shrink-0 text-sm text-arena-elements-textSecondary">{label}</span>
      <span className="min-w-0 truncate text-right font-data text-sm font-semibold text-arena-elements-textPrimary" title={value}>
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
    amber: 'border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300',
    violet: 'border-violet-500/28 bg-violet-500/8 text-violet-700 dark:text-violet-300',
    emerald: 'border-emerald-700/24 bg-emerald-700/8 text-emerald-700 dark:border-emerald-500/24 dark:bg-emerald-500/8 dark:text-emerald-300',
    neutral: 'border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/54 text-arena-elements-textPrimary',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-[112px] min-w-0 flex-col items-start rounded-xl border px-3 py-3 text-left transition-colors hover:bg-arena-elements-item-backgroundHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${toneClass}`}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <span className={`${icon} text-lg`} aria-hidden="true" />
        <span className="i-ph:arrow-up-right text-sm opacity-60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
      <div className="mt-3 font-display text-base font-semibold text-arena-elements-textPrimary">
        {title}
      </div>
      <div className="mt-1 text-sm leading-snug text-arena-elements-textSecondary">
        {description}
      </div>
    </button>
  );
}

function OperationsOverview({
  bot,
  panels,
  hasTerminal,
  isHyperliquidPerpBot,
  onSelectPanel,
}: {
  bot: Bot;
  panels: PanelItem[];
  hasTerminal: boolean;
  isHyperliquidPerpBot: boolean;
  onSelectPanel: (panel: OperationsPanel) => void;
}) {
  const needsSecrets = bot.secretsConfigured === false || bot.status === 'needs_config';
  const envelopeMode = bot.validationTrust === 'envelope';
  const activePanelValues = new Set(panels.map((panel) => panel.value));
  const actionCards = [
    needsSecrets
      ? {
          title: 'Configure Secrets',
          description: 'Provider keys are still required before the operator can run this agent.',
          icon: 'i-ph:key',
          tone: 'amber' as const,
          panel: 'secrets' as OperationsPanel,
        }
      : null,
    envelopeMode
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
    {
      title: 'Runtime Controls',
      description: 'Change trading posture, trigger a run, or wind down the agent lifecycle.',
      icon: 'i-ph:sliders-horizontal',
      tone: bot.controlAvailable ? 'emerald' as const : 'neutral' as const,
      panel: 'controls' as OperationsPanel,
    },
    isHyperliquidPerpBot && activePanelValues.has('vault')
      ? {
          title: 'Vault Wiring',
          description: 'Check Hyperliquid balances, accounting freshness, and withdrawal state.',
          icon: 'i-ph:bank',
          tone: 'neutral' as const,
          panel: 'vault' as OperationsPanel,
        }
      : null,
    hasTerminal && activePanelValues.has('terminal')
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
          value={bot.controlAvailable ? 'Available' : 'Read-only'}
          detail={`${operatorKindLabel(bot.operatorKind)} operator`}
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
        <section className="rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/44 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                Operational State
              </div>
              <h3 className="mt-1 font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
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
        </section>

        <aside className="rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/44 p-4">
          <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
            Identity
          </div>
          <h3 className="mt-1 font-display text-lg font-semibold text-arena-elements-textPrimary">
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

      <section className="rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/44 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
              Capabilities
            </div>
            <h3 className="mt-1 font-display text-lg font-semibold text-arena-elements-textPrimary">
              Access and policy checks
            </h3>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {[
            { label: 'Terminal', value: yesNo(hasTerminal), icon: 'i-ph:terminal-window' },
            { label: 'Hyperliquid Vault', value: yesNo(isHyperliquidPerpBot), icon: 'i-ph:bank' },
            { label: 'Authoritative Data', value: bot.verificationState === 'authoritative' ? 'Yes' : 'No', icon: 'i-ph:seal-check' },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/56 px-3 py-2.5"
            >
              <div className="flex items-center gap-2 text-xs font-data uppercase tracking-wider text-arena-elements-textTertiary">
                <span className={`${item.icon} text-sm`} aria-hidden="true" />
                {item.label}
              </div>
              <div className="mt-1 font-data text-base font-bold text-arena-elements-textPrimary">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function OperationsWorkspace({
  bot,
  botName,
  isLive,
  initialPanel,
  hasTerminal,
  isHyperliquidPerpBot,
  assetMetadata,
  onConfigureSecrets,
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
        description: 'Validator evidence and simulation traces',
        icon: 'i-ph:shield-check',
      },
      {
        value: 'revisions',
        label: 'Revisions',
        description: 'Self-improvement candidates and promotion state',
        icon: 'i-ph:git-branch',
      },
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
        badge: bot.secretsConfigured === false ? 'needed' : undefined,
      },
      {
        value: 'secrets',
        label: 'Secrets',
        description: 'Owner-only provider keys and runtime environment',
        icon: 'i-ph:key',
      },
    ];

    if (isHyperliquidPerpBot) {
      items.push({
        value: 'vault',
        label: 'Vault',
        description: 'Hyperliquid balances and vault wiring',
        icon: 'i-ph:bank',
      });
    }

    if (hasTerminal) {
      items.push({
        value: 'terminal',
        label: 'Terminal',
        description: 'Owner-only process and log inspection',
        icon: 'i-ph:terminal-window',
      });
    }

    return items;
  }, [bot.secretsConfigured, hasTerminal, isHyperliquidPerpBot]);

  const requestedPanel = isOperationsPanel(initialPanel) ? initialPanel : null;
  const [activePanel, setActivePanel] = useState<OperationsPanel>(
    requestedPanel ?? 'overview',
  );

  useEffect(() => {
    if (requestedPanel) setActivePanel(requestedPanel);
  }, [requestedPanel]);

  useEffect(() => {
    if (!panels.some((panel) => panel.value === activePanel)) {
      setActivePanel(panels[0]?.value ?? 'validation');
    }
  }, [activePanel, panels]);

  const activeItem = panels.find((panel) => panel.value === activePanel) ?? panels[0];

  const content = (() => {
    switch (activePanel) {
      case 'overview':
        return (
          <OperationsOverview
            bot={bot}
            panels={panels}
            hasTerminal={hasTerminal}
            isHyperliquidPerpBot={isHyperliquidPerpBot}
            onSelectPanel={setActivePanel}
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

  return (
    <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/64">
        <div className="border-b border-arena-elements-dividerColor/70 px-4 py-3">
          <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
            Operations
          </div>
          <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
            Control Plane
          </h2>
        </div>
        <nav className="space-y-1 p-2" aria-label="Operations panels">
          {panels.map((panel) => {
            const selected = panel.value === activePanel;
            return (
              <button
                key={panel.value}
                type="button"
                onClick={() => setActivePanel(panel.value)}
                aria-current={selected ? 'page' : undefined}
                className={`group flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                  selected
                    ? 'bg-violet-500/14 text-arena-elements-textPrimary'
                    : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary'
                }`}
              >
                <span className={`${panel.icon} mt-0.5 text-base ${selected ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold">{panel.label}</span>
                    {panel.badge && <Badge variant="amber" className="text-[10px]">{panel.badge}</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-arena-elements-textTertiary">
                    {panel.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/54">
        {activeItem && (
          <div className="shrink-0 border-b border-arena-elements-dividerColor/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className={`${activeItem.icon} text-lg text-violet-500 dark:text-violet-300`} aria-hidden="true" />
              <h2 className="font-display text-xl font-semibold tracking-tight text-arena-elements-textPrimary">
                {activeItem.label}
              </h2>
            </div>
            <p className="mt-1 text-sm text-arena-elements-textSecondary">
              {activeItem.description}
            </p>
          </div>
        )}
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
