// MIRROR of ai-agent-sandbox-blueprint/ui/src/lib/wallet/parentBridgeProvider.ts.
// Both products embed in the same Tangle Cloud parent under the same
// iframe protocol. Consolidate into @tangle-network/blueprint-ui next.
//
// EIP-1193 provider implementation that proxies wallet calls to the parent
// dapp via window.postMessage. The iframe doesn't talk to a wallet directly
// — it inherits the parent's connected account + chain, and forwards signing
// requests through the existing tangle.app.* protocol.
//
// This is the lowest layer of the parent-bridge stack. Wagmi sees this as a
// regular Ethereum provider and routes `eth_accounts`, `eth_chainId`,
// `personal_sign`, `eth_sendTransaction`, `wallet_switchEthereumChain`, etc.
// through it.

import type { Address, Hex } from 'viem';

import {
  makeCorrelationId,
  NO_WALLET_ADDRESS,
  TANGLE_IFRAME_PROTOCOL_VERSION,
  type ParentMessage,
} from './parentBridgeProtocol';

type EventName = 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect' | 'message';
type Listener = (...args: unknown[]) => void;

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  expectedKind: ParentMessage['kind'];
};

export type ParentBridgeOptions = {
  /**
   * Origin of the parent dapp that hosts this iframe. The provider posts to
   * `window.parent` with this exact origin and rejects inbound messages from
   * any other origin. Pass `'*'` only in development; production must pin to
   * the real parent (`https://cloud.tangle.tools` or its develop equivalent).
   */
  parentOrigin: string;
  /**
   * Stable identifier for this iframe app. The parent includes this in the
   * handshake ack so dev tooling can correlate logs across the two windows.
   */
  appId: string;
  /**
   * Optional ms timeout for each bridged request. Defaults to 60 seconds —
   * long enough for a user to read + approve a signing prompt in the parent.
   */
  requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Detect iframe execution context. When this returns `false` the bridge
 * connector should not be installed and the host app should fall back to its
 * normal wallet config (ConnectKit + injected/walletConnect).
 *
 * `window.parent !== window` is the most reliable signal that works across
 * sandbox-iframe contexts where direct property access to parent throws.
 */
export function isRunningInIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.parent !== undefined && window.parent !== window;
  } catch {
    // Cross-origin read of `window.parent` shouldn't throw, but be defensive.
    return true;
  }
}

/**
 * EIP-1193 provider backed by the Tangle Cloud iframe protocol. One instance
 * lives per iframe app; the wagmi connector owns the singleton.
 */
export class ParentBridgeProvider {
  private listeners = new Map<EventName, Set<Listener>>();
  private pending = new Map<string, PendingRequest<unknown>>();
  private cachedAccount: Address | null = null;
  private cachedChainId: number | null = null;
  private handshakeAcked = false;
  private handshakeWaiters: Array<() => void> = [];
  private installed = false;

  constructor(private readonly options: ParentBridgeOptions) {}

