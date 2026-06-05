import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { resolveOperatorRpc, useOperators } from '@tangle-network/blueprint-ui';
import type { Address } from 'viem';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { ALL_TRADING_OPERATOR_API_URLS, type OperatorMeta } from '~/lib/operator/meta';
import { TRADING_BLUEPRINTS, type TradingBlueprintDef } from '~/lib/blueprints';

export const meta: MetaFunction = () => [
  { title: 'Operators | Tangle Trading' },
  { name: 'description', content: 'Trading blueprint operators, request access, and quote endpoints.' },
];

interface OperatorApiRow {
  url: string;
  ok: boolean;
  meta?: OperatorMeta;
  error?: string;
}

interface BlueprintOperatorRow {
  key: string;
  source: 'registered' | 'configured-api';
  address?: string | null;
  rpcAddress?: string;
  apiUrl?: string;
  api?: OperatorApiRow;
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return 'Not set';
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function accessTone(mode: string | undefined) {
  return mode === 'public'
    ? 'border-[#50d2c1]/45 bg-[#50d2c1]/10 text-[#0f766e] dark:text-[#9af4e8]'
    : 'border-[#f2d073]/40 bg-[#f2d073]/12 text-[#8a5a00] dark:text-[#f6d77c]';
}

function healthTone(ok: boolean | undefined) {
  if (ok) return 'border-[#50d2c1]/45 bg-[#50d2c1]/10 text-[#0f766e] dark:text-[#9af4e8]';
  if (ok === false) return 'border-[#f87171]/35 bg-[#f87171]/10 text-[#b42318] dark:text-[#fca5a5]';
  return 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] text-[var(--arena-terminal-muted)]';
}

function normalizeDirectoryUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

async function fetchOperatorApis(): Promise<OperatorApiRow[]> {
  const rows = await Promise.all(
    ALL_TRADING_OPERATOR_API_URLS.map(async (url) => {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), 4_000);
      try {
        const res = await fetch(`${url}/api/meta`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { url, ok: true, meta: await res.json() as OperatorMeta };
      } catch (error) {
        return {
          url,
          ok: false,
          error: error instanceof Error ? error.message : 'Unavailable',
        };
      } finally {
        globalThis.clearTimeout(timeout);
      }
    }),
  );
  return rows;
}

function BlueprintTabs({
  blueprints,
  selected,
  onSelect,
}: {
  blueprints: TradingBlueprintDef[];
  selected: TradingBlueprintDef | undefined;
  onSelect: (blueprint: TradingBlueprintDef) => void;
}) {
  if (blueprints.length <= 1) return null;
  return (
    <div className="flex min-w-0 gap-1 overflow-x-auto border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-1">
      {blueprints.map((blueprint) => {
        const active = selected?.id === blueprint.id;
        return (
          <button
            key={blueprint.id}
            type="button"
            onClick={() => onSelect(blueprint)}
            className={[
              'h-8 shrink-0 px-3 text-xs font-display font-semibold transition-colors',
              active
                ? 'bg-[#143c38] text-[#f6fefd]'
                : 'text-[var(--arena-terminal-muted)] hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)]',
            ].join(' ')}
          >
            {blueprint.name}
          </button>
        );
      })}
    </div>
  );
}

function buildBlueprintOperatorRows({
  operators,
  apiRows,
  apiLoading,
}: {
  operators: Array<{ address: Address; rpcAddress?: string }>;
  apiRows: OperatorApiRow[];
  apiLoading: boolean;
}): BlueprintOperatorRow[] {
  const displayedApiRows: OperatorApiRow[] = apiLoading
    ? ALL_TRADING_OPERATOR_API_URLS.map((url) => ({ url, ok: false }))
    : apiRows;
  const apiByUrl = new Map(
    displayedApiRows.map((row) => [normalizeDirectoryUrl(row.url), row]),
  );
  const registeredApiUrls = new Set<string>();

  const rows: BlueprintOperatorRow[] = operators.map((operator) => {
    const apiUrl = normalizeDirectoryUrl(
      operator.rpcAddress ? resolveOperatorRpc(operator.rpcAddress) : undefined,
    );
    if (apiUrl) registeredApiUrls.add(apiUrl);
    return {
      key: `registered-${operator.address}`,
      source: 'registered',
      address: operator.address,
      rpcAddress: operator.rpcAddress,
      apiUrl,
      api: apiUrl ? apiByUrl.get(apiUrl) : undefined,
    };
  });

  displayedApiRows.forEach((api) => {
    const apiUrl = normalizeDirectoryUrl(api.url);
    if (!apiUrl || registeredApiUrls.has(apiUrl)) return;
    rows.push({
      key: `configured-${apiUrl}`,
      source: 'configured-api',
      address: api.meta?.request_access?.operator_address ?? undefined,
      apiUrl,
      api,
    });
  });

  return rows;
}

