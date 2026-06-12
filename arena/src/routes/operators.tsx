import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { resolveOperatorRpc, useOperators } from '@tangle-network/blueprint-ui';
import { Identicon, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle-network/blueprint-ui/components';
import type { Address } from 'viem';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { SQUARE_TABLE_CLASS, StaticTableHeaderLabel } from '~/components/arena/SortableTableHeader';
import { Skeleton, SkeletonTableRow } from '~/components/ui/Skeleton';
import type { OperatorMeta } from '~/lib/operator/meta';
import { isMixedContentBlocked, useOperatorDirectory } from '~/lib/operator/discovery';
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
  /** http endpoint on an https page: the browser blocks the request before it leaves. */
  noTls?: boolean;
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
  if (!mode)
    return 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] text-[var(--arena-terminal-muted)]';
  return mode === 'public'
    ? 'border-[#50d2c1]/45 bg-[#50d2c1]/10 text-[#0f766e] dark:text-[#9af4e8]'
    : 'border-[#f2d073]/40 bg-[#f2d073]/12 text-[#8a5a00] dark:text-[#f6d77c]';
}

function accessLabel(mode: string | undefined): string {
  if (!mode) return 'Unknown';
  return mode === 'public' ? 'Public' : 'Allowlist';
}

function healthTone(ok: boolean | undefined) {
  if (ok) return 'border-[#50d2c1]/45 bg-[#50d2c1]/10 text-[#0f766e] dark:text-[#9af4e8]';
  if (ok === false) return 'border-[#f87171]/35 bg-[#f87171]/10 text-[#b42318] dark:text-[#fca5a5]';
  return 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] text-[var(--arena-terminal-muted)]';
}

function healthLabel(row: BlueprintOperatorRow): string {
  if (row.api?.ok) return 'Online';
  if (row.api?.noTls) return 'No TLS';
  if (row.api) return 'Offline';
  return 'Unverified';
}

function deploymentLabel(kind: OperatorMeta['deployment_kind'] | undefined): string {
  if (kind === 'fleet') return 'Shared endpoint';
  if (kind === 'instance') return 'Dedicated endpoint';
  return 'Endpoint';
}

function provisionHref(
  blueprint: TradingBlueprintDef | undefined,
  row?: BlueprintOperatorRow,
): string {
  const params = new URLSearchParams();
  if (blueprint) params.set('blueprint', blueprint.id);
  const operator = row?.address ?? row?.api?.meta?.request_access?.operator_address;
  if (operator) params.set('operator', operator);
  const query = params.toString();
  return query ? `/provision?${query}` : '/provision';
}

function normalizeDirectoryUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

function OperatorIdentity({ row, size = 28 }: { row: BlueprintOperatorRow; size?: number }) {
  const operatorAddress = row.address ?? row.api?.meta?.request_access?.operator_address;
  if (!operatorAddress) {
    return (
      <span className="flex shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] text-[var(--arena-terminal-muted)]" style={{ width: size, height: size }}>
        <span className="i-ph:plug text-sm" aria-hidden="true" />
      </span>
    );
  }
  return <Identicon address={operatorAddress as Address} size={size} />;
}