  /**
   * Wire up the global message listener and send the initial handshake.
   * Idempotent — safe to call repeatedly during reconnect attempts.
   */
  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    window.addEventListener('message', this.handleParentMessage);
    this.postToParent({
      kind: 'tangle.app.handshake',
      appId: this.options.appId,
      version: TANGLE_IFRAME_PROTOCOL_VERSION,
    });
  }

  uninstall(): void {
    if (!this.installed || typeof window === 'undefined') return;
    this.installed = false;
    window.removeEventListener('message', this.handleParentMessage);
    // Reject every pending request so callers don't hang forever.
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Parent bridge uninstalled'));
    }
    this.pending.clear();
  }

  // ── EIP-1193 surface ────────────────────────────────────────────────────

  async request(req: { method: string; params?: unknown[] }): Promise<unknown> {
    const method = req.method;
    const params = (req.params ?? []) as unknown[];
    switch (method) {
      case 'eth_chainId': {
        await this.ensureBootstrapped();
        return this.cachedChainId !== null ? `0x${this.cachedChainId.toString(16)}` : '0x0';
      }
      case 'eth_accounts':
      case 'eth_requestAccounts': {
        await this.ensureBootstrapped();
        return this.cachedAccount !== null ? [this.cachedAccount] : [];
      }
      case 'personal_sign': {
        const [message, _signer] = params as [string, Address];
        return this.requestSignMessage(message);
      }
      case 'eth_signTypedData_v4': {
        // The current protocol doesn't carry typed-data — surface a clear
        // error rather than silently producing a personal_sign. Publishers
        // that need typed-data signing should upgrade the protocol.
        throw bridgeError(
          4200,
          'eth_signTypedData_v4 is not supported by the parent-bridge protocol yet.',
        );
      }
      case 'eth_sendTransaction': {
        const [tx] = params as [
          { to?: Address; data?: Hex; value?: Hex | string; chainId?: Hex | number },
        ];
        if (!tx?.to || !tx.data) {
          throw bridgeError(-32602, 'eth_sendTransaction requires `to` and `data`.');
        }
        return this.requestSignTransaction(tx);
      }
      case 'wallet_switchEthereumChain': {
        const [{ chainId }] = params as [{ chainId: Hex }];
        const numeric = Number.parseInt(chainId, 16);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          throw bridgeError(-32602, `Invalid chainId: ${chainId}`);
        }
        await this.requestSwitchChain(numeric);
        return null;
      }
      case 'wallet_addEthereumChain': {
        // The parent owns the chain registry; iframes can't add chains the
        // dapp doesn't already know about.
        throw bridgeError(
          4200,
          'wallet_addEthereumChain is not supported through the parent bridge.',
        );
      }
      default:
        throw bridgeError(4200, `Method ${method} not supported by parent bridge.`);
    }
  }

  on(event: EventName, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: EventName, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  // ── Internal: dispatch + book-keeping ───────────────────────────────────

  private postToParent(message: object): void {
    if (typeof window === 'undefined') return;
    try {
      window.parent.postMessage(message, this.options.parentOrigin);
    } catch {
      // Cross-origin / sandboxed; parent.postMessage shouldn't actually throw
      // but be defensive against future browser changes.
    }
  }

  private handleParentMessage = (event: MessageEvent): void => {
    // Origin gate first; never parse untrusted payloads.
    if (event.origin !== this.options.parentOrigin) return;
    const data = event.data;
    if (typeof data !== 'object' || data === null) return;
    const message = data as ParentMessage;
    switch (message.kind) {
      case 'tangle.app.handshakeAck':
        this.handshakeAcked = true;
        for (const resolve of this.handshakeWaiters) resolve();
        this.handshakeWaiters = [];
        // After ack, ask for the current account so cached state reflects
        // reality before any consumer queries. Fire-and-forget — explicit
        // calls (`eth_accounts`, etc.) await their own request.
        this.sendReadAccount().catch(() => {
          // The first read commonly races with bridge teardown in tests
          // and isn't user-facing; swallow rather than producing unhandled
          // rejections. Subsequent `eth_accounts` calls retry on demand.
        });
        return;
      case 'tangle.app.readAccountResult':
        this.resolvePending(message);
        if (message.ok) {
          this.updateAccount(
            message.data.account === NO_WALLET_ADDRESS
              ? null
              : message.data.account,
          );
          this.updateChainId(message.data.chainId);
        }
        return;
      case 'tangle.app.switchChainResult':
        this.resolvePending(message);
        if (message.ok) this.updateChainId(message.data.chainId);
        return;
      case 'tangle.app.signMessageResult':
      case 'tangle.app.signTransactionResult':
        this.resolvePending(message);
        return;
      case 'tangle.app.accountChanged':
        this.updateAccount(message.account);
        return;
      case 'tangle.app.chainChanged':
        this.updateChainId(message.chainId);
        return;
    }
  };

  private sendReadAccount(): Promise<{ account: Address; chainId: number }> {
    return this.dispatch({
      kind: 'tangle.app.readAccount',
      expectedKind: 'tangle.app.readAccountResult',
    }) as Promise<{ account: Address; chainId: number }>;
  }

  private requestSignMessage(message: string): Promise<Hex> {
    const chainId = this.cachedChainId ?? 1;
    return this.dispatch({
      kind: 'tangle.app.signMessage',
      expectedKind: 'tangle.app.signMessageResult',
      payload: { chainId, message },
    }).then((data) => (data as { signature: Hex }).signature);
  }

  private requestSignTransaction(tx: {
    to?: Address;
    data?: Hex;
    value?: Hex | string;
  }): Promise<Hex> {
    const chainId = this.cachedChainId ?? 1;
    const value =
      typeof tx.value === 'string' && tx.value.startsWith('0x')
        ? BigInt(tx.value).toString(10)
        : typeof tx.value === 'string'
          ? tx.value
          : undefined;
    return this.dispatch({
      kind: 'tangle.app.signTransaction',
      expectedKind: 'tangle.app.signTransactionResult',
      payload: {
        chainId,
        to: tx.to as Address,
        data: tx.data as Hex,
        ...(value !== undefined ? { value } : {}),
      },
    }).then((data) => (data as { txHash: Hex }).txHash);
  }

  private requestSwitchChain(chainId: number): Promise<number> {
    return this.dispatch({
      kind: 'tangle.app.switchChain',
      expectedKind: 'tangle.app.switchChainResult',
      payload: { chainId },
    }).then((data) => (data as { chainId: number }).chainId);
  }

  private async dispatch(req: {
    kind: 'tangle.app.readAccount' | 'tangle.app.switchChain' | 'tangle.app.signMessage' | 'tangle.app.signTransaction';
    expectedKind: ParentMessage['kind'];
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    await this.ensureBootstrapped();
    const correlationId = makeCorrelationId(req.kind);
    const timeout = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(correlationId);
        reject(bridgeError(4900, `Parent did not respond to ${req.kind} within ${timeout}ms`));
      }, timeout);
      this.pending.set(correlationId, {
        resolve: (v) => {
          window.clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          window.clearTimeout(timer);
          reject(e);
        },
        expectedKind: req.expectedKind,
      });
      this.postToParent({
        kind: req.kind,
        correlationId,
        ...(req.payload ?? {}),
      });
    });
  }

  private resolvePending(message: Extract<ParentMessage, { correlationId: string }>): void {
    const entry = this.pending.get(message.correlationId);
    if (!entry) return;
    this.pending.delete(message.correlationId);
    if (entry.expectedKind !== message.kind) {
      entry.reject(
        bridgeError(
          -32000,
          `Parent replied with ${message.kind} but ${entry.expectedKind} was expected`,
        ),
      );
      return;
    }
    if (message.ok) {
      entry.resolve(message.data);
    } else {
      entry.reject(bridgeError(4001, message.error));
    }
  }

  private async ensureBootstrapped(): Promise<void> {
    if (this.handshakeAcked) return;
    this.install();
    await new Promise<void>((resolve) => {
      this.handshakeWaiters.push(resolve);
      // Re-send handshake every 500ms while we wait — covers a parent that
      // mounted after the iframe and missed the initial post.
      const retry = window.setInterval(() => {
        if (this.handshakeAcked) {
          window.clearInterval(retry);
          return;
        }
        this.postToParent({
          kind: 'tangle.app.handshake',
          appId: this.options.appId,
          version: TANGLE_IFRAME_PROTOCOL_VERSION,
        });
      }, 500);
      // Safety stop — handshake won't be re-attempted indefinitely.
      window.setTimeout(() => window.clearInterval(retry), 10_000);
    });
  }

  private updateAccount(next: Address | null): void {
    if (this.cachedAccount === next) return;
    const prev = this.cachedAccount;
    this.cachedAccount = next;
    if (next === null && prev !== null) {
      this.emit('disconnect');
      this.emit('accountsChanged', []);
    } else if (next !== null) {
      this.emit('accountsChanged', [next]);
      if (prev === null) {
        this.emit('connect', { chainId: this.cachedChainId ?? 0 });
      }
    }
  }

  private updateChainId(next: number): void {
    if (this.cachedChainId === next) return;
    this.cachedChainId = next;
    this.emit('chainChanged', `0x${next.toString(16)}`);
  }

  private emit(event: EventName, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch {
        // Listener bugs shouldn't break the bridge.
      }
    }
  }

  // ── Test seams ──────────────────────────────────────────────────────────

  /** Visible for tests + the connector's `getAccounts()` shortcut. */
  getCachedAccount(): Address | null {
    return this.cachedAccount;
  }
  /** Visible for tests + the connector's `getChainId()` shortcut. */
  getCachedChainId(): number | null {
    return this.cachedChainId;
  }
}

function bridgeError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code?: number };
  err.code = code;
  return err;
}
