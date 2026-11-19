import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MetaFunction } from 'react-router';
import { Link, useSearchParams } from 'react-router';
import { ConnectKitButton } from 'connectkit';
import { useAccount } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  ShieldCheck,
  Wallet,
  XCircle,
} from 'lucide-react';
import { ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { StatusBadge } from '~/components/ui/StatusBadge';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  OperatorAuthRequiredError,
  operatorFetchWithAuth,
} from '~/lib/operator/fetch';
import { OperatorRequestError } from '~/lib/operator/errors';
import {
  DESK_SCOPE_DESCRIPTIONS,
  FIXED_REDIRECT_URI,
  networkLabel,
  TRADING_DESK_ORIGIN,
  deskExitUrl,
  evaluateDeskConsent,
  fetchOperatorRoster,
  instrumentName,
  normalizeVaultAddress,
  ownedRosterBots,
  parseTradingDeskRequest,
  resolveDeskOperatorOrigin,
  type DeskPreview,
  type DeskNetwork,
  type ResolvedOperatorOrigin,
  type TradingDeskRequest,
} from '~/lib/operator/deskConsent';

export const meta: MetaFunction = () => [
  { title: 'Connect Trading desk | Tangle Trading' },
  // The consent URL carries OAuth parameters; never forward them as referrer.
  { name: 'referrer', content: 'no-referrer' },
];

export default function ConnectTradingRoute() {
  const [searchParams] = useSearchParams();
  // Request secrets (state, code_challenge) stay in memory — never rendered,
  // logged, or handed to analytics.
  const request = useMemo(() => parseTradingDeskRequest(searchParams), [searchParams]);
  return <RequestGate request={request} />;
}

function RequestGate({ request }: { request: TradingDeskRequest }) {
  const enrollment = useMemo<ResolvedOperatorOrigin | null>(() => {
    if (!request.ok) return null;
    const raw =
      request.network === 'test'
        ? import.meta.env.VITE_TRADING_DESK_OPERATOR_ORIGIN_TEST
        : import.meta.env.VITE_TRADING_DESK_OPERATOR_ORIGIN_LIVE;
    return resolveDeskOperatorOrigin(raw as string | undefined);
  }, [request]);

  if (!request.ok) return <InvalidRequestScreen problems={request.problems} />;
  if (!enrollment || enrollment.status !== 'ok') {
    return (
      <MissingEnrollmentScreen
        network={request.network}
        chainId={request.chainId}
        status={enrollment?.status ?? 'missing'}
        state={request.state}
      />
    );
  }
  return (
    <ConsentFlow
      key={`${request.network}/${request.chainId}/${request.state}`}
      network={request.network}
        chainId={request.chainId}
      state={request.state}
      codeChallenge={request.codeChallenge}
      operatorOrigin={enrollment.origin}
    />
  );
}

// ── Shared chrome ────────────────────────────────────────────────────────────

const BTN_PRIMARY =
  'arena-command-link-primary inline-flex min-h-11 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';
const BTN_SECONDARY =
  'arena-command-link-secondary inline-flex min-h-11 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98]';
const BTN_SMALL =
  'arena-command-link-secondary inline-flex min-h-11 items-center gap-1.5 rounded-[5px] border px-2.5 font-display text-xs font-semibold disabled:opacity-50';
const MUTED_TEXT = 'text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]';

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:px-4">{children}</div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <header className="border-b border-[var(--arena-terminal-border)] px-3 py-2.5">
        <h2 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{title}</h2>
        {description && <p className={`mt-0.5 ${MUTED_TEXT}`}>{description}</p>}
      </header>
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

function ProblemList({ problems }: { problems: string[] }) {
  return (
    <ul className="space-y-1.5">
      {problems.map((problem) => (
        <li key={problem} className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--arena-terminal-danger)]" aria-hidden="true" />
          <span className="text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">{problem}</span>
        </li>
      ))}
    </ul>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-[var(--arena-terminal-text-muted)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 border border-[var(--arena-terminal-danger)]/45 bg-[var(--arena-terminal-danger)]/[0.08] px-3 py-2.5 text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--arena-terminal-danger)]" aria-hidden="true" />
      {children}
    </p>
  );
}

