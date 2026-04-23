import { beforeEach, describe, expect, it } from 'vitest';
import { clearTxs, txListStore } from '@tangle-network/blueprint-ui';
import type { Trade } from '~/lib/types/trade';
import { resolveAssetDisplay } from '~/lib/tradeTokenMetadata';
import { syncTradesIntoTxStore } from './txHistorySync';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const trade = {
    id: 'trade-1',
    botId: 'bot-1',
    botName: 'Bot 1',
    action: 'buy',
    tokenIn: 'WETH',
    tokenOut: 'USDC',
    amountIn: 1,
    amountOut: 2000,
    priceUsd: 2000,
    timestamp: Date.now(),
    status: 'executed',
    txHash: '0xabc123',
    paperTrade: false,
    targetProtocol: 'uniswap_v3',
    venue: 'dex',
    chainId: 31339,
    blockNumber: 12345,
    gasUsed: '21000',
    validatorScore: 90,
    validatorReasoning: 'looks good',
    ...overrides,
  };

  return {
    ...trade,
    assetIn: overrides.assetIn ?? resolveAssetDisplay(trade.rawTokenIn ?? trade.tokenIn),
    assetOut: overrides.assetOut ?? resolveAssetDisplay(trade.rawTokenOut ?? trade.tokenOut),
  } as Trade;
}

describe('syncTradesIntoTxStore', () => {
  beforeEach(() => {
    clearTxs();
  });

  it('adds confirmed executed trades to the shared tx store', () => {
    syncTradesIntoTxStore([makeTrade()], 31337);

    const [tx] = txListStore.get();
    expect(tx.hash).toBe('0xabc123');
    expect(tx.label).toBe('Buy WETH -> USDC');
    expect(tx.chainId).toBe(31339);
    expect(tx.status).toBe('confirmed');
    expect(tx.blockNumber).toBe(12345n);
    expect(tx.gasUsed).toBe(21000n);
  });

  it('skips trades without transaction hashes', () => {
    syncTradesIntoTxStore([makeTrade({ txHash: undefined })], 31337);
    expect(txListStore.get()).toEqual([]);
  });

  it('falls back to the provided chain id when the trade chain is missing', () => {
    syncTradesIntoTxStore([makeTrade({ chainId: undefined })], 31337);
    expect(txListStore.get()[0]?.chainId).toBe(31337);
  });
});
