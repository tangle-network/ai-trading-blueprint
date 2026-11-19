import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

import ConnectTradingRoute from '../connect.trading';
import {
  evaluateDeskConsent,
  normalizeVaultAddress,
  ownedRosterBots,
  parseTradingDeskRequest,
  resolveDeskOperatorOrigin,
  type DeskPreview,
  type RosterBot,
} from '~/lib/operator/deskConsent';

let mockSearchParams = new URLSearchParams();

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
      <a href={to} {...props}>{children}</a>
    ),
    useSearchParams: () => [mockSearchParams, vi.fn()],
  };
});

vi.mock('connectkit', () => ({
  ConnectKitButton: { Custom: () => null },
}));

const mockAccount = vi.hoisted(() => ({
  address: undefined as string | undefined,
  isConnected: false,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mockAccount.address, isConnected: mockAccount.isConnected }),
}));

const mockAuth = vi.hoisted(() => ({
  isAuthenticated: false,
  isAuthenticating: false,
  error: null as string | null,
  authenticate: vi.fn(),
  getCachedToken: () => (mockAuth.isAuthenticated ? 'fixture-session-token' : null),
  getToken: vi.fn(),
}));

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => mockAuth,
}));

const VALID_PARAMS = new URLSearchParams({
  response_type: 'code',
  client_id: 'tangle-trading',
  network: 'test',
  state: 'opaque-state',
  code_challenge: 'a'.repeat(43),
});

// Mirrors the desk generator exactly: qualification-integrated
// src/trading/live/oauth.ts authorization() (base64url of 32 random bytes as
// the verifier, base64url(SHA-256(verifier)) as the challenge) plus
// @tangle-network/agent-integrations buildOAuthAuthorizationUrl
// (response_type=code, code_challenge_method=S256 when a challenge is set).
// Node's webcrypto is used directly so the assertion runs under jsdom too.

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function realDeskAuthorizeUrl(): Promise<URL> {
  const verifier = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const url = new URL('https://arena.tangle.tools/connect/trading');
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: 'tangle-trading',
    redirect_uri: 'https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback',
    state: base64url(webcrypto.getRandomValues(new Uint8Array(32))),
    code_challenge: challenge,
    network: 'test',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

describe('parseTradingDeskRequest', () => {
  it('accepts a valid request with only the fixed-callback contract', () => {
    const request = parseTradingDeskRequest(VALID_PARAMS);
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.network).toBe('test');
      expect(request.state).toBe('opaque-state');
      expect(request.codeChallenge).toBe('a'.repeat(43));
    }
  });

  it('accepts a request built by the real Trading PKCE S256 generator', async () => {
    const url = await realDeskAuthorizeUrl();
    const request = parseTradingDeskRequest(url.searchParams);
    expect(request.ok).toBe(true);
  });

  it('accepts a redirect_uri only when it is exactly the fixed callback', () => {
    const withFixed = new URLSearchParams(VALID_PARAMS);
    withFixed.set('redirect_uri', 'https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback');
    expect(parseTradingDeskRequest(withFixed).ok).toBe(true);

    const withOther = new URLSearchParams(VALID_PARAMS);
    withOther.set('redirect_uri', 'https://evil.example/callback');
    const request = parseTradingDeskRequest(withOther);
    expect(request.ok).toBe(false);
    if (!request.ok) expect(request.problems.join(' ')).toMatch(/redirect_uri/);
  });

  it('rejects each missing or malformed input', () => {
    const cases: Array<[string, string]> = [
      ['response_type', 'token'],
      ['client_id', 'someone-else'],
      ['network', 'mainnet'],
      ['state', ''],
      ['code_challenge', 'short'],
      ['code_challenge', 'a'.repeat(43).replace(/a/, '!')],
    ];
    for (const [key, value] of cases) {
      const params = new URLSearchParams(VALID_PARAMS);
      params.set(key, value);
      expect(parseTradingDeskRequest(params).ok).toBe(false);
    }
    expect(parseTradingDeskRequest(new URLSearchParams()).ok).toBe(false);
  });
});

