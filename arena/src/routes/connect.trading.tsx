import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MetaFunction } from 'react-router';
import { Link, useSearchParams } from 'react-router';
import { ConnectKitButton } from 'connectkit';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  ShieldCheck,
  Wallet,
  XCircle,
} from 'lucide-react';
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader';
import { StatusBadge } from '~/components/ui/StatusBadge';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  OperatorAuthRequiredError,
  operatorFetchWithAuth,
} from '~/lib/operator/fetch';
import { OperatorRequestError } from '~/lib/operator/errors';

// ── Wire contract (see trading-http-api/src/trading_desk/consent.rs) ─────────

const CLIENT_ID = 'tangle-trading';
/** The only callback this route ever navigates to — never caller-supplied. */
const FIXED_REDIRECT_URI =
  'https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback';
/** The desk application origin, used for the "return to desk" action only. */
const TRADING_DESK_ORIGIN = 'https://trading.tangle.tools';

export type DeskNetwork = 'test' | 'live';

const NETWORK_CHAIN_ID: Record<DeskNetwork, number> = { test: 998, live: 999 };
const NETWORK_LABEL: Record<DeskNetwork, string> = {
  test: 'Testnet (HyperEVM 998)',
  live: 'Live (HyperEVM 999)',
};

export type TradingDeskRequest =
  | { ok: true; network: DeskNetwork; state: string; codeChallenge: string }
  | { ok: false; problems: string[] };

/**
 * Validate the OAuth request exactly. The caller controls none of these
 * values' destinations: a valid flow only ever navigates to the fixed
 * callback above, and a valid cancellation only adds `error=access_denied`
 * plus the original (validated) state.
 */
export function parseTradingDeskRequest(params: URLSearchParams): TradingDeskRequest {
  const problems: string[] = [];

  if (params.get('response_type') !== 'code') {
    problems.push('response_type must be "code".');
  }
  if (params.get('client_id') !== CLIENT_ID) {
    problems.push('client_id is not recognized for a trading desk connection.');
  }
  const network = params.get('network');
  if (network !== 'test' && network !== 'live') {
    problems.push('network must be "test" or "live".');
  }
  const state = params.get('state');
  if (!state || state.length > 1024) {
    problems.push('state is missing or too long.');
  }
  const codeChallenge = params.get('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    problems.push('code_challenge must be a 43-character base64url string.');
  }
  // The desk callback is fixed. A mismatched value is an invalid request, not
  // a redirect target — it is never navigated to.
  const redirectUri = params.get('redirect_uri');
  if (redirectUri !== null && redirectUri !== FIXED_REDIRECT_URI) {
    problems.push('redirect_uri does not match the fixed Trading callback.');
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    network: network as DeskNetwork,
    state: state as string,
    codeChallenge: codeChallenge as string,
  };
}

export type ResolvedOperatorOrigin =
  | { status: 'ok'; origin: string }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Enrolled operator origin, validated with the same restrictions as Trading's
 * src/trading/live/tangle-vault.ts: an exact https origin (http allowed only
 * on loopback hosts for local operator QA), with no userinfo, path, query or
 * fragment. The origin comes only from the per-network build-time enrollment
 * variable — never from URL state, on-chain discovery, or caller input.
 */
