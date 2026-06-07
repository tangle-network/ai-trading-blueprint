import { useMemo, useState, type ReactNode } from 'react';
import type { MetaFunction } from 'react-router';
import { ConnectKitButton } from 'connectkit';
import { useAccount } from 'wagmi';
import { toast } from 'sonner';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  Globe,
  Lock,
  Plus,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { copyText } from '@tangle-network/sandbox-ui/utils';
import type { Address } from 'viem';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { StatusBadge } from '~/components/ui/StatusBadge';
import {
  OPERATOR_API_PORT,
  OPERATOR_STRATEGY_OPTIONS,
  buildInstallCommand,
  buildOperatorEnvBlock,
  normalizeOperatorAddress,
  type AccessMode,
  type OperatorStrategyId,
} from '~/lib/operator/registration';
import { useOperatorReadiness } from '~/lib/operator/useOperatorReadiness';

export const meta: MetaFunction = () => [
  { title: 'Become an operator | Tangle Trading' },
  {
    name: 'description',
    content:
      'Host trading agents on your own infrastructure. Set who can launch agents on your operator, advertise capacity, and earn fees.',
  },
];

function Panel({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]">{description}</p>
          )}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </header>
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

const inputClass =
  'h-9 w-full rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2 font-mono text-sm text-[var(--arena-terminal-text)] placeholder:text-[var(--arena-terminal-text-subtle)] transition-[border-color] duration-150 hover:border-[var(--arena-terminal-border-hover)] focus-visible:border-[var(--arena-terminal-border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]';

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        await copyText(value);
        toast.success(`${label} copied`);
      }}
      className="inline-flex h-7 items-center gap-1.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] px-2.5 font-data text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-secondary)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:text-[var(--arena-terminal-text)]"
    >
      <Copy className="h-3 w-3" aria-hidden="true" />
      Copy
    </button>
  );
}