function BlueprintOperatorsTable({
  rows,
  isLoadingOperators,
  selectedBlueprint,
}: {
  rows: BlueprintOperatorRow[];
  isLoadingOperators: boolean;
  selectedBlueprint: TradingBlueprintDef | undefined;
}) {
  const empty = rows.length === 0;

  return (
    <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <div className="divide-y divide-[var(--arena-terminal-border)] md:hidden">
        {isLoadingOperators && empty ? (
          <div className="px-3 py-4 text-sm text-[var(--arena-terminal-muted)]">Loading operators...</div>
        ) : empty ? (
          <div className="px-3 py-4 text-sm text-[var(--arena-terminal-muted)]">No operators found for this blueprint.</div>
        ) : (
          rows.map((row) => {
            const access = row.api?.meta?.request_access;
            return (
              <div key={row.key} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-data text-[var(--arena-terminal-text)]" title={row.address ?? undefined}>
                      {row.address ? shortAddress(row.address) : 'Operator API'}
                    </div>
                    <div className="truncate font-data text-xs text-[var(--arena-terminal-muted)]" title={row.apiUrl || row.rpcAddress}>
                      {row.apiUrl || 'No RPC registered'}
                    </div>
                  </div>
                  <span className={`inline-flex h-7 shrink-0 items-center border px-2 text-xs font-display font-semibold ${healthTone(row.api?.ok)}`}>
                    {row.api?.ok ? 'Online' : row.api ? 'Offline' : 'Unverified'}
                  </span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className={`inline-flex h-7 items-center border px-2 text-xs font-display font-semibold ${accessTone(access?.mode)}`}>
                    {access?.mode === 'public' ? 'Public' : 'Allowlist'}
                  </span>
                  <Link to="/provision" className="font-display text-sm text-[#148f82] hover:text-[#0f766e] dark:text-[#50d2c1] dark:hover:text-[#c8fffb]">
                    Request
                  </Link>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <div className="min-w-[900px]">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_120px_120px_120px] gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2 text-xs font-data uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
          <span>Operator</span>
          <span>RPC / API</span>
          <span>Access</span>
          <span>Health</span>
          <span>Action</span>
        </div>
        <div className="divide-y divide-[var(--arena-terminal-border)]">
          {isLoadingOperators && empty ? (
            <div className="px-3 py-4 text-sm text-[var(--arena-terminal-muted)]">Loading operators...</div>
          ) : empty ? (
            <div className="px-3 py-4 text-sm text-[var(--arena-terminal-muted)]">
              No operators found for {selectedBlueprint?.name ?? 'this blueprint'}.
            </div>
          ) : (
            rows.map((row) => {
              const access = row.api?.meta?.request_access;
              return (
                <div key={row.key} className="grid min-h-12 grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_120px_120px_120px] items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-data text-[var(--arena-terminal-text)]" title={row.address ?? undefined}>
                      {row.address ?? 'Configured API'}
                    </div>
                    <div className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      {row.source === 'registered' ? 'on-chain registration' : 'configured endpoint'}
                    </div>
                  </div>
                  <a
                    href={row.apiUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate font-data text-[#148f82] hover:text-[#0f766e] dark:text-[#9af4e8] dark:hover:text-[#c8fffb]"
                    title={row.apiUrl || row.rpcAddress}
                  >
                    {row.apiUrl || 'No RPC registered'}
                  </a>
                  <span className={`inline-flex h-7 w-fit items-center border px-2 text-xs font-display font-semibold ${accessTone(access?.mode)}`}>
                    {access?.mode === 'public' ? 'Public' : 'Allowlist'}
                  </span>
                  <span className={`inline-flex h-7 w-fit items-center border px-2 text-xs font-display font-semibold ${healthTone(row.api?.ok)}`} title={row.api?.error}>
                    {row.api?.ok ? row.api.meta?.deployment_kind ?? 'online' : row.api ? 'offline' : 'unverified'}
                  </span>
                  <Link to="/provision" className="w-fit font-display text-sm font-semibold text-[#148f82] hover:text-[#0f766e] dark:text-[#50d2c1] dark:hover:text-[#c8fffb]">
                    Request
                  </Link>
                </div>
              );
            })
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

export default function OperatorsPage() {
  const [selectedId, setSelectedId] = useState(() => TRADING_BLUEPRINTS[0]?.id ?? '');
  const selectedBlueprint = useMemo(
    () => TRADING_BLUEPRINTS.find((blueprint) => blueprint.id === selectedId) ?? TRADING_BLUEPRINTS[0],
    [selectedId],
  );
  const blueprintId = selectedBlueprint ? BigInt(selectedBlueprint.blueprintId) : 0n;
  const { operators, operatorCount } = useOperators(blueprintId);
  const apiQuery = useQuery({
    queryKey: ['operator-api-directory', ALL_TRADING_OPERATOR_API_URLS],
    queryFn: fetchOperatorApis,
    staleTime: 30_000,
  });
  const publicApiCount = (apiQuery.data ?? []).filter((row) => row.meta?.request_access?.mode === 'public').length;
  const directoryRows = useMemo(
    () => buildBlueprintOperatorRows({
      operators,
      apiRows: apiQuery.data ?? [],
      apiLoading: apiQuery.isLoading,
    }),
    [apiQuery.data, apiQuery.isLoading, operators],
  );

  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <ArenaPageHeader
        title="Operators"
        titleWidthClassName="min-[1180px]:w-[11rem]"
        metrics={[
          { label: 'APIs', value: ALL_TRADING_OPERATOR_API_URLS.length.toString() },
          { label: 'On-chain', value: operatorCount.toString() },
          { label: 'Public', value: publicApiCount.toString() },
        ]}
        controls={(
          <>
            <ArenaHeaderLink to="/provision" icon="i-ph:rocket-launch" variant="primary">Request Instance</ArenaHeaderLink>
            <ArenaHeaderLink to="/create" icon="i-ph:chat-circle-dots">New Agent</ArenaHeaderLink>
          </>
        )}
      >
        <p className="truncate text-sm text-[var(--arena-terminal-muted)]">
          Operator APIs create bots; on-chain registrations activate services.
        </p>
      </ArenaPageHeader>

      <div className="space-y-5 px-3 pb-8 pt-3 sm:px-4 lg:px-5">
        <BlueprintTabs
          blueprints={TRADING_BLUEPRINTS}
          selected={selectedBlueprint}
          onSelect={(blueprint) => setSelectedId(blueprint.id)}
        />

        <section className="space-y-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-[var(--arena-terminal-text)]">
                {selectedBlueprint?.name ?? 'Trading'} operators
              </h2>
              <p className="text-sm text-[var(--arena-terminal-muted)]">
                {operatorCount.toString()} registered on-chain for blueprint #{selectedBlueprint?.blueprintId ?? '0'}.
              </p>
            </div>
            <Link to="/provision" className="hidden text-sm font-display text-[#50d2c1] hover:text-[#c8fffb] sm:inline-flex">
              Quote and request
            </Link>
          </div>
          <BlueprintOperatorsTable
            rows={directoryRows}
            isLoadingOperators={operators.length === 0 && operatorCount > 0n}
            selectedBlueprint={selectedBlueprint}
          />
        </section>
      </div>
    </div>
  );
}
