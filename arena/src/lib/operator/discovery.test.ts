import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredOperator } from '@tangle-network/blueprint-ui';
import {
  DISCOVERY_TTL_MS,
  buildOperatorDirectory,
  fetchChainOperators,
  isMixedContentBlocked,
  type ChainOperatorEntry,
} from './discovery';

vi.mock('@tangle-network/blueprint-ui', () => ({
  discoverOperatorsWithClient: vi.fn(),
  getAddresses: () => ({ services: '0xservices' }),
  publicClient: {},
  resolveOperatorRpc: (raw: string) => (raw.includes('://') ? raw : `http://${raw}`),
}));

function chainEntry(overrides: Partial<ChainOperatorEntry> = {}): ChainOperatorEntry {
  return {
    address: '0x5Af6000000000000000000000000000000000001',
    rpcAddress: 'https://operator-a.example',
    apiUrl: 'https://operator-a.example',
    blueprintIds: [13],
    ...overrides,
  };
}

function operator(address: string, rpcAddress: string): DiscoveredOperator {
  return { address: address as DiscoveredOperator['address'], ecdsaPublicKey: '0x', rpcAddress };
}

function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('isMixedContentBlocked', () => {
  it('blocks absolute http endpoints on https pages', () => {
    expect(isMixedContentBlocked('http://178.104.232.124:9210', 'https:')).toBe(true);
  });

  it('allows https endpoints and relative URLs on https pages', () => {
    expect(isMixedContentBlocked('https://178.104.232.124.sslip.io', 'https:')).toBe(false);
    expect(isMixedContentBlocked('/operator-api', 'https:')).toBe(false);
  });

  it('allows http endpoints on http pages (local dev)', () => {
    expect(isMixedContentBlocked('http://localhost:9200', 'http:')).toBe(false);
  });
});

describe('buildOperatorDirectory', () => {
  it('merges discovered operators over the env seed, env-first', () => {
    const directory = buildOperatorDirectory({
      chainOperators: [
        chainEntry({ apiUrl: 'https://operator-a.example' }),
        chainEntry({
          address: '0xEF69000000000000000000000000000000000002',
          rpcAddress: 'https://operator-b.example',
          apiUrl: 'https://operator-b.example',
          blueprintIds: [14],
        }),
      ],
      envUrls: ['https://env-operator.example'],
      pageProtocol: 'https:',
    });

    expect(directory.apiUrls).toEqual([
      'https://env-operator.example',
      'https://operator-a.example',
      'https://operator-b.example',
    ]);
  });

  it('falls back to the env seed when discovery returns nothing', () => {
    const directory = buildOperatorDirectory({
      chainOperators: [],
      envUrls: ['https://env-operator.example', 'https://env-operator.example/'],
      pageProtocol: 'https:',
    });

    expect(directory.apiUrls).toEqual(['https://env-operator.example']);
    expect(directory.endpoints).toHaveLength(1);
    expect(directory.endpoints[0]?.sources).toEqual(['env']);
  });

  it('merges a chain registration onto an env endpoint with the same URL', () => {
    const directory = buildOperatorDirectory({
      chainOperators: [chainEntry({ apiUrl: 'https://operator-a.example/' })],
      envUrls: ['https://operator-a.example'],
      pageProtocol: 'https:',
    });

    expect(directory.endpoints).toHaveLength(1);
    expect(directory.endpoints[0]?.sources).toEqual(['env', 'chain']);
    expect(directory.endpoints[0]?.address).toBe('0x5Af6000000000000000000000000000000000001');
    expect(directory.apiUrls).toEqual(['https://operator-a.example']);
  });

  it('filters http endpoints from apiUrls on https pages but surfaces them as unreachable', () => {
    const directory = buildOperatorDirectory({
      chainOperators: [
        chainEntry(),
        chainEntry({
          address: '0xEF69000000000000000000000000000000000002',
          rpcAddress: 'http://178.104.232.124:9210',
          apiUrl: 'http://178.104.232.124:9210',
        }),
      ],
      envUrls: [],
      pageProtocol: 'https:',
    });

    expect(directory.apiUrls).toEqual(['https://operator-a.example']);
    const blocked = directory.endpoints.find((endpoint) => endpoint.apiUrl === 'http://178.104.232.124:9210');
    expect(blocked?.browserReachable).toBe(false);
    expect(blocked?.unreachableReason).toBe('mixed-content');
  });

  it('keeps http endpoints reachable on http pages', () => {
    const directory = buildOperatorDirectory({
      chainOperators: [chainEntry({ apiUrl: 'http://localhost:9200', rpcAddress: 'http://localhost:9200' })],
      envUrls: [],
      pageProtocol: 'http:',
    });

    expect(directory.apiUrls).toEqual(['http://localhost:9200']);
  });
});

describe('fetchChainOperators', () => {
  it('tolerates a dead blueprint and keeps operators from the others', async () => {
    const discover = vi.fn(async (blueprintId: bigint) => {
      if (blueprintId === 14n) throw new Error('rpc down');
      return {
        operators: [operator(`0x${blueprintId.toString().padStart(40, '0')}`, `https://op-${blueprintId}.example`)],
      };
    });

    const entries = await fetchChainOperators({
      blueprintIds: [13n, 14n, 15n],
      discover,
      storage: null,
    });

    expect(discover).toHaveBeenCalledTimes(3);
    expect(entries.map((entry) => entry.apiUrl).sort()).toEqual([
      'https://op-13.example',
      'https://op-15.example',
    ]);
  });

  it('resolves to an empty list when every blueprint walk fails (env fallback)', async () => {
    const entries = await fetchChainOperators({
      blueprintIds: [13n, 14n],
      discover: async () => {
        throw new Error('chain unavailable');
      },
      storage: null,
    });

    expect(entries).toEqual([]);
    expect(buildOperatorDirectory({
      chainOperators: entries,
      envUrls: ['https://env-operator.example'],
      pageProtocol: 'https:',
    }).apiUrls).toEqual(['https://env-operator.example']);
  });

  it('dedupes an operator registered on multiple blueprints by address', async () => {
    const discover = vi.fn(async () => ({
      operators: [operator('0x5Af6000000000000000000000000000000000001', 'https://operator-a.example')],
    }));

    const entries = await fetchChainOperators({
      blueprintIds: [13n, 14n],
      discover,
      storage: null,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.blueprintIds).toEqual([13, 14]);
  });

  it('caches results for the TTL and re-walks the chain after expiry', async () => {
    const storage = memStorage();
    const discover = vi.fn(async () => ({
      operators: [operator('0x5Af6000000000000000000000000000000000001', 'https://operator-a.example')],
    }));
    let nowMs = 1_000_000;

    const first = await fetchChainOperators({ blueprintIds: [13n], discover, storage, now: () => nowMs });
    expect(discover).toHaveBeenCalledTimes(1);

    nowMs += DISCOVERY_TTL_MS - 1;
    const second = await fetchChainOperators({ blueprintIds: [13n], discover, storage, now: () => nowMs });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    nowMs += DISCOVERY_TTL_MS;
    await fetchChainOperators({ blueprintIds: [13n], discover, storage, now: () => nowMs });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('does not cache a fully failed walk', async () => {
    const storage = memStorage();
    const discover = vi.fn(async () => {
      throw new Error('chain unavailable');
    });

    await fetchChainOperators({ blueprintIds: [13n], discover, storage, now: () => 1_000 });
    await fetchChainOperators({ blueprintIds: [13n], discover, storage, now: () => 1_001 });
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