function AccessModeOption({
  mode,
  active,
  icon,
  title,
  outcome,
  onSelect,
}: {
  mode: AccessMode;
  active: boolean;
  icon: ReactNode;
  title: string;
  outcome: string;
  onSelect: (mode: AccessMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      aria-pressed={active}
      className={[
        'flex flex-1 items-start gap-2.5 border px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-[var(--arena-terminal-accent)]/60 bg-[var(--arena-terminal-accent-soft)]'
          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] hover:border-[var(--arena-terminal-border-hover)]',
      ].join(' ')}
    >
      <span
        className={`mt-0.5 shrink-0 ${active ? 'text-[var(--arena-terminal-accent)]' : 'text-[var(--arena-terminal-text-muted)]'}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]">{outcome}</span>
      </span>
    </button>
  );
}

function ReadinessRow({ endpoint }: { endpoint: string }) {
  const readiness = useOperatorReadiness(endpoint);
  const access = readiness.meta?.request_access;

  const statusLabel =
    readiness.state === 'online'
      ? 'live'
      : readiness.state === 'checking'
        ? 'pending'
        : readiness.state === 'offline'
          ? 'error'
          : 'idle';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <StatusBadge
          status={statusLabel}
          labelOverride={
            readiness.state === 'online'
              ? 'Online'
              : readiness.state === 'checking'
                ? 'Checking…'
                : readiness.state === 'offline'
                  ? 'Offline'
                  : 'Idle'
          }
          size="sm"
        />
        <button
          type="button"
          onClick={readiness.refetch}
          disabled={readiness.isFetching}
          className="inline-flex h-7 items-center gap-1.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] px-2.5 font-data text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-secondary)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:text-[var(--arena-terminal-text)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Activity className={`h-3 w-3 ${readiness.isFetching ? 'animate-pulse' : ''}`} aria-hidden="true" />
          Recheck
        </button>
      </div>

      {readiness.state === 'online' && access && (
        <div className="border border-[var(--arena-terminal-success-border)] bg-[var(--arena-terminal-success-soft)] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
            <span className="font-display text-sm font-semibold text-[var(--arena-terminal-success)]">
              Your operator is answering with{' '}
              {access.mode === 'public' ? 'public' : 'allowlist'} access
            </span>
          </div>
          <p className="mt-1 pl-6 text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
            {access.mode === 'public'
              ? 'Anyone can launch agents on your operator right now.'
              : `${access.allowed_requester_count} wallet${access.allowed_requester_count === 1 ? '' : 's'} can launch agents on your operator right now.`}
            {access.operator_address ? ` Identity: ${access.operator_address.slice(0, 6)}…${access.operator_address.slice(-4)}.` : ''}
          </p>
        </div>
      )}

      {readiness.state === 'offline' && (
        <div className="border border-[var(--arena-terminal-warning)]/45 bg-[var(--arena-terminal-warning)]/[0.08] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--arena-terminal-warning)]" aria-hidden="true" />
            <div className="min-w-0">
              <span className="font-display text-sm font-semibold text-[var(--arena-terminal-warning)]">
                Not answering yet
              </span>
              <p className="mt-1 text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">{readiness.reason}</p>
              {readiness.detail && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer select-none font-data text-[10px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)] hover:text-[var(--arena-terminal-text-muted)]">
                    Technical detail
                  </summary>
                  <p className="mt-1 break-words font-data text-[11px] leading-relaxed text-[var(--arena-terminal-text-muted)]">
                    {readiness.detail}
                  </p>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function OperatorRegisterPage() {
  const { address, isConnected } = useAccount();
  const operatorAddress = (address ?? undefined) as Address | undefined;

  const [accessMode, setAccessMode] = useState<AccessMode>('allowlist');
  const [allowlistInput, setAllowlistInput] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [maxCapacity, setMaxCapacity] = useState('5');
  const [endpoint, setEndpoint] = useState('');
  const [strategies, setStrategies] = useState<OperatorStrategyId[]>([]);
  const [feePercent, setFeePercent] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  function addAllowlistEntry() {
    const normalized = normalizeOperatorAddress(allowlistInput);
    if (!normalized) {
      setAllowlistError('Enter a valid 0x… wallet address (40 hex characters).');
      return;
    }
    if (allowlist.includes(normalized)) {
      setAllowlistError('That wallet is already on the allowlist.');
      return;
    }
    setAllowlist((prev) => [...prev, normalized].sort());
    setAllowlistInput('');
    setAllowlistError(null);
  }

  function toggleStrategy(id: OperatorStrategyId) {
    setStrategies((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  const capacityNumber = useMemo(() => {
    const parsed = Number.parseInt(maxCapacity, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }, [maxCapacity]);

  const envBlock = useMemo(
    () =>
      buildOperatorEnvBlock({
        accessMode,
        allowlist,
        maxCapacity: capacityNumber,
        apiEndpoint: endpoint.trim() || undefined,
        operatorAddress,
        strategies,
      }),
    [accessMode, allowlist, capacityNumber, endpoint, operatorAddress, strategies],
  );

  const installCommand = useMemo(() => buildInstallCommand(envBlock), [envBlock]);
  const trimmedEndpoint = endpoint.trim();

  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <ArenaPageHeader
        title="Become an operator"
        titleWidthClassName="min-[1180px]:w-[16rem]"
        metrics={[
          { label: 'Access', value: accessMode === 'public' ? 'Public' : 'Allowlist' },
          { label: 'Capacity', value: capacityNumber ? String(capacityNumber) : '∞' },
          { label: 'Wallets', value: accessMode === 'public' ? '∞' : String(allowlist.length) },
        ]}
        controls={<ArenaHeaderLink to="/operators" icon="i-ph:list" variant="secondary">Directory</ArenaHeaderLink>}
      >
        <p className="truncate text-sm text-[var(--arena-terminal-muted)]">
          Host trading agents on your infrastructure. You decide who can launch and how many.
        </p>
      </ArenaPageHeader>

      <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:px-4">
        {/* 1. Identity */}
        <Panel
          title="Operator identity"
          description="The wallet you connect is your operator identity — it can always launch agents on your own node."
          aside={
            isConnected ? (
              <StatusBadge status="confirmed" labelOverride="Connected" size="sm" />
            ) : undefined
          }
        >
          {isConnected && operatorAddress ? (
            <div className="flex items-center gap-2 font-data text-sm text-[var(--arena-terminal-text)]">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
              <span className="truncate">{operatorAddress}</span>
            </div>
          ) : (
            <ConnectKitButton.Custom>
              {({ show, isConnecting }) => (
                <button
                  type="button"
                  onClick={() => show?.()}
                  disabled={!show || isConnecting}
                  className="arena-command-link-primary inline-flex h-9 items-center justify-center gap-2 border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="i-ph:plug text-base" aria-hidden="true" />
                  {isConnecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
            </ConnectKitButton.Custom>
          )}
        </Panel>

        {/* 2. Access mode */}
        <Panel
          title="Who can launch agents"
          description="Enforced fail-closed on the provision path — not just advertised. In allowlist mode, only these wallets can launch an agent on your operator."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <AccessModeOption
              mode="allowlist"
              active={accessMode === 'allowlist'}
              icon={<Lock className="h-4 w-4" />}
              title="Allowlist"
              outcome="Only wallets you add can launch agents on your operator."
              onSelect={setAccessMode}
            />
            <AccessModeOption
              mode="public"
              active={accessMode === 'public'}
              icon={<Globe className="h-4 w-4" />}
              title="Public"
              outcome="Anyone can launch agents on your operator, up to your capacity."
              onSelect={setAccessMode}
            />
          </div>

          {accessMode === 'allowlist' && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 shrink-0 text-[var(--arena-terminal-text-muted)]" aria-hidden="true" />
                <span className="font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                  Allowed wallets
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  value={allowlistInput}
                  onChange={(e) => {
                    setAllowlistInput(e.target.value);
                    setAllowlistError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addAllowlistEntry();
                    }
                  }}
                  placeholder="0x… wallet address"
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={addAllowlistEntry}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] px-3 font-display text-sm font-semibold text-[var(--arena-terminal-text-secondary)] transition-colors hover:border-[var(--arena-terminal-border-hover)] hover:text-[var(--arena-terminal-text)]"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add
                </button>
              </div>
              {allowlistError && (
                <p className="font-data text-xs text-[var(--arena-terminal-danger)]">{allowlistError}</p>
              )}
              {allowlist.length > 0 ? (
                <ul className="space-y-1">
                  {allowlist.map((wallet) => (
                    <li
                      key={wallet}
                      className="flex items-center justify-between gap-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2.5 py-1.5"
                    >
                      <span className="truncate font-data text-xs text-[var(--arena-terminal-text)]">{wallet}</span>
                      <button
                        type="button"
                        onClick={() => setAllowlist((prev) => prev.filter((w) => w !== wallet))}
                        className="shrink-0 text-[var(--arena-terminal-text-muted)] transition-colors hover:text-[var(--arena-terminal-danger)]"
                        aria-label={`Remove ${wallet}`}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[var(--arena-terminal-text-muted)]">
                  No wallets yet. Your own wallet can always launch agents on your operator.
                </p>
              )}
            </div>
          )}
        </Panel>

        {/* 3. Capacity */}
        <Panel
          title="Capacity"
          description="Max concurrent agents your node will host. Enforced on the provision path — requests beyond this are refused. Leave at 0 for unlimited."
        >
          <label className="block max-w-[12rem]">
            <span className="mb-1.5 block font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
              Max concurrent agents
            </span>
            <input
              type="number"
              min={0}
              value={maxCapacity}
              onChange={(e) => setMaxCapacity(e.target.value)}
              className={inputClass}
            />
          </label>
        </Panel>

        {/* 4. Strategies + pricing */}
        <Panel
          title="Supported strategies"
          description="Advertised in the directory so requesters know what your operator hosts. Optional."
        >
          <div className="flex flex-wrap gap-2">
            {OPERATOR_STRATEGY_OPTIONS.map((option) => {
              const active = strategies.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => toggleStrategy(option.id)}
                  aria-pressed={active}
                  className={[
                    'inline-flex h-8 items-center gap-1.5 border px-2.5 font-display text-xs font-medium transition-colors',
                    active
                      ? 'border-[var(--arena-terminal-accent)]/60 bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]'
                      : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text-secondary)] hover:border-[var(--arena-terminal-border-hover)] hover:text-[var(--arena-terminal-text)]',
                  ].join(' ')}
                >
                  {active && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
                  {option.label}
                </button>
              );
            })}
          </div>

          <label className="mt-3 block max-w-[12rem]">
            <span className="mb-1.5 block font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
              Fee on hosted agents (%) — optional
            </span>
            <input
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={feePercent}
              onChange={(e) => setFeePercent(e.target.value)}
              placeholder="e.g. 5"
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-[var(--arena-terminal-text-muted)]">
              You earn fees from agents you host. Set on-chain in the fee distributor; left out of the install env.
            </span>
          </label>
        </Panel>

        {/* 5. Endpoint + readiness */}
        <Panel
          title="Endpoint & readiness"
          description="Your operator API's public URL. We poll it live so you can see your node answer and your own policy reflected."
        >
          <label className="block">
            <span className="mb-1.5 block font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
              Operator API endpoint
            </span>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={`https://your-host:${OPERATOR_API_PORT}`}
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </label>
          <div className="mt-3">
            {trimmedEndpoint ? (
              <ReadinessRow endpoint={trimmedEndpoint} />
            ) : (
              <p className="text-xs text-[var(--arena-terminal-text-muted)]">
                Enter your endpoint above to run a live readiness check.
              </p>
            )}
          </div>
        </Panel>

        {/* 6. Install */}
        <Panel
          title="Run your operator"
          description="Copy this into your operator host. The env block is prefilled with the choices above."
          aside={<CopyButton value={installCommand} label="Install command" />}
        >
          <pre className="overflow-x-auto border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
            {installCommand}
          </pre>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
              .env block
            </span>
            <CopyButton value={envBlock} label="Env block" />
          </div>
          <pre className="mt-1.5 overflow-x-auto border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
            {envBlock}
          </pre>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="mt-3 inline-flex items-center gap-1.5 font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)] transition-colors hover:text-[var(--arena-terminal-text-muted)]"
            aria-expanded={showAdvanced}
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            Advanced — how enforcement works
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]">
              <p>
                <code className="font-mono text-[var(--arena-terminal-text-secondary)]">TRADING_REQUESTER_ACCESS_MODE</code>{' '}
                and <code className="font-mono text-[var(--arena-terminal-text-secondary)]">TRADING_REQUESTER_ALLOWLIST</code>{' '}
                are read by the provision job handler, which calls{' '}
                <code className="font-mono text-[var(--arena-terminal-text-secondary)]">ensure_provision_allowed</code> before
                serving a request — so a request that bypasses the API still has to satisfy your policy.
              </p>
              <p>
                <code className="font-mono text-[var(--arena-terminal-text-secondary)]">OPERATOR_MAX_CAPACITY</code> is encoded
                into your on-chain registration payload and re-checked at provision time against live agent count.
              </p>
              <p>
                Your live policy is published at{' '}
                <code className="font-mono text-[var(--arena-terminal-text-secondary)]">/api/meta</code> under{' '}
                <code className="font-mono text-[var(--arena-terminal-text-secondary)]">request_access</code> — the same field
                the readiness check above reads back.
              </p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