// ── Terminal states that make no network requests at all ─────────────────────

function InvalidRequestScreen({ problems }: { problems: string[] }) {
  return (
    <Screen>
      <Section title="This connection request is invalid">
        <ProblemList problems={problems} />
        <p className={`mt-3 ${MUTED_TEXT}`}>
          Start a fresh connection from your Trading desk.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={TRADING_DESK_ORIGIN} className={BTN_PRIMARY}>
            <span className="i-ph:arrow-left" aria-hidden="true" />
            Return to Trading desk
          </a>
          <Link to="/" className={BTN_SECONDARY}>
            Back to Arena
          </Link>
        </div>
      </Section>
    </Screen>
  );
}

function MissingEnrollmentScreen({
  network,
  chainId,
  status,
  state,
}: {
  network: DeskNetwork;
  chainId: number;
  status: 'missing' | 'invalid';
  state: string;
}) {
  return (
    <Screen>
      <Section
        title={`No operator is enrolled for the ${network} network`}
        description={
          status === 'invalid'
            ? 'The operator address needs updating.'
            : 'An operator can activate this network after enrolling a compatible trading vault.'
        }
      >
        <p className="text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
          Your desk requested {networkLabel(network, chainId)}.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={deskExitUrl(state, { denied: true })} className={BTN_PRIMARY}>
            Cancel and return to Trading
          </a>
          <Link to="/" className={BTN_SECONDARY}>
            Back to Arena
          </Link>
        </div>
      </Section>
    </Screen>
  );
}

// ── Consent flow ─────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof OperatorRequestError) return err.message;
  if (err instanceof OperatorAuthRequiredError) return 'Wallet verification required.';
  return err instanceof Error ? err.message : 'Request failed.';
}

function isWalletRejection(err: unknown): boolean {
  return err instanceof Error && /reject|denied|declined|cancel/i.test(err.message);
}

