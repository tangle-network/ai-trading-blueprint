import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParentBridgeProvider } from './parentBridgeProvider';
import {
  NO_WALLET_ADDRESS,
  TANGLE_IFRAME_PROTOCOL_VERSION,
} from './parentBridgeProtocol';

const PARENT_ORIGIN = 'https://cloud.tangle.tools';

/**
 * Drive the provider against a fake parent: capture every message the
 * provider posts, route a scripted response (or broadcast) back, and assert
 * the provider's observable behavior.
 *
 * The fake parent runs in the same JS context as the provider (jsdom's
 * `window.parent === window`), so we monkey-patch `window.parent.postMessage`
 * to intercept; for inbound messages we synthesize `MessageEvent`s with the
 * trusted origin and dispatch them onto `window`.
 */
type Captured = { message: unknown; origin: string };

function setupFakeParent() {
  const captured: Captured[] = [];
  const originalParent = window.parent;
  Object.defineProperty(window, 'parent', {
    configurable: true,
    get() {
      return {
        postMessage: (message: unknown, targetOrigin: string) => {
          captured.push({ message, origin: targetOrigin });
        },
      };
    },
  });
  const restore = () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    });
  };
  const inbound = (data: object) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin: PARENT_ORIGIN }));
  return { captured, inbound, restore };
}

describe('ParentBridgeProvider', () => {
  let fake: ReturnType<typeof setupFakeParent>;
  let provider: ParentBridgeProvider;

  beforeEach(() => {
    fake = setupFakeParent();
    provider = new ParentBridgeProvider({
      parentOrigin: PARENT_ORIGIN,
      appId: 'agent-sandbox',
      requestTimeoutMs: 1_000,
    });
  });

  afterEach(() => {
    provider.uninstall();
    fake.restore();
  });

  it('sends a handshake on install + pins targetOrigin to the parent', () => {
    provider.install();
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].origin).toBe(PARENT_ORIGIN);
    expect(fake.captured[0].message).toEqual({
      kind: 'tangle.app.handshake',
      appId: 'agent-sandbox',
      version: TANGLE_IFRAME_PROTOCOL_VERSION,
    });
  });

  it('rejects messages from origins that are not the configured parent', () => {
    provider.install();
    // Manually dispatch a message from a different origin claiming to be a
    // handshake ack. The provider must ignore it — verified by inspecting
    // `getCachedAccount` (which gets set on a successful readAccountResult).
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          kind: 'tangle.app.accountChanged',
          account: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
        origin: 'https://evil.example.com',
      }),
    );
    expect(provider.getCachedAccount()).toBeNull();
  });

  it('resolves eth_accounts to [] when parent reports zero-address', async () => {
    provider.install();
    fake.inbound({
      kind: 'tangle.app.handshakeAck',
      appId: 'agent-sandbox',
      protocolVersion: TANGLE_IFRAME_PROTOCOL_VERSION,
    });
    // Provider auto-fires a readAccount after handshakeAck. Wait for it,
    // then reply with the zero-address sentinel.
    const readAccountMsg = await vi.waitFor(() => {
      const m = fake.captured.find(
        (c) =>
          typeof c.message === 'object' &&
          c.message !== null &&
          (c.message as { kind?: string }).kind === 'tangle.app.readAccount',
      );
      if (!m) throw new Error('readAccount not posted yet');
      return m;
    });
    const correlationId = (readAccountMsg.message as { correlationId: string })
      .correlationId;
    fake.inbound({
      kind: 'tangle.app.readAccountResult',
      correlationId,
      ok: true,
      data: { account: NO_WALLET_ADDRESS, chainId: 84532 },
    });
    const accounts = await provider.request({ method: 'eth_accounts' });
    expect(accounts).toEqual([]);
  });

  it('emits accountsChanged when the parent broadcasts a new account', () => {
    provider.install();
    fake.inbound({
      kind: 'tangle.app.handshakeAck',
      appId: 'agent-sandbox',
      protocolVersion: TANGLE_IFRAME_PROTOCOL_VERSION,
    });
    const seen: unknown[] = [];
    provider.on('accountsChanged', (accounts) => seen.push(accounts));
    fake.inbound({
      kind: 'tangle.app.accountChanged',
      account: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
    });
    expect(seen).toEqual([['0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc']]);
  });

  it('forwards personal_sign through the bridge and resolves on signMessageResult', async () => {
    provider.install();
    fake.inbound({
      kind: 'tangle.app.handshakeAck',
      appId: 'agent-sandbox',
      protocolVersion: TANGLE_IFRAME_PROTOCOL_VERSION,
    });
    // Establish chain context — the bridge needs `cachedChainId` to sign.
    fake.inbound({ kind: 'tangle.app.chainChanged', chainId: 84532 });

    const signed = provider.request({
      method: 'personal_sign',
      params: ['hello', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc'],
    });
    // Find the outbound signMessage request.
    const outbound = await vi.waitFor(() => {
      const msg = fake.captured.find(
        (c) =>
          typeof c.message === 'object' &&
          c.message !== null &&
          (c.message as { kind?: string }).kind === 'tangle.app.signMessage',
      );
      if (!msg) throw new Error('signMessage not posted yet');
      return msg;
    });
    const correlationId = (outbound.message as { correlationId: string })
      .correlationId;
    expect((outbound.message as { message: string }).message).toBe('hello');
    fake.inbound({
      kind: 'tangle.app.signMessageResult',
      correlationId,
      ok: true,
      data: { signature: '0xdeadbeef' },
    });
    await expect(signed).resolves.toBe('0xdeadbeef');
  });

  it('rejects on parent error response with the parent-provided error message', async () => {
    provider.install();
    fake.inbound({
      kind: 'tangle.app.handshakeAck',
      appId: 'agent-sandbox',
      protocolVersion: TANGLE_IFRAME_PROTOCOL_VERSION,
    });
    fake.inbound({ kind: 'tangle.app.chainChanged', chainId: 84532 });

    const signed = provider.request({
      method: 'personal_sign',
      params: ['hello', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc'],
    });
    const outbound = await vi.waitFor(() => {
      const msg = fake.captured.find(
        (c) =>
          typeof c.message === 'object' &&
          c.message !== null &&
          (c.message as { kind?: string }).kind === 'tangle.app.signMessage',
      );
      if (!msg) throw new Error('not posted yet');
      return msg;
    });
    const correlationId = (outbound.message as { correlationId: string })
      .correlationId;
    fake.inbound({
      kind: 'tangle.app.signMessageResult',
      correlationId,
      ok: false,
      error: 'user-rejected',
    });
    await expect(signed).rejects.toThrow('user-rejected');
  });
});
