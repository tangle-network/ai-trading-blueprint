import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { type Address, sha256 as viemSha256, toHex } from 'viem';
import { resolveOperatorRpc, type DiscoveredOperator } from '@tangle-network/blueprint-ui';
import {
  PricingEngine,
  type GetPriceResponse,
  type QuoteDetails,
  PricingModelHint,
} from '~/lib/gen/pricing_pb';

// ── Types ─────────────────────────────────────────────────────────────────

type SecurityCommitment = {
  asset: { kind: number; token: Address };
  exposureBps: number;
};

type ResourceCommitment = {
  kind: number;
  count: bigint;
};

export interface OperatorQuote {
  operator: Address;
  /** Wei amount for the on-chain createServiceFromQuotes call */
  totalCost: bigint;
  /** 65-byte ECDSA signature (0x-prefixed hex) */
  signature: `0x${string}`;
  /** Raw quote details for the contract tuple */
  details: {
    /**
     * tnt-core v0.13.0: address bound into the EIP-712 typed data; on-chain
     * verifier rejects `address(0)` and enforces equality with `msg.sender`.
     * Frontend MUST set this to the connected wallet that will submit the tx.
     */
    requester: Address;
    blueprintId: bigint;
    ttlBlocks: bigint;
    totalCost: bigint;
    timestamp: bigint;
    expiry: bigint;
    confidentiality: number;
    securityCommitments: readonly SecurityCommitment[];
    resourceCommitments: readonly ResourceCommitment[];
  };
  /** Human-readable cost rate (USD) */
  costRate: number;
  teeAttested?: boolean;
  teeProvider?: string;
}

/**
 * A quote fetch that failed, classified into an actionable category so the UI
 * can render a designed, recoverable blocked state instead of a raw error
 * string. `detail` preserves the original operator/transport message for
 * debugging and the expandable affordance.
 */
export type QuoteFailureKind =
  | 'unauthorized'
  | 'at_capacity'
  | 'cannot_price'
  | 'unreachable'
  | 'misconfigured';

export interface QuoteFailure {
  kind: QuoteFailureKind;
  detail: string;
}

export interface UseQuotesResult {
  quotes: OperatorQuote[];
  isLoading: boolean;
  errors: Map<Address, QuoteFailure>;
  totalCost: bigint;
  refetch: () => void;
}

/**
 * Map an operator quote failure (gRPC-web ConnectError, fetch/transport
 * failure, or a thrown Error from quote decoding) onto an actionable category.
 *
 * Precedence is deliberate: authorization and capacity are explicit operator
 * rejections and must win over generic transport heuristics. Network failures
 * are next (so a `fetch failed` never gets mislabelled as a pricing bug), then
 * pricing/decode problems, with `misconfigured` as the catch-all.
 *
 * Pure and dependency-free so it can be unit-tested and reused by the UI.
 */
export function classifyQuoteFailure(err: unknown): QuoteFailure {
  const detail =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  const text = detail.toLowerCase();

  // gRPC-web (ConnectError) and HTTP errors carry a numeric status/code.
  const status = extractStatusCode(err);
  const code = extractConnectCode(err);

  if (
    status === 403 ||
    code === 'permission_denied' ||
    code === 'unauthenticated' ||
    /not allowed|requesternotallowed|not a permitted|not permitted|unauthor|forbidden|permission denied/.test(text)
  ) {
    return { kind: 'unauthorized', detail };
  }

  if (
    code === 'resource_exhausted' ||
    /at capacity|capacity|no slots|slots are full|too many requests|rate limit/.test(text)
  ) {
    return { kind: 'at_capacity', detail };
  }

  if (
    status === 0 ||
    code === 'unavailable' ||
    code === 'deadline_exceeded' ||
    /failed to fetch|fetch failed|network|timeout|timed out|connect|connection|econnrefused|unreachable|no rpc address|dns|socket/.test(text)
  ) {
    return { kind: 'unreachable', detail };
  }

  if (
    /price|quote|decode|parse|signature|sig|no quote details|exposure|resource kind/.test(text)
  ) {
    return { kind: 'cannot_price', detail };
  }

  return { kind: 'misconfigured', detail };
}

/** Best-effort extraction of an HTTP status code from a thrown error object. */
function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  for (const key of ['status', 'httpStatus', 'statusCode'] as const) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Best-effort extraction of a Connect/gRPC status code label. `@connectrpc`
 * `ConnectError` exposes a numeric `code`; we map the subset we care about so
 * classification doesn't depend on importing the enum here.
 */
function extractConnectCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  const raw = record.code;
  if (typeof raw === 'string') return raw.toLowerCase().replace(/[\s-]/g, '_');
  if (typeof raw === 'number') {
    // Connect numeric codes (subset relevant to quoting).
    const CONNECT_CODE: Record<number, string> = {
      4: 'deadline_exceeded',
      7: 'permission_denied',
      8: 'resource_exhausted',
      14: 'unavailable',
      16: 'unauthenticated',
    };
    return CONNECT_CODE[raw];
  }
  return undefined;
}

