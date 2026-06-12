import { describe, expect, it, vi } from 'vitest';
import { getExplorerTxLink, isEvmTransactionHash } from './explorerLinks';

vi.mock('~/lib/contracts/chains', () => ({
  networks: {
    8453: {
      chain: {
        blockExplorers: {
          default: { name: 'BaseScan Configured', url: 'https://basescan.org/' },
        },
      },
    },
    999: {
      chain: {
        blockExplorers: {
          default: { name: 'HyperEVM', url: '' },
        },
      },
    },
  },
}));

const txHash = `0x${'a'.repeat(64)}`;

describe('explorerLinks', () => {
  it('recognizes only full EVM transaction hashes', () => {
    expect(isEvmTransactionHash(txHash)).toBe(true);
    expect(isEvmTransactionHash('0xpaper_abc')).toBe(false);
    expect(isEvmTransactionHash('hl:ok')).toBe(false);
    expect(isEvmTransactionHash('4J8mWm9xSolanaSignature')).toBe(false);
  });

  it('uses configured chain explorers before fallback explorers', () => {
    expect(getExplorerTxLink(8453, txHash)).toEqual({
      label: 'BaseScan Configured',
      url: `https://basescan.org/tx/${txHash}`,
    });
  });

  it('falls back for exposed EVM chains that are not configured locally', () => {
    expect(getExplorerTxLink(137, txHash)).toEqual({
      label: 'Polygonscan',
      url: `https://polygonscan.com/tx/${txHash}`,
    });
  });

  it('does not produce links for unknown chains or empty configured explorers', () => {
    expect(getExplorerTxLink(999, txHash)).toBeNull();
    expect(getExplorerTxLink(31337, txHash)).toBeNull();
    expect(getExplorerTxLink(undefined, txHash)).toBeNull();
  });
});