function ConsentFlow({
  network,
  chainId,
  state,
  codeChallenge,
  operatorOrigin,
}: {
  network: DeskNetwork;
  chainId: number;
  state: string;
  codeChallenge: string;
  operatorOrigin: string;
}) {
  const { address, isConnected } = useAccount();
  const operatorAuth = useOperatorAuth(operatorOrigin);
  const queryClient = useQueryClient();
  const isAuthenticated = operatorAuth.isAuthenticated;

  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => () => { submission.current?.abort(); submission.current = null; }, [address, selectedBotId]);

  // A different wallet must never inherit a previous selection or result.
  useEffect(() => {
    setSelectedBotId(null);
    setAuthorizeError(null);
    setIsAuthorizing(false);
  }, [address]);

  const rosterQuery = useQuery({
    queryKey: ['trading-desk-roster', operatorOrigin, address],
    enabled: isAuthenticated && typeof address === 'string',
    staleTime: 30_000,
    retry: 1,
    queryFn: ({signal}) => fetchOperatorRoster(path => operatorFetchWithAuth(operatorOrigin, path, operatorAuth, { auth: true, refreshOnUnauthorized: false, signal })),
  });
  const ownedBots = useMemo(
    () => ownedRosterBots(rosterQuery.data ?? [], address),
    [rosterQuery.data, address],
  );
  const selectedBot = ownedBots.find((bot) => bot.id === selectedBotId) ?? null;

  // The preview is bound to the wallet, the bot and the network; a cached
  // preview for anything else never renders into the review.
  const previewKey = ['trading-desk-preview', operatorOrigin, network, chainId, address, selectedBotId];
  const previewQuery = useQuery({
    queryKey: previewKey,
    enabled: isAuthenticated && selectedBot !== null,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const path = `/api/trading-desk/authorize/preview?network=${encodeURIComponent(network)}&bot_id=${encodeURIComponent(selectedBotId as string)}`;
      const res = await operatorFetchWithAuth(operatorOrigin, path, operatorAuth, {
        auth: true,
        refreshOnUnauthorized: false,
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json() as DeskPreview;
      if (!Array.isArray(data.scopes) || !Array.isArray(data.instruments) || !Array.isArray(data.problems)) throw new Error('The operator returned incomplete trading terms.');
      return data;
    },
  });

  const preview: DeskPreview | null = previewQuery.data ?? null;
  const readiness = evaluateDeskConsent({
    network, chainId,
    address,
    bot: selectedBot,
    preview,
    nowSec: Math.floor(Date.now() / 1000),
  });
  const canAuthorize = isAuthenticated && !isAuthorizing && readiness.ok;

  async function authorizeConnection() {
    if (!selectedBotId || !preview || submission.current) return;
    // Re-run every gate at click time: an idle-open page must not submit on
    // a stale envelope or a wallet/bot change made after the render.
    const nowSec = Math.floor(Date.now() / 1000);
    const fresh = evaluateDeskConsent({ network, chainId, address, bot: selectedBot, preview, nowSec });
    if (!fresh.ok) {
      const expired =
        preview.envelope !== null &&
        typeof preview.envelope.expiresAt === 'number' &&
        preview.envelope.expiresAt <= nowSec;
      setAuthorizeError(
        expired
          ? 'The verified envelope expired while this page was open. Nothing was sent. Review the refreshed terms below before authorizing.'
          : 'The reviewed terms changed. Nothing was sent. Review the refreshed terms below before authorizing.',
      );
      if (expired) await queryClient.invalidateQueries({ queryKey: previewKey });
      return;
    }
    const controller = new AbortController();
    submission.current = controller;
    setIsAuthorizing(true);
    setAuthorizeError(null);
    try {
      const res = await operatorFetchWithAuth(
        operatorOrigin,
        '/api/trading-desk/authorize',
        operatorAuth,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            network,
            bot_id: selectedBotId,
            state,
            envelope_digest: preview.envelope?.digest,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: FIXED_REDIRECT_URI,
          }),
          auth: true,
          refreshOnUnauthorized: false,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        },
      );
      const data = (await res.json()) as { code?: unknown };
      if (typeof data.code !== 'string' || data.code.length === 0) {
        throw new Error('The operator returned no authorization code.');
      }
      if (!controller.signal.aborted) window.location.assign(deskExitUrl(state, { code: data.code }));
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof OperatorRequestError && err.status === 409) await queryClient.invalidateQueries({ queryKey: previewKey });
      setAuthorizeError(errorMessage(err));
    } finally {
      if (submission.current === controller) submission.current = null;
      setIsAuthorizing(false);
    }
  }

  const statusValue = !isConnected
    ? 'Connect wallet'
    : !isAuthenticated
      ? 'Verify wallet'
      : preview && preview.botId === selectedBotId
        ? readiness.ok
          ? 'Ready'
          : 'Blocked'
        : selectedBot
          ? 'Checking'
          : 'Choose bot';

  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <ArenaPageHeader
        title="Connect Trading desk"
        metrics={[
          { label: 'Network', value: networkLabel(network, chainId) },
          { label: 'Operator', value: operatorOrigin.replace(/^https?:\/\//, '') },
          { label: 'Status', value: statusValue },
        ]}
        controls={<a href={deskExitUrl(state, { denied: true })} className={BTN_SECONDARY}>Cancel</a>}
      >
        <p className="text-sm text-[var(--arena-terminal-muted)]">
          Choose a bot and review the swaps your Trading desk can make.
        </p>
      </ArenaPageHeader>

      <Screen>
        <Section title="Wallet">
          {!isConnected || !address ? (
            <ConnectKitButton.Custom>
              {({ show, isConnecting }) => (
                <button type="button" onClick={() => show?.()} disabled={!show || isConnecting} className={BTN_PRIMARY}>
                  <Wallet className="h-4 w-4" aria-hidden="true" />
                  {isConnecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
            </ConnectKitButton.Custom>
          ) : !isAuthenticated ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 font-data text-sm text-[var(--arena-terminal-text)]">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
                <span className="truncate">{address}</span>
              </p>
              <button
                type="button"
                onClick={() => void operatorAuth.authenticate()}
                disabled={operatorAuth.isAuthenticating}
                className={BTN_PRIMARY}
              >
                {operatorAuth.isAuthenticating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {operatorAuth.isAuthenticating ? 'Waiting for signature…' : 'Verify wallet ownership'}
              </button>
              {operatorAuth.error && (
                <Notice>
                  {isWalletRejection(operatorAuth.error)
                    ? 'Signature declined in the wallet. Nothing was sent to the operator. You can try again.'
                    : `Wallet verification failed: ${operatorAuth.error}`}
                </Notice>
              )}
              <p className={MUTED_TEXT}>
                This signs a one-time challenge with the enrolled operator only. It is not a
                transaction and costs nothing.
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-2 font-data text-sm text-[var(--arena-terminal-text)]">
              <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
              <span className="truncate">{address}</span>
              <StatusBadge status="confirmed" labelOverride="Verified" size="sm" />
            </p>
          )}
        </Section>

        {isAuthenticated && (
          <Section
            title="Your bots on this operator"
            description={`Only bots owned by your wallet for ${networkLabel(network, chainId)} are listed.`}
          >
            {rosterQuery.isLoading ? (
              <Spinner label="Loading your bots from the operator…" />
            ) : rosterQuery.isError ? (
              <div className="space-y-2">
                <ProblemList problems={[errorMessage(rosterQuery.error)]} />
                <button type="button" onClick={() => void rosterQuery.refetch()} className={BTN_SMALL}>
                  Retry
                </button>
              </div>
            ) : ownedBots.length === 0 ? (
              <p className={MUTED_TEXT}>
                No bots owned by this wallet were found on the enrolled operator. Provision a bot
                with this operator first, then start the connection from the Trading desk again.
              </p>
            ) : (
              <div className="space-y-2">
                {ownedBots.map((bot) => {
                  const active = selectedBotId === bot.id;
                  const detail = [
                    bot.id,
                    typeof bot.chain_id === 'number' ? `chain ${bot.chain_id}` : null,
                    bot.paper_trade === true ? 'paper trading' : null,
                    bot.chain_id !== chainId ? `not on the ${network} network chain` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setSelectedBotId(bot.id);
                        setAuthorizeError(null);
                      }}
                      className={`flex w-full items-start gap-2.5 border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
                        active
                          ? 'border-[var(--arena-terminal-accent)]/60 bg-[var(--arena-terminal-accent-soft)]'
                          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] hover:border-[var(--arena-terminal-border-hover)]'
                      }`}
                    >
                      <span
                        className={`mt-0.5 shrink-0 ${active ? 'text-[var(--arena-terminal-accent)]' : 'text-[var(--arena-terminal-text-muted)]'}`}
                        aria-hidden="true"
                      >
                        {active ? <CheckCircle2 className="h-4 w-4" /> : <Wallet className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                          {bot.name?.trim() ? bot.name : bot.id}
                        </span>
                        <span className="mt-0.5 block break-all font-data text-xs text-[var(--arena-terminal-text-muted)]">
                          {detail}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>
        )}

        {isAuthenticated && selectedBot && (
          <Section
            title="What the desk is allowed to do"
            description="Boundaries come from the operator's signed envelope for this bot. Anything uncertain refuses closed and nothing is submitted."
          >
            {previewQuery.isLoading ? (
              <Spinner label="Checking this bot with the operator…" />
            ) : previewQuery.isError ? (
              <div className="space-y-2">
                <ProblemList
                  problems={[
                    previewQuery.error instanceof OperatorAuthRequiredError
                      ? 'Your operator session expired. Verify the wallet again to continue.'
                      : errorMessage(previewQuery.error),
                  ]}
                />
                {previewQuery.error instanceof OperatorAuthRequiredError && (
                  <button type="button" onClick={() => void operatorAuth.authenticate()} className={BTN_SMALL}>
                    Verify again
                  </button>
                )}
              </div>
            ) : preview && preview.botId === selectedBot.id ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <StatusBadge
                    status={readiness.ok ? 'confirmed' : 'error'}
                    labelOverride={readiness.ok ? 'Eligible' : 'Not eligible'}
                    size="sm"
                  />
                  <span className="font-data text-xs uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                    {preview.network} · chain {preview.chainId}
                  </span>
                </div>

                {!readiness.ok && <ProblemList problems={readiness.problems} />}
                {preview.envelope && <EnvelopeTerms preview={preview} address={address} />}

                <div>
                  <h3 className="font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                    Desk permissions
                  </h3>
                  <ul className="mt-1.5 space-y-1">
                    {preview.scopes.map((scope) => (
                      <li
                        key={scope}
                        className="flex items-start gap-2 text-xs text-[var(--arena-terminal-text-secondary)]"
                      >
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
                        <span>
                          {DESK_SCOPE_DESCRIPTIONS[scope] ?? scope}

                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                {authorizeError && <Notice>{authorizeError}</Notice>}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void authorizeConnection()}
                    disabled={!canAuthorize}
                    className={BTN_PRIMARY}
                  >
                    {isAuthorizing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    {isAuthorizing ? 'Authorizing…' : 'Authorize connection'}
                  </button>
                  <a href={deskExitUrl(state, { denied: true })} className={BTN_SECONDARY}>
                    Deny and return to Trading
                  </a>
                </div>
                <p className={MUTED_TEXT}>
                  Pause new orders in your Trading desk. You can revoke this connection in Arena.
                </p>
              </div>
            ) : null}
          </Section>
        )}
      </Screen>
    </div>
  );
}

/** The verified-envelope terms rendered before the explicit approve press. */
function EnvelopeTerms({ preview, address }: { preview: DeskPreview; address: string | undefined }) {
  const envelope = preview.envelope;
  if (!envelope) return null;
  const signatureCount = envelope.signatures ?? 0;
  const terms: Array<[string, ReactNode]> = [
    ['Your account', address],
    [
      'Vault',
      normalizeVaultAddress(envelope.vaultAddress) ?? 'No nonzero vault address in the verified envelope.',
    ],
    [
      'Allowed operation',
      `Spot swaps on ${preview.instruments.map(instrumentName).join(', ')} through ${envelope.protocol === 'uniswap_v3' ? 'Uniswap v3' : envelope.protocol}`,
    ],
    [
      'Trading limits',
      `$${envelope.maxTradeSizeUsd} per trade · $${envelope.maxTotalExposureUsd} total exposure`,
    ],
    ...(envelope.swap ? [
      ['Swap', `${envelope.swap.input} → ${envelope.swap.output}`],
      ['Input limit', `${envelope.swap.maxInputPerSwap} ${envelope.swap.input} per swap · ${envelope.swap.maxInputTotal} ${envelope.swap.input} over this envelope`],
    ] as [string, ReactNode][] : []),
    ['Signatures', `${signatureCount} verified`],
    ['Expiry', `Envelope expires ${new Date(envelope.expiresAt * 1000).toLocaleString()}`],
  ];
  return (
    <dl className="space-y-1.5 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2.5">
      {terms.map(([label, value]) => (
        <div key={label} className="grid gap-x-3 sm:grid-cols-[11rem_1fr]">
          <dt className="font-display text-xs font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
            {label}
          </dt>
          <dd className="min-w-0 text-sm leading-relaxed text-[var(--arena-terminal-text)] [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