async function fetchOperatorApis(urls: string[]): Promise<OperatorApiRow[]> {
  const rows = await Promise.all(
    urls.map(async (url) => {
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
  fallbackUrls,
}: {
  operators: Array<{ address: Address; rpcAddress?: string }>;
  apiRows: OperatorApiRow[];
  apiLoading: boolean;
  fallbackUrls: string[];
}): BlueprintOperatorRow[] {
  const displayedApiRows: OperatorApiRow[] = apiLoading
    ? fallbackUrls.map((url) => ({ url, ok: false }))
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
    let api = apiUrl ? apiByUrl.get(apiUrl) : undefined;
    if (!api && apiUrl && isMixedContentBlocked(apiUrl)) {
      api = { url: apiUrl, ok: false, noTls: true, error: 'Unreachable from browser (no TLS)' };
    }
    return {
      key: `registered-${operator.address}`,
      source: 'registered',
      address: operator.address,
      rpcAddress: operator.rpcAddress,
      apiUrl,
      api,
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
          // Mirror the loaded card layout (identity row + chips) so resolved
          // operators replace skeletons without resizing the panel.
          Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="space-y-2 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-[30px] w-[30px]" />
                  <div>
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="mt-1.5 h-3 w-40" />
                  </div>
                </div>
                <Skeleton className="h-7 w-16" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-7 w-20" />
                <Skeleton className="h-8 w-20" />
              </div>
            </div>
          ))
        ) : empty ? (
          <div className="px-3 py-4 text-sm text-[var(--arena-terminal-muted)]">No operators found for this blueprint.</div>
        ) : (
          rows.map((row) => {
            const access = row.api?.meta?.request_access;
            const status = healthLabel(row);
            return (
              <div key={row.key} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <OperatorIdentity row={row} size={30} />
                    <div className="min-w-0">
                      <div className="truncate font-data text-[var(--arena-terminal-text)]" title={row.address ?? undefined}>
                        {row.address ? shortAddress(row.address) : 'Operator API'}
                      </div>
                      <div className="truncate font-data text-xs text-[var(--arena-terminal-muted)]" title={row.apiUrl || row.rpcAddress}>
                        {row.apiUrl || 'No RPC registered'}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`inline-flex h-7 shrink-0 items-center border px-2 text-xs font-display font-semibold ${healthTone(row.api?.ok)}`}
                    title={row.api?.noTls ? 'Unreachable from browser (no TLS). Operator endpoints must be served over https.' : row.api?.error}
                  >
                    {status}
                  </span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className={`inline-flex h-7 items-center border px-2 text-xs font-display font-semibold ${accessTone(access?.mode)}`}>
                    {accessLabel(access?.mode)}
                  </span>
                  <Link
                    to={provisionHref(selectedBlueprint, row)}
                    className="inline-flex h-8 items-center border border-[#50d2c1]/35 px-2 font-display text-sm font-semibold text-[#148f82] hover:border-[#50d2c1]/60 hover:bg-[#50d2c1]/10 hover:text-[#0f766e] dark:text-[#50d2c1] dark:hover:text-[#c8fffb]"
                  >
                    Request
                  </Link>
                </div>
                {row.api?.ok && (
                  <div className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                    {deploymentLabel(row.api.meta?.deployment_kind)}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className={`hidden overflow-x-auto md:block ${SQUARE_TABLE_CLASS}`}>
        <Table className={`w-full min-w-[900px] table-fixed bg-[var(--arena-terminal-panel)] ${SQUARE_TABLE_CLASS}`}>
          <TableHeader>
            <TableRow className="border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] hover:bg-[var(--arena-terminal-surface)]">
              <TableHead className="py-2"><StaticTableHeaderLabel>Operator</StaticTableHeaderLabel></TableHead>
              <TableHead className="w-[28%] py-2"><StaticTableHeaderLabel>RPC / API</StaticTableHeaderLabel></TableHead>
              <TableHead className="w-[120px] py-2"><StaticTableHeaderLabel>Access</StaticTableHeaderLabel></TableHead>
              <TableHead className="w-[120px] py-2"><StaticTableHeaderLabel>Health</StaticTableHeaderLabel></TableHead>
              <TableHead className="w-[120px] py-2"><StaticTableHeaderLabel>Action</StaticTableHeaderLabel></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoadingOperators && empty ? (
              Array.from({ length: 3 }).map((_, index) => (
                <SkeletonTableRow key={index} cols={5} />
              ))
            ) : empty ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-3 py-4 text-sm text-[var(--arena-terminal-muted)]">
                  No operators found for {selectedBlueprint?.name ?? 'this blueprint'}.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const access = row.api?.meta?.request_access;
                const status = healthLabel(row);
                return (
                  <TableRow key={row.key} className="border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)]">
                    <TableCell className="min-w-0 py-2 align-middle">
                      <div className="flex min-w-0 items-center gap-3">
                        <OperatorIdentity row={row} />
                        <div className="min-w-0">
                          <div className="truncate font-data text-sm text-[var(--arena-terminal-text)]" title={row.address ?? undefined}>
                            {row.address ?? 'Configured API'}
                          </div>
                          <div className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                            {row.source === 'registered' ? 'on-chain registration' : deploymentLabel(row.api?.meta?.deployment_kind)}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-0 py-2 align-middle">
                      <a
                        href={row.apiUrl || undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="block min-w-0 truncate font-data text-sm text-[#148f82] hover:text-[#0f766e] dark:text-[#9af4e8] dark:hover:text-[#c8fffb]"
                        title={row.apiUrl || row.rpcAddress}
                      >
                        {row.apiUrl || 'No RPC registered'}
                      </a>
                    </TableCell>
                    <TableCell className="py-2 align-middle">
                      <span className={`inline-flex h-7 w-fit items-center border px-2 text-xs font-display font-semibold ${accessTone(access?.mode)}`}>
                        {accessLabel(access?.mode)}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-0 py-2 align-middle">
                      <span
                        className={`inline-flex h-7 w-fit items-center border px-2 text-xs font-display font-semibold ${healthTone(row.api?.ok)}`}
                        title={row.api?.noTls ? 'Unreachable from browser (no TLS). Operator endpoints must be served over https.' : row.api?.error}
                      >
                        {status}
                      </span>
                      {row.api?.ok && (
                        <div className="mt-1 truncate font-data text-[11px] text-[var(--arena-terminal-text-subtle)]">
                          {deploymentLabel(row.api.meta?.deployment_kind)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="py-2 align-middle">
                      <Link
                        to={provisionHref(selectedBlueprint, row)}
                        className="inline-flex h-8 w-fit items-center border border-[#50d2c1]/35 px-2 font-display text-sm font-semibold text-[#148f82] hover:border-[#50d2c1]/60 hover:bg-[#50d2c1]/10 hover:text-[#0f766e] dark:text-[#50d2c1] dark:hover:text-[#c8fffb]"
                      >
                        Request
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
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
  const directory = useOperatorDirectory();
  // Probe only browser-reachable endpoints; no-TLS endpoints are surfaced as
  // static rows so operators learn their endpoint must be served over https.
  const probeUrls = directory.apiUrls;
  const blockedApiRows = useMemo<OperatorApiRow[]>(
    () => directory.endpoints
      .filter((endpoint) => !endpoint.browserReachable)
      .map((endpoint) => ({
        url: endpoint.apiUrl,
        ok: false,
        noTls: true,
        error: 'Unreachable from browser (no TLS)',
      })),
    [directory.endpoints],
  );
  const apiQuery = useQuery({
    queryKey: ['operator-api-directory', probeUrls],
    queryFn: () => fetchOperatorApis(probeUrls),
    staleTime: 30_000,
  });
  const publicApiCount = (apiQuery.data ?? []).filter((row) => row.meta?.request_access?.mode === 'public').length;
  const directoryRows = useMemo(
    () => buildBlueprintOperatorRows({
      operators,
      apiRows: [...(apiQuery.data ?? []), ...blockedApiRows],
      apiLoading: apiQuery.isLoading,
      fallbackUrls: probeUrls,
    }),
    [apiQuery.data, apiQuery.isLoading, blockedApiRows, operators, probeUrls],
  );

  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <ArenaPageHeader
        title="Operators"
        titleWidthClassName="min-[1180px]:w-[11rem]"
        metrics={[
          { label: 'APIs', value: directory.endpoints.length.toString() },
          { label: 'On-chain', value: operatorCount.toString() },
          { label: 'Public', value: publicApiCount.toString() },
        ]}
        controls={(
          <>
            <ArenaHeaderLink to="/operators/register" icon="i-ph:hard-drives" variant="primary">Become an operator</ArenaHeaderLink>
            <ArenaHeaderLink to={provisionHref(selectedBlueprint)} icon="i-ph:rocket-launch">Request Instance</ArenaHeaderLink>
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

        <section className="flex flex-col gap-3 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 py-3 sm:flex-row sm:items-center">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
            <span className="i-ph:hard-drives text-lg" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Host agents on your own operator</h2>
            <p className="mt-0.5 text-sm text-[var(--arena-terminal-muted)]">
              Set who can launch agents, advertise capacity, and earn fees from the agents you host.
            </p>
          </div>
          <ArenaHeaderLink to="/operators/register" icon="i-ph:arrow-right" variant="primary">Become an operator</ArenaHeaderLink>
        </section>

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
            <Link
              to={provisionHref(selectedBlueprint)}
              className="hidden h-8 items-center border border-[#50d2c1]/35 px-2 font-display text-sm font-semibold text-[#50d2c1] hover:border-[#50d2c1]/60 hover:bg-[#50d2c1]/10 hover:text-[#c8fffb] sm:inline-flex"
            >
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