export function resolveDeskOperatorOrigin(raw: string | undefined): ResolvedOperatorOrigin {
  const trimmed = raw?.trim();
  if (!trimmed) return { status: 'missing' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { status: 'invalid' };
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  const exactOrigin =
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
    !url.username &&
    !url.password &&
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash;
  if (!exactOrigin) return { status: 'invalid' };
  return { status: 'ok', origin: url.origin };
}

/** The only two successful-exit URLs this route ever produces. */
function deskSuccessUrl(code: string, state: string): string {
  const url = new URL(FIXED_REDIRECT_URI);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}

function deskDeniedUrl(state: string): string {
  const url = new URL(FIXED_REDIRECT_URI);
  url.searchParams.set('error', 'access_denied');
  url.searchParams.set('state', state);
  return url.toString();
}

function errorMessage(err: unknown): string {
  if (err instanceof OperatorRequestError) return err.message;
  if (err instanceof OperatorAuthRequiredError) return 'Wallet verification required.';
  return err instanceof Error ? err.message : 'Request failed.';
}

export const meta: MetaFunction = () => [
  { title: 'Connect Trading desk | Tangle Trading' },
  {
    name: 'description',
    content:
      'Review and explicitly approve a wallet-scoped Trading desk connection for one of your bots.',
  },
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

  if (!request.ok) {
    return <InvalidRequestScreen problems={request.problems} />;
  }
  if (!enrollment || enrollment.status !== 'ok') {
    return (
      <MissingEnrollmentScreen
        network={request.network}
        status={enrollment?.status ?? 'missing'}
        state={request.state}
      />
    );
  }
  return (
    <ConsentFlow
      key={request.network}
      network={request.network}
      state={request.state}
      codeChallenge={request.codeChallenge}
      operatorOrigin={enrollment.origin}
    />
  );
}

// ── Shared chrome ────────────────────────────────────────────────────────────

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:px-4">{children}</div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <header className="border-b border-[var(--arena-terminal-border)] px-3 py-2.5">
        <h2 className="font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]">{description}</p>
        )}
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

// ── Terminal states that make no network requests at all ─────────────────────

function InvalidRequestScreen({ problems }: { problems: string[] }) {
  return (
    <Screen>
      <Section title="This connection request is invalid">
        <ProblemList problems={problems} />
        <p className="mt-3 text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]">
          No wallet signature was requested and nothing was sent anywhere. Return to the Trading
          desk and start the connection again.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={TRADING_DESK_ORIGIN}
            className="arena-command-link-primary inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98]"
          >
            <span className="i-ph:arrow-left" aria-hidden="true" />
            Return to Trading desk
          </a>
          <Link
            to="/"
            className="arena-command-link-secondary inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98]"
          >
            Back to Arena
          </Link>
        </div>
      </Section>
    </Screen>
  );
}

function MissingEnrollmentScreen({
  network,
  status,
  state,
}: {
  network: DeskNetwork;
  status: 'missing' | 'invalid';
  state: string;
}) {
  return (
    <Screen>
      <Section
        title={`No operator is enrolled for the ${network} network`}
        description={
          status === 'invalid'
            ? 'The operator enrollment configured for this network is not a valid exact https origin, so this deployment refuses to act on it.'
            : 'This Arena deployment has no authorized operator enrolled for this network yet.'
        }
      >
        <p className="text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
          Approving a Trading desk connection requires an enrolled operator for the {NETWORK_LABEL[network]}{' '}
          network. Until an operator enrollment is configured, no wallet sign-in is requested and no
          connection can be approved here. This page did not contact any operator.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={deskDeniedUrl(state)}
            className="arena-command-link-primary inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98]"
          >
            Cancel and return to Trading
          </a>
          <Link
            to="/"
            className="arena-command-link-secondary inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98]"
          >
            Back to Arena
          </Link>
        </div>
      </Section>
    </Screen>
  );
}

// ── Consent flow ─────────────────────────────────────────────────────────────

interface RosterBot {
  id: string;
  name?: string;
  submitter_address?: string;
  vault_address?: string;
  chain_id?: number;
  paper_trade?: boolean;
  trading_active?: boolean;
  service_id?: number;
}

interface DeskEnvelope {
  protocol: string;
  expiresAt: number;
  maxTradeSizeUsd: string;
  maxTotalExposureUsd: string;
  signatures: number;
  deploymentConfirmed: boolean;
}

interface DeskPreview {
  botId: string;
  network: string;
  chainId: number;
  eligible: boolean;
  problems: string[];
  envelope: DeskEnvelope | null;
  instruments: Array<string | { instrument?: string; base?: string; quote?: string }>;
  scopes: string[];
  quoteCurrency: string;
}

const ADDRESS_RE = /^(0x)?[0-9a-fA-F]{40}$/;

function isWalletRejection(err: unknown): boolean {
  return err instanceof Error && /reject|denied|declined|cancel/i.test(err.message);
}

function instrumentName(entry: DeskPreview['instruments'][number]): string {
  if (typeof entry === 'string') return entry;
  return entry.instrument ?? [entry.base, entry.quote].filter(Boolean).join('-') ?? 'Unknown';
}

