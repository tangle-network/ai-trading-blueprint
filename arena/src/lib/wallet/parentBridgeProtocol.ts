// MIRROR of ai-agent-sandbox-blueprint/ui/src/lib/wallet/parentBridgeProtocol.ts.
// Both products embed in the same Tangle Cloud parent under the same
// iframe protocol. Consolidate into @tangle-network/blueprint-ui next.
//
// Tangle Cloud iframe ↔ parent dapp protocol — must mirror the parent's
// spec at `apps/tangle-cloud/src/blueprintApps/iframe/protocol.ts`. Bump the
// version constant in lockstep when either side adds a request kind.

import type { Address, Hex } from 'viem';

export const TANGLE_IFRAME_PROTOCOL_VERSION = '1' as const;
export const TANGLE_IFRAME_PROTOCOL_PREFIX = 'tangle.app.';

// ─── Iframe → Parent requests ────────────────────────────────────────────────

export type HandshakeRequest = {
  kind: 'tangle.app.handshake';
  appId: string;
  version: typeof TANGLE_IFRAME_PROTOCOL_VERSION;
};

export type ReadAccountRequest = {
  kind: 'tangle.app.readAccount';
  correlationId: string;
};

export type SwitchChainRequest = {
  kind: 'tangle.app.switchChain';
  correlationId: string;
  chainId: number;
};

export type SignMessageRequest = {
  kind: 'tangle.app.signMessage';
  correlationId: string;
  chainId: number;
  message: string;
};

export type SignTransactionRequest = {
  kind: 'tangle.app.signTransaction';
  correlationId: string;
  chainId: number;
  to: Address;
  data: Hex;
  value?: string;
};

// ─── Parent → Iframe messages ────────────────────────────────────────────────

export type HandshakeAck = {
  kind: 'tangle.app.handshakeAck';
  appId: string;
  protocolVersion: typeof TANGLE_IFRAME_PROTOCOL_VERSION;
};

export type ResultEnvelope<T> = { correlationId: string } & (
  | { ok: true; data: T }
  | { ok: false; error: string }
);

export type ReadAccountResult = {
  kind: 'tangle.app.readAccountResult';
} & ResultEnvelope<{ account: Address; chainId: number }>;

export type SwitchChainResult = {
  kind: 'tangle.app.switchChainResult';
} & ResultEnvelope<{ chainId: number }>;

export type SignMessageResult = {
  kind: 'tangle.app.signMessageResult';
} & ResultEnvelope<{ signature: Hex }>;

export type SignTransactionResult = {
  kind: 'tangle.app.signTransactionResult';
} & ResultEnvelope<{ txHash: Hex }>;

export type AccountChanged = {
  kind: 'tangle.app.accountChanged';
  account: Address | null;
};

export type ChainChanged = {
  kind: 'tangle.app.chainChanged';
  chainId: number;
};

export type ParentMessage =
  | HandshakeAck
  | ReadAccountResult
  | SwitchChainResult
  | SignMessageResult
  | SignTransactionResult
  | AccountChanged
  | ChainChanged;

// The zero address used by the parent when no wallet is connected. The parent
// always responds to readAccount with an address; this sentinel means "no
// wallet" without making the response type a union of result shapes.
export const NO_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Cryptographically-random ASCII correlation id matching the parent's
 * validator regex (`/^[\w.\-:]+$/`, max length 128). The connector keeps a
 * Map<correlationId, Resolver> so each request resolves independently.
 */
export function makeCorrelationId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}.${random}`;
}