// ── PoW helpers (mirrors pricing-engine/src/pow.rs) ───────────────────────

const POW_DIFFICULTY = 20;
const RESOURCE_KIND_TO_ID = {
  CPU: 0,
  MemoryMB: 1,
  StorageMB: 2,
  NetworkEgressMB: 3,
  NetworkIngressMB: 4,
  GPU: 5,
} as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const DEFAULT_RESOURCE_REQUIREMENTS = [
  { kind: 'CPU', count: 1n },
  { kind: 'MemoryMB', count: 1024n },
  { kind: 'StorageMB', count: 10240n },
] as const;

/** SHA-256 via viem (pure JS, works in insecure contexts) */
function sha256(data: Uint8Array): Uint8Array {
  return viemSha256(data, 'bytes');
}

/** generate_challenge: SHA256(blueprint_id_BE || timestamp_BE) */
function generateChallenge(blueprintId: bigint, timestamp: bigint): Uint8Array {
  const input = new Uint8Array(16);
  const view = new DataView(input.buffer);
  view.setBigUint64(0, blueprintId, false); // big-endian
  view.setBigUint64(8, timestamp, false);
  return sha256(input);
}

/** Check if hash has `difficulty` leading zero bits */
function checkDifficulty(hash: Uint8Array, difficulty: number): boolean {
  const zeroBytes = Math.floor(difficulty / 8);
  const zeroBits = difficulty % 8;
  for (let i = 0; i < zeroBytes; i++) {
    if (hash[i] !== 0) return false;
  }
  if (zeroBits > 0) {
    const mask = 0xFF << (8 - zeroBits);
    if ((hash[zeroBytes] & mask) !== 0) return false;
  }
  return true;
}

/** Find nonce where SHA256(challenge || nonce_BE) has required leading zeros.
 *  Returns bincode-serialized Proof { hash: Vec<u8>, nonce: u64 }. */
