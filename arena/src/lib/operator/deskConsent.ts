// Wire logic for the Arena Trading-desk consent route (/connect/trading).
// Contracts read from the peer implementations:
//   - Operator preview/authorize/token: trading-http-api/src/trading_desk/{consent,mod}.rs
//     at a1b214f (signed preview returns envelope.vaultAddress, expiresAt,
//     signatures, deploymentConfirmed plus the published bounds/protocol).
//   - Operator roster: trading-blueprint-bin/src/operator_api.rs (BotSummary,
//     limit<=200, limit/offset pagination).
//   - Desk generator + origin rules: qualification-integrated
//     src/trading/live/oauth.ts and src/trading/live/tangle-vault.ts.

const CLIENT_ID = 'tangle-trading';

/** The only callback this route ever navigates to — never caller-supplied. */
export const FIXED_REDIRECT_URI =
  'https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback';
/** The desk application origin, used for the "return to desk" action only. */
export const TRADING_DESK_ORIGIN = 'https://trading.tangle.tools';

export type DeskNetwork = 'test' | 'live';

export const NETWORK_CHAIN_ID: Record<DeskNetwork, number> = { test: 998, live: 999 };
export const NETWORK_LABEL: Record<DeskNetwork, string> = {
  test: 'Testnet (HyperEVM 998)',
  live: 'Live (HyperEVM 999)',
};

/** The desk mints single-use codes scoped to these permissions. */
export const DESK_SCOPE_DESCRIPTIONS: Record<string, string> = {
  'account:read': 'Read the bot vault account balance and positions',
  'orders:submit': 'Submit atomic spot-swap orders within the verified bounds',
  'orders:read': 'Read order status and fill history',
  'connection:revoke': 'Revoke this connection at any time',
};

export type TradingDeskRequest =
  | { ok: true; network: DeskNetwork; state: string; codeChallenge: string }
  | { ok: false; problems: string[] };

/**
 * Validate the OAuth request exactly as the desk's generator issues it
 * (response_type=code, client_id=tangle-trading, S256 challenge, fixed
 * callback). The caller controls none of these values' destinations: a valid
 * flow only ever navigates to the fixed callback, and a valid cancellation
 * only adds `error=access_denied` plus the original (validated) state.
 */
export function parseTradingDeskRequest(params: URLSearchParams): TradingDeskRequest {
  const problems: string[] = [];
  if (params.get('response_type') !== 'code') problems.push('response_type must be "code".');
  if (params.get('client_id') !== CLIENT_ID)
    problems.push('client_id is not recognized for a trading desk connection.');
  const network = params.get('network');
  if (network !== 'test' && network !== 'live') problems.push('network must be "test" or "live".');
  const state = params.get('state');
  if (!state || state.length > 1024) problems.push('state is missing or too long.');
  const codeChallenge = params.get('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
    problems.push('code_challenge must be a 43-character base64url string.');
  // The desk callback is fixed. A mismatched value is an invalid request, not
  // a redirect target — it is never navigated to.
  const redirectUri = params.get('redirect_uri');
  if (redirectUri !== null && redirectUri !== FIXED_REDIRECT_URI)
    problems.push('redirect_uri does not match the fixed Trading callback.');
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

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
  const exactOrigin =
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) &&
    !url.username &&
    !url.password &&
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash;
  if (!exactOrigin) return { status: 'invalid' };
  return { status: 'ok', origin: url.origin };
}

/** The only exit URLs this route ever produces, on the fixed callback only. */
export function deskExitUrl(state: string, result: { code: string } | { denied: true }): string {
  const url = new URL(FIXED_REDIRECT_URI);
  if ('code' in result) url.searchParams.set('code', result.code);
  else url.searchParams.set('error', 'access_denied');
  url.searchParams.set('state', state);
  return url.toString();
}

// ── Operator roster (BotSummary wire, trading-blueprint-bin operator_api) ────

export interface RosterBot {
  id: string;
  name?: string;
  submitter_address?: string;
  vault_address?: string;
  chain_id?: number;
  paper_trade?: boolean;
}

interface BotListResponse {
  bots?: RosterBot[];
  total?: number;
}

const ROSTER_PAGE_LIMIT = 200;
const ROSTER_HARD_CAP = 1_000;

/** Bots owned by the connected wallet on the enrolled operator. */
export function ownedRosterBots(bots: RosterBot[], address: string | undefined): RosterBot[] {
  const owner = address?.toLowerCase();
  if (!owner) return [];
  return bots.filter(
    (bot) => typeof bot.id === 'string' && bot.submitter_address?.toLowerCase() === owner,
  );
}