describe('resolveDeskOperatorOrigin', () => {
  it('accepts an exact https origin and rejects paths, credentials, query and hash', () => {
    expect(resolveDeskOperatorOrigin('https://operator.example.com')).toEqual({
      status: 'ok',
      origin: 'https://operator.example.com',
    });
    expect(resolveDeskOperatorOrigin('https://operator.example.com/')).toEqual({
      status: 'ok',
      origin: 'https://operator.example.com',
    });
    expect(resolveDeskOperatorOrigin('https://operator.example.com/api').status).toBe('invalid');
    expect(resolveDeskOperatorOrigin('https://user@operator.example.com').status).toBe('invalid');
    expect(resolveDeskOperatorOrigin('https://operator.example.com?x=1').status).toBe('invalid');
    expect(resolveDeskOperatorOrigin('https://operator.example.com#x').status).toBe('invalid');
  });

  it('allows http only on loopback hosts', () => {
    expect(resolveDeskOperatorOrigin('http://localhost:9210')).toEqual({
      status: 'ok',
      origin: 'http://localhost:9210',
    });
    expect(resolveDeskOperatorOrigin('http://127.0.0.1:9210').status).toBe('ok');
    expect(resolveDeskOperatorOrigin('http://operator.example.com').status).toBe('invalid');
  });

  it('reports a missing enrollment distinctly from a malformed one', () => {
    expect(resolveDeskOperatorOrigin(undefined).status).toBe('missing');
    expect(resolveDeskOperatorOrigin('   ').status).toBe('missing');
    expect(resolveDeskOperatorOrigin('not a url').status).toBe('invalid');
  });
});

describe('normalizeVaultAddress', () => {
  const VAULT = '0xAbCdEf0123456789aBcDeF0123456789abCDef01';

  it('case-folds the full 20-byte hex form', () => {
    expect(normalizeVaultAddress(VAULT)).toBe(VAULT.toLowerCase());
    expect(normalizeVaultAddress(VAULT.toLowerCase())).toBe(VAULT.toLowerCase());
  });

  it('rejects truncated, non-hex, non-string and zero addresses', () => {
    expect(normalizeVaultAddress('0xAbCdEf01')).toBeNull();
    expect(normalizeVaultAddress('0xzzzzef0123456789abcdef0123456789abcdef01')).toBeNull();
    expect(normalizeVaultAddress(undefined)).toBeNull();
    expect(normalizeVaultAddress(`0x${'0'.repeat(40)}`)).toBeNull();
  });
});