async function solvePoW(blueprintId: bigint, timestamp: bigint): Promise<Uint8Array> {
  const challenge = generateChallenge(blueprintId, timestamp);
  const buf = new Uint8Array(challenge.length + 8);
  buf.set(challenge, 0);
  const view = new DataView(buf.buffer);

  for (let nonce = 0; nonce < 0x1_0000_0000; nonce++) {
    // calculate_hash uses nonce.to_be_bytes()
    view.setBigUint64(challenge.length, BigInt(nonce), false);
    const hash = sha256(buf);
    if (checkDifficulty(hash, POW_DIFFICULTY)) {
      // Bincode-serialize Proof { hash: Vec<u8>, nonce: u64 }
      // Vec<u8>: 8-byte LE length + data; u64: 8-byte LE
      const proof = new Uint8Array(8 + 32 + 8);
      const pv = new DataView(proof.buffer);
      pv.setBigUint64(0, 32n, true); // hash length (LE)
      proof.set(hash, 8);            // hash bytes
      pv.setBigUint64(40, BigInt(nonce), true); // nonce (LE)
      return proof;
    }
    // Yield to browser every 5000 iterations to keep UI responsive
    if (nonce % 5000 === 0 && nonce > 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error('PoW: exhausted nonce space');
}

// ── Convert proto QuoteDetails → on-chain struct ──────────────────────────

/**
 * Convert a USD cost rate to the on-chain totalCost value.
 * Must match the pricing engine's `decimal_to_scaled_amount()`:
 *   totalCost = costRate * 10^9
 * matching the pricing engine's EIP-712 quote signer.
 */
const PRICING_SCALE = 1_000_000_000; // 10^9

function costRateToScaledAmount(costRate: number): bigint {
  return BigInt(Math.floor(costRate * PRICING_SCALE));
}

function quoteConfidentiality(requireTee: boolean): number {
  return requireTee ? 1 : 0;
}

function resourceKindToId(kind: string): number {
  const mapped = RESOURCE_KIND_TO_ID[kind as keyof typeof RESOURCE_KIND_TO_ID];
  if (mapped === undefined) {
    throw new Error(`Unsupported resource kind in quote: ${kind}`);
  }
  return mapped;
}

function mapProtoAssetToken(details: QuoteDetails['securityCommitments'][number]): Address {
  if (details.asset?.assetType.case !== 'erc20') {
    return ZERO_ADDRESS;
  }

  return `0x${Array.from(details.asset.assetType.value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}` as Address;
}

function mapSecurityCommitment(
  commitment: QuoteDetails['securityCommitments'][number],
): SecurityCommitment {
  return {
    asset: {
      kind: commitment.asset?.assetType.case === 'erc20' ? 1 : 0,
      token: mapProtoAssetToken(commitment),
    },
    exposureBps: commitment.exposurePercent * 100,
  };
}

function mapResourceCommitment(
  resource: QuoteDetails['resources'][number],
): ResourceCommitment {
  return {
    kind: resourceKindToId(resource.kind),
    count: resource.count,
  };
}

function operatorIdToAddress(operatorId: Uint8Array): Address | null {
  if (operatorId.length !== 20) return null;
  const hex = Array.from(operatorId)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}` as Address;
}

function mapQuoteDetails(
  response: GetPriceResponse,
  details: QuoteDetails,
  operator: Address,
  signature: Uint8Array,
  requireTee: boolean,
  requester: Address,
): OperatorQuote {
  const totalCost = costRateToScaledAmount(details.totalCostRate);
  const securityCommitments = details.securityCommitments.map(mapSecurityCommitment);
  const resourceCommitments = details.resources.map(mapResourceCommitment);

  // The pricing engine returns 65-byte signatures (r || s || v)
  const sigHex = toHex(signature) as `0x${string}`;

  return {
    operator,
    totalCost,
    signature: sigHex,
    costRate: details.totalCostRate,
    teeAttested: response.teeAttested,
    teeProvider: response.teeProvider || undefined,
    details: {
      // tnt-core v0.13.0: bind quote to the caller. The pricing engine echoes
      // back the requester it signed; we take that source of truth when present
      // so the on-chain digest matches. Fallback to the caller's wallet — if
      // the operator returned a different address, on-chain verification fails
      // (which is the desired behaviour: don't accept quotes addressed to
      // someone else).
      requester:
        details.requester && details.requester.length === 20
          ? (`0x${Array.from(details.requester)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')}` as Address)
          : requester,
      blueprintId: details.blueprintId,
      ttlBlocks: details.ttlBlocks,
      totalCost,
      timestamp: details.timestamp,
      expiry: details.expiry,
      confidentiality: quoteConfidentiality(requireTee),
      securityCommitments,
      resourceCommitments,
    },
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useQuotes(
  operators: DiscoveredOperator[],
  blueprintId: bigint,
  ttlBlocks: bigint,
  enabled: boolean,
  pricingModel: PricingModelHint,
  requireTee = false,
  /**
   * tnt-core v0.13.0: address that will be `msg.sender` for
   * `createServiceFromQuotes`. Bound into the EIP-712 typed data so the
   * operator's signature commits to the consumer. When undefined we hold the
   * fetch — the on-chain verifier rejects `address(0)`.
   */
  requester?: Address,
): UseQuotesResult {
  const [quotes, setQuotes] = useState<OperatorQuote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Map<Address, QuoteFailure>>(new Map());
  const [fetchKey, setFetchKey] = useState(0);

  const refetch = useCallback(() => setFetchKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled || operators.length === 0 || !requester) {
      setQuotes([]);
      setErrors(new Map());
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setQuotes([]);
    setErrors(new Map());

    // Cache the resolved requester so the closure always sees the same address
    // even if the prop reference changes between renders.
    const resolvedRequester = requester;

    async function fetchQuotes() {
      const results: OperatorQuote[] = [];
      const errs = new Map<Address, QuoteFailure>();

      const promises = operators.map(async (op) => {
        try {
          if (!op.rpcAddress) throw new Error('No RPC address registered');

          const transport = createGrpcWebTransport({ baseUrl: resolveOperatorRpc(op.rpcAddress) });
          const client = createClient(PricingEngine, transport);

          // Solve PoW challenge
          const timestamp = BigInt(Math.floor(Date.now() / 1000));
          const proofOfWork = await solvePoW(blueprintId, timestamp);

          // Call GetPrice. tnt-core v0.13.0: the operator binds `requester`
          // into `quoteDetails.requester` (and the EIP-712 signature). Today's
          // pricing engine derives the requester from auth context — the
          // request schema does NOT carry it. We surface the operator-signed
          // value back through `mapQuoteDetails` so the on-chain tuple
          // matches the digest.
          const response = await client.getPrice({
            blueprintId,
            ttlBlocks,
            proofOfWork,
            challengeTimestamp: timestamp,
            pricingModel,
            requireTee,
            resourceRequirements: [...DEFAULT_RESOURCE_REQUIREMENTS],
            securityRequirements: {
              // Must be ERC20 — Custom assets rejected by Tangle EVM signer.
              // Use a zero address as placeholder (operator doesn't validate the token).
              asset: { assetType: { case: 'erc20', value: new Uint8Array(20) } },
              minimumExposurePercent: 10,
              maximumExposurePercent: 100,
            },
          });

          if (!response.quoteDetails) throw new Error('No quote details in response');

          const quote = mapQuoteDetails(
            response,
            response.quoteDetails,
            operatorIdToAddress(response.operatorId) ?? op.address,
            response.signature,
            requireTee,
            resolvedRequester,
          );
          if (!cancelled) results.push(quote);
        } catch (err) {
          if (!cancelled) {
            errs.set(op.address, classifyQuoteFailure(err));
          }
        }
      });

      await Promise.allSettled(promises);

      if (!cancelled) {
        setQuotes(results);
        setErrors(errs);
        setIsLoading(false);
      }
    }

    fetchQuotes();
    return () => { cancelled = true; };
  }, [operators, blueprintId, ttlBlocks, enabled, pricingModel, fetchKey, requireTee, requester]);

  const totalCost = quotes.reduce((sum, q) => sum + q.totalCost, 0n);

  return { quotes, isLoading, errors, totalCost, refetch };
}