export async function fetchOperatorRoster(origin: string): Promise<RosterBot[]> {
  const collected: RosterBot[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${origin}/api/bots?limit=${ROSTER_PAGE_LIMIT}&offset=${offset}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Operator bot list failed (HTTP ${res.status}).`);
    const page = (await res.json()) as BotListResponse;
    const batch = Array.isArray(page.bots) ? page.bots : [];
    collected.push(...batch);
    // `total` is the filtered page total on this operator, so the short-page
    // signal is the reliable end-of-roster marker.
    if (
      batch.length < ROSTER_PAGE_LIMIT ||
      collected.length >= (page.total ?? collected.length) ||
      collected.length >= ROSTER_HARD_CAP
    ) {
      return collected;
    }
    offset = collected.length;
  }
}

// ── Signed eligibility preview (trading_desk consent wire) ───────────────────

export interface DeskEnvelope {
  vaultAddress: string;
  protocol: string;
  expiresAt: number;
  maxTradeSizeUsd: string;
  maxTotalExposureUsd: string;
  signatures: number;
  deploymentConfirmed: boolean;
}

export interface DeskPreview {
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

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/**
 * Normalize an EVM vault address for a lossless custody comparison: the full
 * 20-byte hex form, case-folded. Anything truncated, non-hex or the zero
 * address is unusable as a vault and fails closed.
 */
export function normalizeVaultAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!ADDRESS_RE.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  return lower === ZERO_ADDRESS ? null : lower;
}

export function instrumentName(entry: DeskPreview['instruments'][number]): string {
  if (typeof entry === 'string') return entry;
  return entry.instrument ?? [entry.base, entry.quote].filter(Boolean).join('-') ?? 'Unknown';
}

export type ConsentReadiness = { ok: true } | { ok: false; problems: string[] };

/**
 * Every check that gates the Authorize press, mirroring the operator-side
 * eligibility check in trading-http-api/src/trading_desk/mod.rs: the preview
 * must be fresh and bound to this wallet, bot and network; the bot must be
 * eligible; and the signed envelope must carry a nonzero vault address that
 * losslessly matches the bot's vault on record, a confirmed deployment, a
 * met signer quorum, and a future expiry. `nowSec` is evaluated again at
 * click time so an idle-open page can never submit on a stale envelope.
 */
export function evaluateDeskConsent(input: {
  network: DeskNetwork;
  address: string | undefined;
  bot: RosterBot | null;
  preview: DeskPreview | null;
  nowSec: number;
}): ConsentReadiness {
  const { network, address, bot, preview, nowSec } = input;
  const problems: string[] = [];
  if (!bot || typeof bot.id !== 'string') {
    return { ok: false, problems: ['Choose one of your bots to review.'] };
  }
  if (!address || bot.submitter_address?.toLowerCase() !== address.toLowerCase()) {
    problems.push('The connected wallet does not own this bot on the enrolled operator.');
  }
  if (network === 'live' && bot.paper_trade === true) {
    problems.push('Paper-trading bots cannot be connected on the live network.');
  }
  if (!preview || preview.botId !== bot.id || preview.network !== network) {
    return { ok: false, problems: [...problems, 'The operator preview does not match the selected bot and network.'] };
  }
  if (preview.chainId !== NETWORK_CHAIN_ID[network]) {
    problems.push(
      `The operator preview is for chain ${preview.chainId}, but the ${network} network is chain ${NETWORK_CHAIN_ID[network]}.`,
    );
  }
  if (!preview.eligible) {
    problems.push(...(preview.problems.length > 0 ? preview.problems : ['This bot is not eligible for a desk connection.']));
  }
  const envelope = preview.envelope;
  const rosterVault = normalizeVaultAddress(bot.vault_address);
  if (!rosterVault) {
    problems.push('This bot has no verifiable vault on record, so custody cannot be confirmed.');
  }
  if (!envelope) {
    problems.push('The operator returned no verified envelope for this bot.');
  } else {
    const envelopeVault = normalizeVaultAddress(envelope.vaultAddress);
    if (!envelopeVault) problems.push('The verified envelope carries no nonzero vault address.');
    else if (rosterVault && envelopeVault !== rosterVault)
      problems.push('The verified envelope vault does not match the vault on record for this bot.');
    if (envelope.deploymentConfirmed !== true)
      problems.push('The bot service deployment is not confirmed on the operator.');
    if (typeof envelope.signatures !== 'number' || envelope.signatures < 1)
      problems.push('The envelope has no verified operator signatures.');
    if (typeof envelope.expiresAt !== 'number' || envelope.expiresAt <= nowSec)
      problems.push('The verified envelope has expired. Review the refreshed terms before authorizing.');
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