describe('evaluateDeskConsent', () => {
  const ADDRESS = '0x11aAbB22ccDD33eeFF44556677889900aABBccDD';
  const VAULT = '0x99eEfF00112233445566778899aabbccddeEff00';
  const NOW = Math.floor(Date.now() / 1000);
  const bot: RosterBot = {
    id: 'bot-1',
    submitter_address: ADDRESS,
    vault_address: VAULT,
    chain_id: 998,
  };
  const envelope = {
    vaultAddress: VAULT.toUpperCase().replace('0X', '0x'),
    protocol: 'uniswap_v3',
    expiresAt: NOW + 3_600,
    maxTradeSizeUsd: '100',
    maxTotalExposureUsd: '1000',
    signatures: 2,
    deploymentConfirmed: true,
  };
  const preview: DeskPreview = {
    botId: 'bot-1',
    network: 'test',
    chainId: 998,
    eligible: true,
    problems: [],
    envelope,
    instruments: [{ instrument: 'WETH-USDC', base: 'WETH', quote: 'USDC' }],
    scopes: ['account:read', 'orders:submit', 'orders:read', 'connection:revoke'],
    quoteCurrency: 'USDC',
  };
  const base = { network: 'test' as const, address: ADDRESS, bot, preview, nowSec: NOW };

  it('accepts a fresh preview whose envelope vault losslessly matches the roster vault', () => {
    expect(evaluateDeskConsent(base)).toEqual({ ok: true });
  });

  it('blocks a zero or missing envelope vault address', () => {
    for (const vaultAddress of [`0x${'0'.repeat(40)}`, '0x1234', '']) {
      const result = evaluateDeskConsent({
        ...base,
        preview: { ...preview, envelope: { ...envelope, vaultAddress } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(' ')).toMatch(/nonzero vault/);
    }
  });

  it('blocks when the verified envelope vault differs from the roster vault', () => {
    const other = VAULT.replace(/0$/, '1');
    const result = evaluateDeskConsent({
      ...base,
      preview: { ...preview, envelope: { ...envelope, vaultAddress: other } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toMatch(/does not match/);
  });

  it('blocks an unconfirmed deployment, a zero signer quorum, and a stale expiry', () => {
    const cases: Array<[Partial<typeof envelope>, RegExp]> = [
      [{ deploymentConfirmed: false }, /deployment/],
      [{ signatures: 0 }, /signatures/],
      [{ expiresAt: NOW - 1 }, /expired/],
    ];
    for (const [patch, pattern] of cases) {
      const result = evaluateDeskConsent({
        ...base,
        preview: { ...preview, envelope: { ...envelope, ...patch } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(' ')).toMatch(pattern);
    }
  });

  it('blocks a preview bound to a different wallet, bot, network or chain', () => {
    const cases = [
      [{ address: '0xaa1122bb3344cc5566dd7788ee9900ff11aa2233' }, /does not own/],
      [{ preview: { ...preview, botId: 'bot-2' } }, /does not match/],
      [{ preview: { ...preview, network: 'live' } }, /does not match/],
      [{ preview: { ...preview, chainId: 999 } }, /chain 999/],
    ] as const;
    for (const [patch, pattern] of cases) {
      const result = evaluateDeskConsent({ ...base, ...patch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(' ')).toMatch(pattern);
    }
  });

  it('blocks paper bots on the live network and ineligible previews', () => {
    const paper = evaluateDeskConsent({
      ...base,
      network: 'live',
      bot: { ...bot, paper_trade: true },
      preview: { ...preview, network: 'live', chainId: 999 },
    });
    expect(paper.ok).toBe(false);
    if (!paper.ok) expect(paper.problems.join(' ')).toMatch(/Paper-trading/);

    const ineligible = evaluateDeskConsent({
      ...base,
      preview: { ...preview, eligible: false, problems: ['bot trading is paused'] },
    });
    expect(ineligible.ok).toBe(false);
    if (!ineligible.ok) expect(ineligible.problems).toContain('bot trading is paused');
  });
});

describe('ownedRosterBots', () => {
  it('keeps only bots whose submitter matches the connected wallet', () => {
    const bots: RosterBot[] = [
      { id: 'a', submitter_address: '0xABC' },
      { id: 'b', submitter_address: '0xdef' },
      { id: 'c' },
    ];
    expect(ownedRosterBots(bots, '0xabc').map((bot) => bot.id)).toEqual(['a']);
    expect(ownedRosterBots(bots, undefined)).toEqual([]);
  });
});

describe('ConnectTradingRoute', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockAccount.address = undefined;
    mockAccount.isConnected = false;
    mockAuth.isAuthenticated = false;
    mockAuth.error = null;
  });

  it('renders the honest setup state with zero network requests when no operator is enrolled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Vitest exposes no VITE_TRADING_DESK_OPERATOR_ORIGIN_* here, so the
    // enrollment is missing by construction.
    mockSearchParams = new URLSearchParams(VALID_PARAMS);
    renderWithClient();
    expect(await screen.findByText(/No operator is enrolled for the test network/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect wallet/i)).toBeNull();
  });

  it('renders a return-to-desk action for an invalid request without fetching', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockSearchParams = new URLSearchParams({ response_type: 'token' });
    renderWithClient();
    expect(screen.getByText(/connection request is invalid/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests nothing from an enrolled operator until the wallet is verified', async () => {
    vi.stubEnv('VITE_TRADING_DESK_OPERATOR_ORIGIN_TEST', 'http://127.0.0.1:9');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockSearchParams = new URLSearchParams(VALID_PARAMS);
    mockAccount.address = '0x4242424242424242424242424242424242424242';
    mockAccount.isConnected = true;
    renderWithClient();
    expect(await screen.findByRole('button', { name: /verify wallet ownership/i })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Post-auth flow against a local-fixture operator (labeled fixture UI state,
// not a real operator). The operator wire below mirrors the a1b214f preview
// contract; wallet/session integration is mocked at the hook boundary.
const FIXTURE_WALLET = '0x4242424242424242424242424242424242424242';
const FIXTURE_VAULT = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';

function fixturePreview(envelopePatch: Record<string, unknown> = {}) {
  return {
    botId: 'fixture-bot-1',
    network: 'test',
    chainId: 998,
    eligible: true,
    problems: [],
    envelope: {
      vaultAddress: FIXTURE_VAULT,
      protocol: 'uniswap_v3',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      maxTradeSizeUsd: '250',
      maxTotalExposureUsd: '2500',
      signatures: 2,
      deploymentConfirmed: true,
      ...envelopePatch,
    },
    instruments: [{ instrument: 'WETH-USDC', base: 'WETH', quote: 'USDC' }],
    scopes: ['account:read', 'orders:submit', 'orders:read', 'connection:revoke'],
    quoteCurrency: 'USDC',
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function fixtureFetch(preview: ReturnType<typeof fixturePreview>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as Request).url);
    if (url.includes('/api/bots')) {
      return jsonResponse({
        bots: [
          {
            id: 'fixture-bot-1',
            name: 'Fixture Bot',
            submitter_address: FIXTURE_WALLET,
            vault_address: FIXTURE_VAULT,
            chain_id: 998,
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
      });
    }
    if (url.includes('/api/trading-desk/authorize/preview')) return jsonResponse(preview);
    if (url.endsWith('/api/trading-desk/authorize')) {
      return jsonResponse({ code: 'tdsk-code-fixture0001' });
    }
    throw new Error(`Unexpected fixture fetch: ${url}`);
  });
}

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectTradingRoute />
    </QueryClientProvider>,
  );
}

async function renderVerifiedBot(preview: ReturnType<typeof fixturePreview>) {
  vi.stubEnv('VITE_TRADING_DESK_OPERATOR_ORIGIN_TEST', 'http://127.0.0.1:9');
  vi.stubGlobal('fetch', fixtureFetch(preview));
  mockSearchParams = new URLSearchParams(VALID_PARAMS);
  mockAccount.address = FIXTURE_WALLET;
  mockAccount.isConnected = true;
  mockAuth.isAuthenticated = true;
  renderWithClient();
  fireEvent.click(await screen.findByRole('button', { name: /fixture bot/i }));
  await screen.findByText(/Bot vault \(verified against the signed envelope\)/i);
}

describe('ConnectTradingRoute consent flow (fixture operator)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockAccount.address = undefined;
    mockAccount.isConnected = false;
    mockAuth.isAuthenticated = false;
    mockAuth.error = null;
  });

  it('renders the signed-envelope terms and authorizes only to the fixed callback', async () => {
    await renderVerifiedBot(fixturePreview());
    expect(screen.getByText(FIXTURE_VAULT)).toBeTruthy();
    expect(screen.getByText(/Atomic spot swaps on WETH-USDC/i)).toBeTruthy();
    expect(screen.getByText(/Max trade size \$250/i)).toBeTruthy();
    expect(screen.getByText(/Submit atomic spot-swap orders/i)).toBeTruthy();
    expect(screen.getByText('Eligible', { exact: true })).toBeTruthy();

    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });

    fireEvent.click(screen.getByRole('button', { name: /authorize connection/i }));
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://trading.tangle.tools/api/trading/live/oauth/tangle-vault/callback?code=tdsk-code-fixture0001&state=opaque-state',
      ),
    );
  });

  it('blocks authorize on a vault mismatch between the envelope and the roster', async () => {
    await renderVerifiedBot(
      fixturePreview({ vaultAddress: '0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b' }),
    );
    expect(screen.getByText(/does not match the vault on record/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /authorize connection/i })).toHaveProperty('disabled', true);
  });

  it('blocks authorize on an expired envelope', async () => {
    await renderVerifiedBot(fixturePreview({ expiresAt: Math.floor(Date.now() / 1000) - 10 }));
    expect(screen.getByText(/envelope has expired/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /authorize connection/i })).toHaveProperty('disabled', true);
  });

  it('blocks authorize when the deployment is unconfirmed or quorum is zero', async () => {
    await renderVerifiedBot(fixturePreview({ deploymentConfirmed: false }));
    expect(screen.getByText(/deployment is not confirmed/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /authorize connection/i })).toHaveProperty('disabled', true);
  });
});