function ConsentFlow({
  network,
  state,
  codeChallenge,
  operatorOrigin,
}: {
  network: DeskNetwork;
  state: string;
  codeChallenge: string;
  operatorOrigin: string;
}) {
  const { address, isConnected } = useAccount();
  const operatorAuth = useOperatorAuth(operatorOrigin);
  const isAuthenticated = operatorAuth.isAuthenticated;

  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);

  // A different wallet must never inherit a previous selection or result.
  useEffect(() => {
    setSelectedBotId(null);
    setAuthorizeError(null);
    setIsAuthorizing(false);
  }, [address]);

  const rosterQuery = useQuery({
    queryKey: ['trading-desk-roster', operatorOrigin],
    enabled: isAuthenticated,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(`${operatorOrigin}/api/bots?limit=200`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Operator bot list failed (HTTP ${res.status}).`);
      return (await res.json()) as { bots?: RosterBot[] };
    },
  });

  const ownedBots = useMemo(
    () =>
      (rosterQuery.data?.bots ?? []).filter(
        (bot) =>
          typeof bot.id === 'string' &&
          typeof bot.submitter_address === 'string' &&
          typeof address === 'string' &&
          bot.submitter_address.toLowerCase() === address.toLowerCase(),
      ),
    [rosterQuery.data, address],
  );

  const selectedBot = ownedBots.find((bot) => bot.id === selectedBotId) ?? null;

  const previewQuery = useQuery({
    queryKey: ['trading-desk-preview', operatorOrigin, network, selectedBotId],
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
      return (await res.json()) as DeskPreview;
    },
  });

  const preview: DeskPreview | null = previewQuery.data ?? null;
  const previewMatchesSelection =
    preview !== null &&
    preview.botId === selectedBotId &&
    preview.network === network &&
    preview.chainId === NETWORK_CHAIN_ID[network];

  // Fail closed: custody (a vault on record) and chain/network must be certain.
  const custodyCertain =
    typeof selectedBot?.vault_address === 'string' && ADDRESS_RE.test(selectedBot.vault_address);
  const chainMatches = selectedBot?.chain_id === NETWORK_CHAIN_ID[network];
  const canAuthorize =
    isAuthenticated &&
    !isAuthorizing &&
    previewMatchesSelection &&
    preview.eligible &&
    custodyCertain &&
    chainMatches === true;

  function selectBot(botId: string) {
    setSelectedBotId(botId);
    setAuthorizeError(null);
  }

  async function authorizeConnection() {
    if (!canAuthorize || !selectedBotId) return;
    setIsAuthorizing(true);
    setAuthorizeError(null);
    try {
      const res = await operatorFetchWithAuth(operatorOrigin, '/api/trading-desk/authorize', operatorAuth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          network,
          bot_id: selectedBotId,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: FIXED_REDIRECT_URI,
        }),
        auth: true,
        refreshOnUnauthorized: false,
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json()) as { code?: unknown };
      if (typeof data.code !== 'string' || data.code.length === 0) {
        throw new Error('The operator returned no authorization code.');
      }
      window.location.assign(deskSuccessUrl(data.code, state));
    } catch (err) {
      setAuthorizeError(errorMessage(err));
      setIsAuthorizing(false);
    }
  }

  const statusValue = !isConnected
    ? 'Connect wallet'
    : !isAuthenticated
      ? 'Verify wallet'
      : previewMatchesSelection
        ? preview.eligible
          ? 'Ready'
          : 'Not eligible'
        : selectedBot
          ? 'Checking'
          : 'Choose bot';

  return (
    <div className="min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
      <ArenaPageHeader
        title="Connect Trading desk"
        metrics={[
          { label: 'Network', value: NETWORK_LABEL[network] },
          { label: 'Operator', value: operatorOrigin.replace(/^https:\/\//, '') },
          { label: 'Status', value: statusValue },
        ]}
        controls={
          <ArenaHeaderLink to="/" icon="i-ph:x-circle" variant="secondary">
            Cancel
          </ArenaHeaderLink>
        }
      >
        <p className="truncate text-sm text-[var(--arena-terminal-muted)]">
          The Trading desk is asking to place bounded spot swaps through one bot you own. Review
          exactly what is granted before you authorize.
        </p>
      </ArenaPageHeader>

      <Screen>
        <Section
          title="1. Wallet"
          description="The connected wallet must be the one that owns the bot. Ownership is re-verified by the operator before anything is granted."
        >
          {!isConnected || !address ? (
            <ConnectKitButton.Custom>
              {({ show, isConnecting }) => (
                <button
                  type="button"
                  onClick={() => show?.()}
                  disabled={!show || isConnecting}
                  className="arena-command-link-primary inline-flex h-9 items-center justify-center gap-2 rounded-[5px] border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Wallet className="h-4 w-4" aria-hidden="true" />
                  {isConnecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
            </ConnectKitButton.Custom>
          ) : !isAuthenticated ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 font-data text-sm text-[var(--arena-terminal-text)]">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
                <span className="truncate">{address}</span>
              </div>
              <button
                type="button"
                onClick={() => void operatorAuth.authenticate()}
                disabled={operatorAuth.isAuthenticating}
                className="arena-command-link-primary inline-flex h-9 items-center justify-center gap-2 rounded-[5px] border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {operatorAuth.isAuthenticating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {operatorAuth.isAuthenticating ? 'Waiting for signature…' : 'Verify wallet ownership'}
              </button>
              {operatorAuth.error && (
                <div className="border border-[var(--arena-terminal-danger)]/45 bg-[var(--arena-terminal-danger)]/[0.08] px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--arena-terminal-danger)]" aria-hidden="true" />
                    <p className="text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
                      {isWalletRejection(operatorAuth.error)
                        ? 'Signature declined in the wallet. Nothing was sent to the operator. You can try again.'
                        : `Wallet verification failed: ${operatorAuth.error}`}
                    </p>
                  </div>
                </div>
              )}
              <p className="text-xs text-[var(--arena-terminal-text-muted)]">
                This signs a one-time challenge with the enrolled operator only. It is not a
                transaction and costs nothing.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 font-data text-sm text-[var(--arena-terminal-text)]">
              <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--arena-terminal-success)]" aria-hidden="true" />
              <span className="truncate">{address}</span>
              <StatusBadge status="confirmed" labelOverride="Verified" size="sm" />
            </div>
          )}
        </Section>

        {isAuthenticated && (
          <Section
            title="2. Choose a bot you own"
            description={`Only bots owned by your wallet on the enrolled operator for ${NETWORK_LABEL[network]} are listed.`}
          >
            {rosterQuery.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-[var(--arena-terminal-text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Loading your bots from the operator…
              </p>
            ) : rosterQuery.isError ? (
              <div className="space-y-2">
                <ProblemList problems={[errorMessage(rosterQuery.error)]} />
                <button
                  type="button"
                  onClick={() => void rosterQuery.refetch()}
                  className="arena-command-link-secondary inline-flex h-8 items-center gap-1.5 rounded-[5px] border px-2.5 font-display text-xs font-semibold disabled:opacity-50"
                >
                  Retry
                </button>
              </div>
            ) : ownedBots.length === 0 ? (
              <p className="text-xs leading-relaxed text-[var(--arena-terminal-text-muted)]">
                No bots owned by this wallet were found on the enrolled operator. Provision a bot
                with this operator first, then start the connection from the Trading desk again.
              </p>
            ) : (
              <div className="space-y-2">
                {ownedBots.map((bot) => {
                  const active = selectedBotId === bot.id;
                  const chainMismatch = bot.chain_id !== NETWORK_CHAIN_ID[network];
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => selectBot(bot.id)}
                      className={[
                        'flex w-full items-start gap-2.5 border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]',
                        active
                          ? 'border-[var(--arena-terminal-accent)]/60 bg-[var(--arena-terminal-accent-soft)]'
                          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] hover:border-[var(--arena-terminal-border-hover)]',
                      ].join(' ')}
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
                        <span className="mt-0.5 block break-all font-data text-[11px] text-[var(--arena-terminal-text-muted)]">
                          {bot.id}
                          {typeof bot.chain_id === 'number' && ` · chain ${bot.chain_id}`}
                          {bot.paper_trade === true && ' · paper trading'}
                          {chainMismatch && ` · not on the ${network} network chain`}
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
            title="3. Review what the desk is allowed to do"
            description="Boundaries come from the operator's verified envelope for this bot. Anything uncertain refuses closed."
          >
            {previewQuery.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-[var(--arena-terminal-text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Checking this bot with the operator…
              </p>
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
                  <button
                    type="button"
                    onClick={() => void operatorAuth.authenticate()}
                    className="arena-command-link-secondary inline-flex h-8 items-center gap-1.5 rounded-[5px] border px-2.5 font-display text-xs font-semibold"
                  >
                    Verify again
                  </button>
                )}
              </div>
            ) : preview && previewMatchesSelection ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <StatusBadge
                    status={preview.eligible ? 'confirmed' : 'error'}
                    labelOverride={preview.eligible ? 'Eligible' : 'Not eligible'}
                    size="sm"
                  />
                  <span className="font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                    {preview.network} · chain {preview.chainId}
                  </span>
                </div>

                {!preview.eligible && <ProblemList problems={preview.problems} />}

                <dl className="space-y-2 border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 py-2.5">
                  <div>
                    <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      Your account
                    </dt>
                    <dd className="break-all font-data text-xs text-[var(--arena-terminal-text)]">{address}</dd>
                  </div>
                  <div>
                    <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      Bot vault
                    </dt>
                    <dd className="break-all font-data text-xs text-[var(--arena-terminal-text)]">
                      {custodyCertain ? selectedBot.vault_address : 'No vault on record — cannot verify custody.'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      Allowed operation
                    </dt>
                    <dd className="text-xs text-[var(--arena-terminal-text-secondary)]">
                      Atomic spot swaps on {preview.instruments.map(instrumentName).join(', ') || 'no instruments'}{' '}
                      quoted in {preview.quoteCurrency}
                      {preview.envelope ? ` via ${preview.envelope.protocol}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      Bounds
                    </dt>
                    <dd className="text-xs text-[var(--arena-terminal-text-secondary)]">
                      {preview.envelope
                        ? `Max trade size $${preview.envelope.maxTradeSizeUsd} · max total exposure $${preview.envelope.maxTotalExposureUsd}`
                        : 'No verified envelope — no bounds available.'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      Expiry
                    </dt>
                    <dd className="text-xs text-[var(--arena-terminal-text-secondary)]">
                      {preview.envelope
                        ? `Envelope expires ${new Date(preview.envelope.expiresAt * 1000).toLocaleString()}`
                        : 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
                      Desk scopes
                    </dt>
                    <dd className="font-data text-xs text-[var(--arena-terminal-text-secondary)]">
                      {preview.scopes.join(' · ')}
                    </dd>
                  </div>
                </dl>

                {!custodyCertain && (
                  <ProblemList problems={['This bot has no verifiable vault on record, so approval is blocked.']} />
                )}
                {custodyCertain && chainMatches !== true && (
                  <ProblemList
                    problems={[
                      `This bot is on chain ${selectedBot.chain_id ?? 'unknown'}, but the ${network} network is chain ${NETWORK_CHAIN_ID[network]}. Approval is blocked.`,
                    ]}
                  />
                )}

                {authorizeError && (
                  <div className="border border-[var(--arena-terminal-danger)]/45 bg-[var(--arena-terminal-danger)]/[0.08] px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--arena-terminal-danger)]" aria-hidden="true" />
                      <p className="text-xs leading-relaxed text-[var(--arena-terminal-text-secondary)]">
                        The operator refused the connection: {authorizeError}
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void authorizeConnection()}
                    disabled={!canAuthorize}
                    className="arena-command-link-primary inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isAuthorizing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    {isAuthorizing ? 'Authorizing…' : 'Authorize connection'}
                  </button>
                  <a
                    href={deskDeniedUrl(state)}
                    className="arena-command-link-secondary inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 font-display text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98]"
                  >
                    Deny and return to Trading
                  </a>
                </div>
                <p className="text-xs text-[var(--arena-terminal-text-muted)]">
                  Authorizing returns you to Trading with a single-use code. The desk can then read
                  the account, submit and read spot-swap orders, and revoke this connection — only
                  for the bot vault above, and only until it expires. You can revoke it from your
                  bot's connections at any time.
                </p>
              </div>
            ) : null}
          </Section>
        )}
      </Screen>
    </div>
  );
}
