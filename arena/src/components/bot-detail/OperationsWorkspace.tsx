import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Badge } from '@tangle-network/blueprint-ui/components';
import type { Bot } from '~/lib/types/bot';
import type { TokenMetadata } from '~/lib/tradeTokenMetadata';
import { ErrorBoundary } from '~/components/ErrorBoundary';
import { botStatusBadgeVariant, botStatusLabel, formatNumber } from '~/lib/format';

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
    <div className="flex min-h-[280px] items-center justify-center rounded-[5px] border border-[#273035] bg-[#081013]">
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
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] items-center gap-3 border-b border-[#273035] py-2 last:border-b-0">
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.12em] text-[#697371]">{label}</span>
      <span className="min-w-0 truncate text-right font-data text-sm font-semibold text-[#f6fefd]" title={value}>
        {value}
      </span>
    </div>
  );
}

function CommandLane({
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
    amber: 'border-[#6f5723] bg-[#201808] text-[#f2c066]',
    violet: 'border-[#1d5b52] bg-[#0d302c] text-[#50d2c1]',
    emerald: 'border-[#1d5b52] bg-[#0f2421] text-[#9cf5e7]',
    neutral: 'border-[#273035] bg-[#0b1418] text-[#d2dad7]',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group grid min-h-[58px] min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center gap-2.5 rounded-[5px] border px-2.5 py-2 text-left transition-[background-color,border-color,transform] duration-150 hover:bg-[#12302e] active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${toneClass}`}
    >
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[5px] bg-[#081013]">
        <span className={`${icon} text-base`} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[15px] font-semibold text-[#f6fefd]">
          {title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-[#949e9c]">
          {description}
        </span>
      </span>
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

function ConsoleRow({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const valueClass = {
    neutral: 'text-[#f6fefd]',
    good: 'text-[#50d2c1]',
    warn: 'text-[#f2c066]',
  }[tone];

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#273035] py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-data text-[10px] font-semibold uppercase tracking-wider text-[#697371]">
          {label}
        </div>
        <div className="mt-0.5 truncate text-sm text-[#949e9c]">
          {detail}
        </div>
      </div>
      <div className={`max-w-[9.5rem] truncate text-right font-data text-base font-bold ${valueClass}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function StatusCell({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const valueClass = {
    neutral: 'text-[#f6fefd]',
    good: 'text-[#50d2c1]',
    warn: 'text-[#f2c066]',
  }[tone];

  return (
    <div className="min-w-0 border-r border-[#273035] px-3 py-2.5 last:border-r-0">
      <div className="truncate font-data text-[10px] font-semibold uppercase tracking-[0.12em] text-[#697371]">
        {label}
      </div>
      <div className={`mt-1 truncate font-data text-base font-bold tabular-nums ${valueClass}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function RecordSection({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#50d2c1]">
        {title}
      </div>
      <div className="rounded-[5px] border border-[#273035] bg-[#081013] px-3">
        {rows.map((row) => (
          <DetailRow key={`${title}-${row.label}`} label={row.label} value={row.value} />
        ))}
      </div>
    </section>
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
  const runtimeState = bot.sandboxState ?? bot.lifecycleStatus ?? 'unknown';
  const riskRows = [
    {
      label: 'Max DD',
      value: formatGuardrailPercent(maxDrawdown),
      detail: 'portfolio loss ceiling',
    },
    {
      label: 'Position Cap',
      value: formatGuardrailPercent(positionCap),
      detail: 'capital per position',
    },
    {
      label: 'Stop Loss',
      value: formatGuardrailPercent(stopLoss),
      detail: 'per-trade exit limit',
    },
    {
      label: 'Validator',
      value: bot.avgValidatorScore > 0
        ? formatNumber(bot.avgValidatorScore, { maximumFractionDigits: 0 })
        : 'n/a',
      detail: 'average evidence score',
    },
    {
      label: 'Trades',
      value: formatNumber(bot.totalTrades, { maximumFractionDigits: 0 }),
      detail: 'fills under this mandate',
    },
    {
      label: 'Runtime',
      value: maxLifetime,
      detail: bot.windDownStartedAt ? 'wind-down active' : 'mandate window',
    },
  ];
  const runtimeRows = [
    {
      label: 'Trading Loop',
      value: bot.tradingActive ? 'Active' : 'Idle',
      detail: bot.tradingActive ? 'loop active' : 'loop idle',
      tone: bot.tradingActive ? 'good' as const : 'neutral' as const,
    },
    {
      label: 'Sandbox',
      value: runtimeState,
      detail: bot.sandboxId ?? 'no sandbox',
      tone: String(runtimeState).toLowerCase() === 'running' ? 'good' as const : 'neutral' as const,
    },
    {
      label: 'Trust',
      value: validationTrustLabel(bot.validationTrust),
      detail: operatorKindLabel(bot.operatorKind),
      tone: envelopeMode ? 'good' as const : 'warn' as const,
    },
    {
      label: 'Access',
      value: canCommand && bot.controlAvailable ? 'Command' : 'View',
      detail: canCommand ? 'operator permitted' : 'public read',
      tone: canCommand && bot.controlAvailable ? 'good' as const : 'neutral' as const,
    },
    {
      label: 'Verified',
      value: formatLastVerified(bot.lastVerifiedAt),
      detail: 'latest operator check',
      tone: bot.lastVerifiedAt ? 'good' as const : 'neutral' as const,
    },
    {
      label: 'Service',
      value: bot.serviceId > 0 ? `#${bot.serviceId}` : 'n/a',
      detail: bot.callId && bot.callId > 0 ? `call #${bot.callId}` : 'no call id',
      tone: bot.serviceId > 0 ? 'good' as const : 'neutral' as const,
    },
  ];
  const recordGroups = [
    {
      title: 'Identity',
      rows: [
        { label: 'Bot ID', value: bot.id },
        { label: 'Operator', value: shortAddress(bot.operatorAddress) },
        { label: 'Submitter', value: shortAddress(bot.submitterAddress) },
        { label: 'Vault', value: shortAddress(bot.vaultAddress) },
      ],
    },
    {
      title: 'Chain',
      rows: [
        { label: 'Network', value: bot.chainId ? String(bot.chainId) : 'n/a' },
        { label: 'Service', value: bot.serviceId > 0 ? String(bot.serviceId) : 'n/a' },
        { label: 'Call', value: bot.callId && bot.callId > 0 ? String(bot.callId) : 'n/a' },
        { label: 'Verified', value: formatLastVerified(bot.lastVerifiedAt) },
      ],
    },
    {
      title: 'Runtime',
      rows: [
        { label: 'Sandbox', value: bot.sandboxId ?? 'n/a' },
        { label: 'State', value: runtimeState },
        { label: 'Mode', value: runtimeModeLabel(bot) },
        { label: 'Operator', value: operatorKindLabel(bot.operatorKind) },
      ],
    },
  ];
  const actionCards = [
    canCommand && needsSecrets && activePanelValues.has('secrets')
      ? {
          title: 'Secrets',
          description: 'Provider keys required',
          icon: 'i-ph:key',
          tone: 'amber' as const,
          panel: 'secrets' as OperationsPanel,
        }
      : null,
    canCommand && envelopeMode && activePanelValues.has('envelope')
      ? {
          title: 'Envelope',
          description: 'Allowance policy',
          icon: 'i-ph:signature',
          tone: 'amber' as const,
          panel: 'envelope' as OperationsPanel,
        }
      : null,
    {
      title: 'Validation',
      description: 'Evidence',
      icon: 'i-ph:shield-check',
      tone: 'violet' as const,
      panel: 'validation' as OperationsPanel,
    },
    activePanelValues.has('revisions')
      ? {
          title: 'Revisions',
          description: 'Candidates',
          icon: 'i-ph:git-branch',
          tone: 'neutral' as const,
          panel: 'revisions' as OperationsPanel,
        }
      : null,
    canCommand && activePanelValues.has('controls')
      ? {
          title: 'Controls',
          description: 'Risk and lifecycle',
          icon: 'i-ph:sliders-horizontal',
          tone: bot.controlAvailable ? 'emerald' as const : 'neutral' as const,
          panel: 'controls' as OperationsPanel,
        }
      : null,
    isHyperliquidPerpBot && activePanelValues.has('vault')
      ? {
          title: 'Vault',
          description: 'Balances',
          icon: 'i-ph:bank',
          tone: 'neutral' as const,
          panel: 'vault' as OperationsPanel,
        }
      : null,
    canCommand && hasTerminal && activePanelValues.has('terminal')
      ? {
          title: 'Terminal',
          description: 'Runtime logs',
          icon: 'i-ph:terminal-window',
          tone: 'neutral' as const,
          panel: 'terminal' as OperationsPanel,
        }
      : null,
  ].filter((card): card is NonNullable<typeof card> => Boolean(card));
  const statusCells = [
    {
      label: 'State',
      value: botStatusLabel(bot.status),
      tone: bot.status === 'active' ? 'good' as const : bot.status === 'needs_config' ? 'warn' as const : 'neutral' as const,
    },
    {
      label: 'Mode',
      value: runtimeModeLabel(bot),
      tone: runtimeModeLabel(bot) === 'Live' ? 'good' as const : 'warn' as const,
    },
    {
      label: 'Trust',
      value: validationTrustLabel(bot.validationTrust),
      tone: envelopeMode ? 'good' as const : 'warn' as const,
    },
    {
      label: 'Secrets',
      value: bot.secretsConfigured ? 'Set' : 'Needed',
      tone: bot.secretsConfigured ? 'good' as const : 'warn' as const,
    },
    {
      label: 'Access',
      value: canCommand && bot.controlAvailable ? 'Command' : 'View',
      tone: canCommand && bot.controlAvailable ? 'good' as const : 'neutral' as const,
    },
  ];

  return (
    <div className="grid h-full min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_332px]">
      <section className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
        <div className="grid border-b border-[#273035] bg-[#081013] min-[980px]:grid-cols-5">
          {statusCells.map((cell) => (
            <StatusCell
              key={cell.label}
              label={cell.label}
              value={cell.value}
              tone={cell.tone}
            />
          ))}
        </div>

        <section className="border-b border-[#273035] bg-[#0b1418] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold text-[#f6fefd]">
              Command Runway
            </h3>
            <span className="font-mono text-xs text-[#949e9c]">
              {actionCards.length} paths
            </span>
          </div>
          <div className="grid content-start gap-2 md:grid-cols-2 xl:grid-cols-3">
            {actionCards.map((card) => (
              <CommandLane
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

        <div className="grid min-h-0 gap-2 overflow-auto p-3 [scrollbar-gutter:stable] lg:grid-cols-2">
          <section className="flex min-h-0 flex-col rounded-[5px] border border-[#273035] bg-[#081013] p-3">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="font-display text-base font-semibold text-[#f6fefd]">
                Guardrails
              </h3>
              <span className="font-mono text-xs text-[#949e9c]">
                {runtimeModeLabel(bot)}
              </span>
            </div>
            <div>
              {riskRows.map((row) => (
                <ConsoleRow
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  detail={row.detail}
                />
              ))}
            </div>
          </section>

          <section className="flex min-h-0 flex-col rounded-[5px] border border-[#273035] bg-[#081013] p-3">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="font-display text-base font-semibold text-[#f6fefd]">
                Runtime Stack
              </h3>
              <span className="font-mono text-xs text-[#949e9c]">
                {operatorKindLabel(bot.operatorKind)}
              </span>
            </div>
            <div>
              {runtimeRows.map((row) => (
                <ConsoleRow
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  detail={row.detail}
                  tone={row.tone}
                />
              ))}
            </div>
          </section>
        </div>
      </section>

      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#273035] px-3 py-2.5">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#50d2c1]">
              Record
            </div>
            <h3 className="mt-1 truncate font-display text-lg font-semibold text-[#f6fefd]">
              {shortAddress(bot.operatorAddress)}
            </h3>
          </div>
          <Badge variant={botStatusBadgeVariant(bot.status)} className="font-data text-xs">
            {runtimeModeLabel(bot)}
          </Badge>
        </div>

        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3 [scrollbar-gutter:stable]">
          {recordGroups.map((group) => (
            <RecordSection key={group.title} title={group.title} rows={group.rows} />
          ))}
        </div>
      </aside>
    </div>
  );
}

function OperationsPanelNav({
  items,
  activeValue,
  onSelect,
}: {
  items: PanelItem[];
  activeValue: OperationsPanel;
  onSelect: (panel: OperationsPanel) => void;
}) {
  return (
    <nav
      className="flex max-w-full gap-1 overflow-x-auto rounded-[5px] border border-[#273035] bg-[#081013] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
      aria-label="Operations panels"
    >
      {items.map((item) => {
        const selected = item.value === activeValue;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onSelect(item.value)}
            aria-current={selected ? 'page' : undefined}
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-[5px] px-3 font-display text-sm font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
              selected
                ? 'bg-[#12302e] text-[#f6fefd] shadow-[inset_3px_0_0_rgba(80,210,193,0.92)]'
                : 'text-[#949e9c] hover:bg-[#16242a] hover:text-[#f6fefd]'
            }`}
          >
            <span className={`${item.icon} text-base ${selected ? 'text-[#50d2c1]' : 'text-[#697371]'}`} aria-hidden="true" />
            <span>{item.label}</span>
            {item.badge && (
              <Badge variant="amber" className="text-[10px]">
                {item.badge}
              </Badge>
            )}
          </button>
        );
      })}
    </nav>
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
    <div
      className={`arena-trace-terminal flex h-full min-h-0 flex-col overflow-hidden rounded-[5px] border border-[#273035] bg-[#081013] text-[#f6fefd] ${terminalOperationsClass}`}
    >
      <div className="shrink-0 border-b border-[#273035] bg-[#0b1418] px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate font-display text-xl font-semibold tracking-tight text-[#f6fefd]">
              {effectiveActivePanel === 'overview' ? 'Control Plane' : activeItem?.label ?? 'Runtime State'}
            </h2>
            <span className="hidden rounded-[4px] border border-[#273035] bg-[#081013] px-2 py-1 font-data text-xs text-[#949e9c] min-[780px]:inline" translate="no">
              {botName}
            </span>
          </div>
          <OperationsPanelNav
            items={panels}
            activeValue={effectiveActivePanel}
            onSelect={selectPanel}
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
